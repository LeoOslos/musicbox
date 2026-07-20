"""GnuDB (CDDB) lookup: the second source of track names.

MusicBrainz only knows pressings someone registered as a physical disc, so the
local editions on the shelf here are routinely invisible to it — Carmine Meo is
in MusicBrainz eight times over and not one of them is the fourteen track
edition sold here. GnuDB has it, matched exactly by disc ID.

The trade is data quality: entries are whatever a person typed years ago, and
accented characters often arrived already broken *at the source* (not a client
encoding bug — the stored bytes are U+FFFD), so the text is cleaned on the way
in and what cannot be recovered is dropped.
"""

from __future__ import annotations

import asyncio
import logging
import time
from urllib.parse import quote

import httpx

_LOGGER = logging.getLogger("gnudb")

# HTTP only: the same path over HTTPS answers 404. freedb.org has been dead
# since 2020 and its old hostnames do not resolve to anything useful.
GNUDB = "http://gnudb.gnudb.org/~cddb/cddb.cgi"
HELLO = "hello=musicbox+localhost+musicbox+1.3&proto=6"

FRAMES_PER_SECOND = 75
MIN_INTERVAL = 1.1  # be a polite client, same as with MusicBrainz

_lock = asyncio.Lock()
_last_call = 0.0


def _digit_sum(n: int) -> int:
    total = 0
    while n > 0:
        total += n % 10
        n //= 10
    return total


def _offsets(tracks: list[dict]) -> list[int]:
    """Track start offsets in frames, as CDDB counts them (lead-in included)."""
    return [t["begin"] + 150 for t in tracks]


def _leadout(tracks: list[dict]) -> int:
    return tracks[-1]["begin"] + tracks[-1]["sectors"] + 150


def disc_id(tracks: list[dict]) -> str:
    """The freedb/CDDB disc ID: checksum, playing length and track count."""
    offsets = _offsets(tracks)
    checksum = sum(_digit_sum(o // FRAMES_PER_SECOND) for o in offsets)
    elapsed = _leadout(tracks) // FRAMES_PER_SECOND - offsets[0] // FRAMES_PER_SECOND
    value = ((checksum % 0xFF) << 24) | (elapsed << 8) | len(tracks)
    return "%08x" % value


def _query_string(tracks: list[dict]) -> str:
    parts = [disc_id(tracks), str(len(tracks))]
    parts += [str(o) for o in _offsets(tracks)]
    parts.append(str(_leadout(tracks) // FRAMES_PER_SECOND))
    return "+".join(parts)


# What a lost character looks like in these entries: U+FFFD itself, and the
# far more common 'ï¿½', which is U+FFFD's own UTF-8 bytes read back as latin-1
# and stored that way. Verified byte by byte against the server (c3af c2bf c2bd),
# and proto=5 returns the same, so the damage is in the database, not in transit.
_BROKEN = ("�", "ï¿½", "â€™")


def clean(text: str) -> str:
    """Drop the mangled characters GnuDB entries are peppered with.

    'Riprendo mai più' is stored as 'Reprendo mai piï¿½' — misspelled *and*
    corrupted at the source, so there is nothing to decode back. Dropping the
    debris keeps the rest of the title readable instead of showing diamonds.
    """
    for bad in _BROKEN:
        text = text.replace(bad, "")
    return " ".join(text.split())


async def _call(command: str) -> str | None:
    """One rate-limited CDDB call. Returns the raw body, or None if unreachable.

    The command is spelled with '+' for spaces by the protocol itself, so the
    query string is built by hand rather than handed to a URL encoder.
    """
    global _last_call
    url = f"{GNUDB}?cmd={command}&{HELLO}"
    async with _lock:
        wait = MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_call = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=25, follow_redirects=True) as client:
                r = await client.get(url)
        except httpx.HTTPError as exc:
            _LOGGER.warning("GnuDB unreachable: %s", exc)
            return None
    if r.status_code != 200:
        _LOGGER.warning("GnuDB answered HTTP %s", r.status_code)
        return None
    return r.text


def _parse_query(body: str) -> list[dict]:
    """Every match the server offers: [{category, discid, artist, album}].

    200 is a single hit; 210 and 211 list several and are worth keeping whole.
    'Exact' here means the offsets line up, which is not the same as one answer:
    Romanza comes back as two exact matches, the Spanish and the Italian
    pressings, with different track names. That is a choice, not a lookup.
    """
    lines = [l.strip() for l in body.splitlines() if l.strip()]
    if not lines:
        return []
    code = lines[0].split(" ", 1)[0]
    if code == "200":
        rows = [lines[0].split(" ", 1)[1]] if " " in lines[0] else []
    elif code in ("210", "211"):
        rows = []
        for line in lines[1:]:
            if line == ".":
                break
            rows.append(line)
    else:
        return []

    matches = []
    for row in rows:
        fields = row.split(" ", 2)
        if len(fields) < 3:
            continue
        artist, sep, album = clean(fields[2]).partition(" / ")
        matches.append({
            "category": fields[0],
            "discid": fields[1],
            "artist": artist.strip(),
            "album": (album if sep else artist).strip(),
        })
    return matches


def _parse_read(body: str, count: int) -> dict | None:
    """Turn an xmcd record into the same entry shape MusicBrainz lookups return.

    Long values are split across repeated keys (TTITLE0 twice, and so on) and
    have to be concatenated in order, without separators.
    """
    lines = body.splitlines()
    if not lines or not lines[0].startswith(("210", "211")):
        return None
    fields: dict[str, str] = {}
    for line in lines[1:]:
        if line.startswith("#") or line.strip() == ".":
            continue
        key, sep, value = line.partition("=")
        if not sep:
            continue
        fields[key] = fields.get(key, "") + value

    dtitle = clean(fields.get("DTITLE", ""))
    if not dtitle:
        return None
    artist, sep, album = dtitle.partition(" / ")
    if not sep:  # self titled records are stored as a single name
        artist = album = dtitle

    titles = {}
    for n in range(count):
        title = clean(fields.get(f"TTITLE{n}", ""))
        if title:
            titles[str(n + 1)] = title
    if not titles:
        return None

    year = fields.get("DYEAR", "").strip()
    return {
        "release_id": None,
        "album": album.strip(),
        "artist": artist.strip(),
        "date": year if year.isdigit() else "",
        "country": None,
        "track_count": len(titles),
        "exact": len(titles) == count,
        "tracks": titles,
        "source": "gnudb",
    }


def release_id(category: str, discid: str) -> str:
    """Our handle for a GnuDB entry, in the same slot as a MusicBrainz id.

    Colon separated on purpose: it travels as a single path segment, which a
    slash would break in two.
    """
    return f"gnudb:{category}:{discid}"


def parse_release_id(value: str) -> tuple[str, str] | None:
    parts = (value or "").split(":")
    return (parts[1], parts[2]) if len(parts) == 3 and parts[0] == "gnudb" else None


async def _query(tracks: list[dict]) -> list[dict]:
    body = await _call(f"cddb+query+{_query_string(tracks)}")
    if body is None:
        return []
    matches = _parse_query(body)
    if not matches:
        _LOGGER.info("GnuDB has no entry for disc %s", disc_id(tracks))
    return matches


async def read_entry(category: str, discid: str, count: int) -> dict | None:
    body = await _call(f"cddb+read+{quote(category)}+{quote(discid)}")
    if body is None:
        return None
    entry = _parse_read(body, count)
    if entry is None:
        _LOGGER.warning("GnuDB entry %s/%s could not be read", category, discid)
        return None
    entry["release_id"] = release_id(category, discid)
    return entry


async def lookup_exact(tracks: list[dict]) -> dict | None:
    """Names for this disc, but only when GnuDB offers exactly one answer.

    With several matches the right one is a judgement call about which pressing
    is in the tray, so they go to the candidate list instead of being applied
    behind the user's back.
    """
    if not tracks:
        return None
    matches = await _query(tracks)
    if len(matches) != 1:
        if matches:
            _LOGGER.info("GnuDB has %d matches for this disc — needs picking", len(matches))
        return None
    return await read_entry(matches[0]["category"], matches[0]["discid"], len(tracks))


async def candidates(tracks: list[dict], limit: int = 8) -> list[dict]:
    """The matches as pickable entries. Track names are fetched on choosing:
    that is one call each, and only the chosen one is worth spending it on."""
    if not tracks:
        return []
    return [{
        "release_id": release_id(m["category"], m["discid"]),
        "album": m["album"],
        "artist": m["artist"],
        "date": "",
        "country": None,
        "track_count": len(tracks),  # matched by TOC, so the shape does line up
        "exact": True,
        "tracks": {},
        "source": "gnudb",
    } for m in (await _query(tracks))[:limit]]
