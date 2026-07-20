"""Audio CD reading: TOC parsing and on-the-fly track streaming via cdparanoia.

No ripping to disk — tracks are read from the drive and piped straight out as WAV.
"""

from __future__ import annotations

import asyncio
import fcntl
import logging
import os
import re
import struct
import subprocess

_LOGGER = logging.getLogger(__name__)

DEVICE = os.environ.get("CD_DEVICE", "/dev/sr0")

# CD audio is always 44100 Hz, 16 bit, stereo -> 2352 bytes per sector
SECTOR_BYTES = 2352
SAMPLE_RATE = 44100
CHANNELS = 2
BITS = 16

CDROM_DISC_STATUS = 0x5326
CDROM_MEDIA_CHANGED = 0x5325
_DISC_STATUS = {
    0: "no_info", 1: "no_disc", 2: "tray_open", 3: "drive_not_ready", 4: "disc_ok",
    100: "audio", 101: "data", 102: "data", 103: "data", 104: "data", 105: "mixed",
}
# This drive answers CDS_DISC_OK (4) for audio discs instead of CDS_AUDIO (100),
# so presence is all the ioctl is trusted for — the TOC decides if it is audio.
_ABSENT = {"no_disc", "tray_open", "no_drive"}
# A busy or spun-down drive answers these; they mean "cannot tell right now",
# not "no disc" — treating them as absence would drop the disc mid-playback.
_UNKNOWN = {"drive_not_ready", "no_info", "unknown"}

# "  1.     5218 [01:09.43]        0 [00:00.00]    OK   no  2"
_TOC_LINE = re.compile(r"^\s*(\d+)\.\s+(\d+)\s+\[[\d:.]+\]\s+(\d+)\s+\[")

# Only one process may read the drive at a time
_lock = asyncio.Lock()
_current: subprocess.Popen | None = None


def disc_status() -> str:
    """Cheap ioctl check — does not spin up the drive the way cdparanoia does."""
    try:
        fd = os.open(DEVICE, os.O_RDONLY | os.O_NONBLOCK)
    except OSError as e:
        _LOGGER.warning("cannot open %s: %s", DEVICE, e)
        return "no_drive"
    try:
        return _DISC_STATUS.get(fcntl.ioctl(fd, CDROM_DISC_STATUS), "unknown")
    except OSError:
        return "no_disc"
    finally:
        os.close(fd)


def media_changed() -> bool:
    """True once after the disc is swapped — the kernel clears the flag on read.

    Only one caller may poll this or they steal each other's notification.
    """
    try:
        fd = os.open(DEVICE, os.O_RDONLY | os.O_NONBLOCK)
    except OSError:
        return False
    try:
        return bool(fcntl.ioctl(fd, CDROM_MEDIA_CHANGED, 0))
    except OSError:
        return False
    finally:
        os.close(fd)


def disc_state() -> str:
    """'present' | 'absent' | 'unknown' — three states on purpose, see _UNKNOWN."""
    status = disc_status()
    if status in _ABSENT:
        return "absent"
    if status in _UNKNOWN:
        return "unknown"
    return "present"


def read_toc() -> list[dict]:
    """Track list with sector counts. Blocking (~1s, spins the drive) — call in a thread."""
    proc = subprocess.run(
        ["cdparanoia", "-d", DEVICE, "-Q"],
        capture_output=True, text=True, timeout=60,
    )
    tracks = []
    for line in proc.stderr.splitlines():
        m = _TOC_LINE.match(line)
        if m:
            number, sectors, begin = int(m.group(1)), int(m.group(2)), int(m.group(3))
            tracks.append({
                "number": number,
                "sectors": sectors,
                "begin": begin,
                "seconds": round(sectors / 75, 1),
            })
    if not tracks:
        _LOGGER.warning("no tracks parsed from cdparanoia -Q: %s", proc.stderr[-300:])
    return tracks


def wav_header(sectors: int) -> bytes:
    """44-byte WAV header with exact sizes — we know the track length from the TOC.

    cdparanoia writes its own header, but piped to stdout it cannot seek back to
    fix the sizes, so we emit raw audio (-r) and build the header ourselves.
    """
    data_size = sectors * SECTOR_BYTES
    byte_rate = SAMPLE_RATE * CHANNELS * BITS // 8
    return b"RIFF" + struct.pack("<I", 36 + data_size) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, CHANNELS, SAMPLE_RATE, byte_rate, CHANNELS * BITS // 8, BITS
    ) + b"data" + struct.pack("<I", data_size)


def wav_size(sectors: int) -> int:
    return 44 + sectors * SECTOR_BYTES


async def stop_reading() -> None:
    """Terminate any in-flight read so the drive is free for the next request."""
    global _current
    proc, _current = _current, None
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            await asyncio.to_thread(proc.wait, 5)
        except subprocess.TimeoutExpired:
            proc.kill()


async def stream_track(number: int, sectors: int):
    """Yield WAV bytes for one track, read from the disc as they are consumed.

    -Z disables paranoia's verification passes: it takes the drive from ~1.5x to
    ~4.4x realtime, which is what makes live playback possible on this hardware.
    """
    global _current
    await stop_reading()
    async with _lock:
        proc = subprocess.Popen(
            ["cdparanoia", "-d", DEVICE, "-Z", "-q", "-r", f"{number}-{number}", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        _current = proc
        try:
            yield wav_header(sectors)
            while True:
                chunk = await asyncio.to_thread(proc.stdout.read, SECTOR_BYTES * 16)
                if not chunk:
                    break
                yield chunk
        finally:
            if proc.poll() is None:
                proc.terminate()
            proc.stdout.close()
            if _current is proc:
                _current = None


def eject() -> None:
    subprocess.run(["eject", DEVICE], capture_output=True, timeout=30)
