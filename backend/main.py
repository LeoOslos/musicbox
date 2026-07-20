import asyncio
import logging
import os
import socket
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import cdrom, discs, gnudb
from .inventory import discover_wiim_ip
from .wiim_player import WiimManager
from .ws_manager import WSManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
_LOGGER = logging.getLogger("cd")

wiim = WiimManager()
ws_mgr = WSManager()


def _broadcast() -> None:
    # cd_* ride along so the UI follows track changes and disc swaps on its own
    ws_mgr.broadcast(wiim.get_state() | {"cd_track": _cd_current, "cd_disc": _cd_disc})


@asynccontextmanager
async def lifespan(app: FastAPI):
    wiim.add_callback(_broadcast)
    # Auto-connect from inventory on startup
    ip = discover_wiim_ip()
    if ip:
        await wiim.setup(ip)
    cd_task = asyncio.create_task(_cd_watcher(), name="cd-watcher")
    yield
    cd_task.cancel()
    await cdrom.stop_reading()
    await wiim.teardown()


app = FastAPI(title="WiiM Dashboard", lifespan=lifespan)


# --- WebSocket ---

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws_mgr.handle(ws, wiim.get_state)


# --- Discovery ---

@app.get("/api/discover")
async def discover():
    ip = discover_wiim_ip()
    if not ip:
        raise HTTPException(status_code=404, detail="WiiM not found in inventory or ARP table")
    return {"ip": ip}


# --- Config ---

@app.post("/api/config")
async def set_config(body: dict):
    ip = body.get("ip", "").strip()
    if not ip:
        raise HTTPException(status_code=400, detail="IP required")
    await wiim.setup(ip)
    return {"ok": True, "ip": ip}


@app.get("/api/config")
async def get_config():
    return {"ip": wiim.ip, "configured": bool(wiim.ip)}


# --- Playback ---

def _player():
    if not wiim.player:
        raise HTTPException(status_code=503, detail="WiiM not configured")
    return wiim.player


@app.post("/api/toggle")
async def toggle():
    await _player().media_play_pause()


@app.post("/api/transport")
async def transport():
    """Play/pause that still does something from a standing stop.

    Both pywiim and the UPnP events call a stopped device 'pause', but the two
    are not the same: a pause has a stream to resume and a stop does not, so
    play/pause on a stopped device did nothing at all. The device's own HTTP
    status is the one place they can be told apart, so ask it directly.
    """
    player = _player()
    try:
        raw = str((await player.client.get_player_status()).get("play_status", ""))
    except Exception as exc:
        _LOGGER.warning("could not read raw device status: %s", exc)
        raw = ""

    if raw == "play":
        await player.pause()
        return {"action": "pause"}
    if raw in ("pause", "load"):
        # play() re-loads the URL and restarts the track from zero; the
        # play/pause toggle is what actually un-pauses.
        await player.media_play_pause()
        return {"action": "resume"}

    # Stopped: nothing to resume, so put the disc on if there is one.
    present = await asyncio.to_thread(cdrom.disc_state) == "present"
    tracks = await _toc() if present else []
    if tracks:
        started = _cd_current or tracks[0]["number"]
        await _cd_play(started)
        return {"action": "cd_start", "track": started}
    await player.play()
    return {"action": "play"}

@app.post("/api/play")
async def play():
    await _player().play()

@app.post("/api/pause")
async def pause():
    await _player().pause()

@app.post("/api/stop")
async def stop():
    await _player().stop()

@app.post("/api/prev")
async def prev():
    await _player().previous_track()

@app.post("/api/next")
async def next_track():
    await _player().next_track()

@app.post("/api/seek/{seconds}")
async def seek(seconds: int):
    await _player().seek(seconds)


# --- Volume ---

@app.post("/api/volume/{level}")
async def set_volume(level: int):
    if not 0 <= level <= 100:
        raise HTTPException(status_code=400, detail="Volume must be 0-100")
    await _player().set_volume(level / 100.0)

@app.post("/api/mute/{state}")
async def set_mute(state: int):
    if state not in (0, 1):
        raise HTTPException(status_code=400, detail="State must be 0 or 1")
    await _player().set_mute(bool(state))


# --- Source ---

@app.post("/api/source/{name}")
async def set_source(name: str):
    try:
        await _player().set_source(name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# --- EQ ---

@app.get("/api/eq/list")
async def get_eq_list():
    return _player().eq_presets

@app.post("/api/eq/preset/{preset}")
async def set_eq_preset(preset: str):
    if preset.lower() == "off":
        await _player().set_eq_enabled(False)
    else:
        await _player().set_eq_preset(preset)

@app.get("/api/eq/bands")
async def get_eq_bands():
    data = await _player().get_eq()
    bands_raw = data.get("EQBand", [])
    if isinstance(bands_raw, list) and bands_raw:
        sorted_bands = sorted(bands_raw, key=lambda b: b.get("index", 0))
        values = [max(0, min(99, int(b.get("value", 50)))) for b in sorted_bands]
    else:
        values = [50] * 10
    while len(values) < 10:
        values.append(50)
    return {"bands": values[:10], "enabled": str(data.get("EQStat", "")).lower() == "on"}

@app.post("/api/eq/bands")
async def set_eq_bands(body: dict):
    bands = body.get("bands", [])
    if len(bands) != 10:
        raise HTTPException(status_code=400, detail="Need exactly 10 band values")
    values = [max(0, min(99, int(v))) for v in bands]
    await _player().set_eq_enabled(True)
    await _player().set_eq_custom(values)
    return {"ok": True}


# --- Audio CD ---

_toc_cache: list[dict] = []
_cd_current: int | None = None  # track being played from the disc, for prev/next
_cd_disc = 0                    # bumped on every disc swap, tells the UI to reload
_cd_autoplay_until: float | None = None  # deadline for starting a freshly loaded disc
_disc_info: dict | None = None           # album and track names for the disc in the tray
_disc_looked_up = False                  # the online lookup is tried once per disc

# Port the WiiM must reach us on — the dashboard's own port (see ecosystem.config.js)
HTTP_PORT = int(os.environ.get("PORT", "8080"))

CD_WATCH_INTERVAL = 2    # seconds between end-of-track checks while a CD plays
CD_END_SLACK = 3         # seconds from the end that still count as "finished"
CD_ADVANCE_SETTLE = 8    # seconds to ignore state while the next track loads

# The device reports the streamed URL as the track title, which is how we tell
# our own disc audio apart from Spotify, AirPlay or anything else taking over.
CD_URL_MARK = "/api/cd/track/"

# How long to keep trying to start a disc after the tray closes. The drive needs
# a few seconds to be readable, and gives up rather than starting music late.
CD_AUTOPLAY_WINDOW = 40


def _local_ip() -> str:
    """Our address on the interface that reaches the WiiM — the URL it must fetch."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((wiim.ip or "192.168.1.1", 80))
        return s.getsockname()[0]
    finally:
        s.close()


async def _toc(refresh: bool = False) -> list[dict]:
    global _toc_cache
    if refresh or not _toc_cache:
        _toc_cache = await asyncio.to_thread(cdrom.read_toc)
    return _toc_cache


def _identify(tracks: list[dict]) -> dict | None:
    """Names we already have. Never waits on the network.

    Naming is decoration; playing the disc is the job. The online lookup runs as
    a background task and the names appear when they appear — a slow or
    unreachable MusicBrainz must not hold up the track list or the controls.
    """
    global _disc_info, _disc_looked_up
    if _disc_info is not None or not tracks:
        return _disc_info
    _disc_info = discs.saved(discs.disc_id(tracks))
    if _disc_info is None and not _disc_looked_up:
        _disc_looked_up = True
        asyncio.create_task(_lookup_online(list(tracks)), name="disc-lookup")
    return _disc_info


async def _lookup_online(tracks: list[dict]) -> None:
    """Background half of _identify: ask the databases, tell the UI if it lands.

    MusicBrainz first — its data is cleaner — and GnuDB second, which is where
    the local pressings actually are. Neither is allowed to guess: each only
    answers here when it has a single unambiguous match.
    """
    global _disc_info
    try:
        discid = discs.disc_id(tracks)
        entry = await discs.lookup_exact(discid, len(tracks))
        if not entry:
            _LOGGER.info("disc not in MusicBrainz — asking GnuDB")
            entry = await gnudb.lookup_exact(tracks)
    except Exception as exc:
        _LOGGER.warning("disc lookup failed: %s", exc)
        return
    if not entry:
        _LOGGER.info("disc not identified automatically — needs picking by hand")
        return
    discs.remember(discid, entry)
    _disc_info = entry
    _LOGGER.info("disc identified as %s (%s)", entry.get("album"), entry.get("source"))
    _broadcast()


def _named(tracks: list[dict], info: dict | None) -> list[dict]:
    titles = (info or {}).get("tracks") or {}
    return [t | {"title": titles.get(str(t["number"]))} for t in tracks]


def _track(tracks: list[dict], number: int) -> dict:
    for t in tracks:
        if t["number"] == number:
            return t
    raise HTTPException(status_code=404, detail=f"Track {number} not on disc")


@app.get("/api/cd/status")
async def cd_status():
    global _cd_current
    state = await asyncio.to_thread(cdrom.disc_state)
    if state == "absent":
        if _cd_current is not None:
            _LOGGER.info("disc gone, clearing CD state (was track %s)", _cd_current)
        _toc_cache.clear()
        _cd_current = None
        return {"status": "no_disc", "tracks": 0, "current": None, "disc": _cd_disc}
    # 'unknown' (drive busy or asleep): keep whatever we already know
    tracks = _toc_cache if state == "unknown" else await _toc()
    info = _identify(tracks)
    return {
        "status": "audio" if tracks else "data",
        "tracks": len(tracks),
        "current": _cd_current,
        "disc": _cd_disc,
        "album": (info or {}).get("album"),
        "artist": (info or {}).get("artist"),
        "identified": bool(info),
    }


@app.get("/api/cd/tracks")
async def cd_tracks(refresh: bool = False):
    if await asyncio.to_thread(cdrom.disc_state) == "absent":
        raise HTTPException(status_code=404, detail="No disc in the drive")
    tracks = await _toc(refresh)
    if not tracks:
        raise HTTPException(status_code=404, detail="Disc has no audio tracks")
    return _named(tracks, _identify(tracks))


@app.get("/api/cd/candidates")
async def cd_candidates():
    """Albums whose shape matches this disc, for the user to choose between.

    Both databases are asked: MusicBrainz matches on its own disc ID, GnuDB on
    the raw offsets, and they miss different discs. GnuDB goes second because
    its data is dirtier, not because it matches worse.
    """
    tracks = await _toc()
    if not tracks:
        raise HTTPException(status_code=404, detail="No audio CD in the drive")
    found = await discs.lookup_candidates(tracks)
    try:
        found += await gnudb.candidates(tracks)
    except Exception as exc:
        _LOGGER.warning("GnuDB candidates failed: %s", exc)
    return found


@app.get("/api/cd/search")
async def cd_search(q: str):
    """Find the album by name, for discs the TOC search cannot see."""
    if not q.strip():
        raise HTTPException(status_code=400, detail="Nothing to search for")
    tracks = await _toc()
    return await discs.search_by_name(q.strip(), len(tracks))


@app.post("/api/cd/forget")
async def cd_forget():
    """Undo an identification, back to plain track numbers."""
    global _disc_info, _disc_looked_up
    tracks = await _toc()
    if not tracks:
        raise HTTPException(status_code=404, detail="No audio CD in the drive")
    discs.forget(discs.disc_id(tracks))
    _disc_info = None
    # Don't look it up again for this disc: it was just rejected by hand.
    _disc_looked_up = True
    _broadcast()
    return {"ok": True, "identified": False}


@app.post("/api/cd/identify/{release_id}")
async def cd_identify(release_id: str):
    """Pin this disc to a chosen album, and remember it for next time."""
    global _disc_info
    tracks = await _toc()
    if not tracks:
        raise HTTPException(status_code=404, detail="No audio CD in the drive")
    gnu = gnudb.parse_release_id(release_id)
    if gnu:
        entry = await gnudb.read_entry(gnu[0], gnu[1], len(tracks))
    else:
        entry = await discs.lookup_release(release_id, len(tracks))
    if not entry or not entry.get("tracks"):
        raise HTTPException(status_code=404, detail="No track list for that album")
    discs.remember(discs.disc_id(tracks), entry)
    _disc_info = entry
    _broadcast()
    return entry


@app.get("/api/cd/track/{number}.wav")
async def cd_track_audio(number: int, request: Request):
    """Serve a track as WAV, honouring Range so the player can seek.

    Without Range the device cannot jump within a track: dragging the progress
    bar made it re-request the file and playback stalled. Every byte maps to a
    known sector, so a range turns straight into a drive position.
    """
    track = _track(await _toc(), number)
    total = cdrom.wav_size(track["sectors"])
    start, end = 0, total - 1

    header = request.headers.get("range", "")
    ranged = header.startswith("bytes=")
    if ranged:
        first, _, last = header[len("bytes="):].split(",")[0].strip().partition("-")
        try:
            start = int(first) if first else 0
            if last:
                end = min(int(last), total - 1)
        except ValueError:
            start, end = 0, total - 1
        if start > end or start >= total:
            raise HTTPException(status_code=416, detail="Range beyond end of track")

    length = end - start + 1
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(length)}
    if ranged:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"

    return StreamingResponse(
        cdrom.stream_track(number, track["sectors"], start, length),
        media_type="audio/wav",
        headers=headers,
        status_code=206 if ranged else 200,
    )


async def _cd_play(number: int) -> dict:
    global _cd_current
    _track(await _toc(), number)
    url = f"http://{_local_ip()}:{HTTP_PORT}/api/cd/track/{number}.wav"
    await _player().play_url(url)
    _cd_current = number
    return {"ok": True, "track": number, "url": url}


@app.post("/api/cd/play/{number}")
async def cd_play(number: int):
    return await _cd_play(number)


@app.post("/api/cd/next")
async def cd_next():
    # Re-read rather than trust an empty cache: stopping because the TOC went
    # missing would look exactly like reaching the end of the disc.
    tracks = await _toc(refresh=not _toc_cache)
    numbers = [t["number"] for t in tracks]
    after = [n for n in numbers if _cd_current is None or n > _cd_current]
    if not after:
        return await cd_stop()
    return await _cd_play(after[0])


@app.post("/api/cd/prev")
async def cd_prev():
    tracks = await _toc()
    numbers = [t["number"] for t in tracks]
    before = [n for n in numbers if _cd_current is not None and n < _cd_current]
    # No previous track: restart the current one, like a CD player does
    return await _cd_play(before[-1] if before else (_cd_current or numbers[0]))


@app.post("/api/cd/stop")
async def cd_stop():
    global _cd_current
    await _player().stop()
    await cdrom.stop_reading()
    _cd_current = None
    return {"ok": True, "track": None}


async def _stop_for_disc_release(reason: str) -> None:
    """Stop playback whenever the disc goes away, by button or by hand.

    The device buffers minutes ahead of what the drive has read, so without
    this it happily keeps playing a disc that is already out of the tray.
    Both eject paths go through here: when they each did their own thing, the
    dashboard button silently skipped the stop.
    """
    if _cd_current is None or not wiim.player:
        return
    _LOGGER.info("%s while playing track %s, stopping", reason, _cd_current)
    try:
        await wiim.player.stop()
    except Exception as exc:
        _LOGGER.warning("could not stop playback on disc release: %s", exc)


async def _try_autoplay() -> None:
    """Start a disc that was just loaded, but only into a silent speaker.

    Anything already playing wins: putting a disc in should never cut off music
    someone chose. The drive is not readable the instant the tray closes, so
    this is retried for CD_AUTOPLAY_WINDOW seconds and then dropped.
    """
    global _cd_autoplay_until
    if time.monotonic() > _cd_autoplay_until:
        _LOGGER.info("gave up on auto-starting the disc")
        _cd_autoplay_until = None
        return
    if await asyncio.to_thread(cdrom.disc_state) != "present" or not wiim.player:
        return
    tracks = await _toc()
    if not tracks:
        return
    await wiim.player.refresh()
    if wiim.get_state().get("is_playing"):
        _LOGGER.info("disc loaded while something else plays — leaving it alone")
        _cd_autoplay_until = None
        return
    _cd_autoplay_until = None
    _LOGGER.info("disc loaded and speaker idle, starting track %s", tracks[0]["number"])
    await _cd_play(tracks[0]["number"])
    _broadcast()


async def _cd_watcher() -> None:
    """Advance to the next track when the current one runs out.

    Measured on the device: a finished stream ends up not playing with position
    at duration (58/58 on a 58s track). pywiim reports play_state 'pause' there,
    the same value as a real pause — so the position, not the state name, is
    what tells the two apart. A pause in the last CD_END_SLACK seconds of a
    track will advance; that is the accepted cost of the ambiguity.
    """
    global _cd_current, _cd_disc, _cd_autoplay_until, _disc_info, _disc_looked_up
    # The kernel always reports "media changed" on the first read, so consume it
    # here: on startup that is not a disc someone just put in, and acting on it
    # would start playing music every time the service restarts.
    await asyncio.to_thread(cdrom.media_changed)

    while True:
        await asyncio.sleep(CD_WATCH_INTERVAL)
        try:
            if await asyncio.to_thread(cdrom.media_changed):
                _LOGGER.info("disc swapped, dropping cached TOC")
                await _stop_for_disc_release("disc pulled")
                await cdrom.stop_reading()
                _toc_cache.clear()
                _disc_info = None
                _disc_looked_up = False
                _cd_current = None
                _cd_disc += 1
                _cd_autoplay_until = time.monotonic() + CD_AUTOPLAY_WINDOW
                _broadcast()
            if _cd_autoplay_until is not None:
                await _try_autoplay()
        except Exception as exc:
            _LOGGER.warning("media change check failed: %s", exc)
        if _cd_current is None or not wiim.player:
            continue
        try:
            raw = str((await wiim.player.client.get_player_status()).get("play_status", ""))
            await wiim.player.refresh()
            s = wiim.get_state()
            playing_ours = CD_URL_MARK in (s.get("title") or "")

            # Something else (Spotify, AirPlay, radio) grabbed the speaker: let
            # go of the disc, or we would shove the next track over their music
            # as soon as one of their tracks ended.
            if s.get("is_playing") and not playing_ours:
                _LOGGER.info("another source took over, releasing the CD")
                await cdrom.stop_reading()
                _cd_current = None
                _broadcast()
                continue

            # Only a real 'stop' is interesting. A pause keeps the reader alive
            # so resuming picks up where it left off. Note the raw status is the
            # one that separates the two — pywiim calls both of them 'pause'.
            if raw != "stop":
                continue

            duration = s.get("duration") or 0
            position = s.get("position") or 0
            if playing_ours and duration > 0 and position >= duration - CD_END_SLACK:
                _LOGGER.info("track %s finished (%s/%s), advancing", _cd_current, position, duration)
                await cd_next()
                # The device reports the old stopped state for a moment while
                # the next track loads — not another track ending.
                await asyncio.sleep(CD_ADVANCE_SETTLE)
                continue

            # Stopped somewhere else (the WiiM app, a remote): drop the disc,
            # otherwise the drive keeps reading a track nobody is listening to.
            _LOGGER.info("stopped outside the dashboard, releasing the CD")
            await cdrom.stop_reading()
            _cd_current = None
            _broadcast()
        except Exception as exc:
            _LOGGER.warning("CD watcher error: %s", exc)


@app.post("/api/cd/eject")
async def cd_eject():
    global _cd_current
    await _stop_for_disc_release("ejected from the dashboard")
    await cdrom.stop_reading()
    await asyncio.to_thread(cdrom.eject)
    _toc_cache.clear()
    _cd_current = None
    return {"ok": True, "track": None}


# --- Artwork ---

@app.get("/api/artwork")
async def get_artwork():
    result = await wiim.fetch_artwork()
    if not result:
        raise HTTPException(status_code=404, detail="No artwork")
    data, content_type = result
    return Response(content=data, media_type=content_type)


# --- Frontend ---

app.mount("/static", StaticFiles(directory="frontend/static"), name="static")

@app.get("/")
async def index():
    return FileResponse("frontend/index.html")
