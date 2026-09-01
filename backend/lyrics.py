"""Synced lyrics from lrclib.net — free, keyless, matched by artist/title/duration.

Spotify's own Web API has no public lyrics endpoint (the one their app uses is
internal, undocumented, and outside their ToS), so this is a separate source.
"""

from __future__ import annotations

import logging
import re

import httpx

_LOGGER = logging.getLogger(__name__)

_BASE = "https://lrclib.net/api"
_HEADERS = {"User-Agent": "wiim-dashboard/1.0 (+https://github.com/LeoOslos/musicbox)"}

# artist|title -> parsed result, so scrubbing back and forth on a track (pause,
# seek) never re-hits the network. Never expires: the dashboard restarts rarely
# enough that this never grows large within a session.
_cache: dict[str, dict] = {}

_LINE_RE = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\](.*)$")


def _parse_synced(text: str) -> list[dict]:
    lines = []
    for raw in text.splitlines():
        m = _LINE_RE.match(raw)
        if not m:
            continue
        minutes, seconds, content = m.groups()
        content = content.strip()
        if content:
            lines.append({"time": round(int(minutes) * 60 + float(seconds), 2), "text": content})
    return lines


async def _get(client: httpx.AsyncClient, artist: str, title: str, album: str | None, duration: float | None) -> dict | None:
    params = {"artist_name": artist, "track_name": title}
    if album:
        params["album_name"] = album
    if duration:
        params["duration"] = round(duration)
    r = await client.get(f"{_BASE}/get", params=params, headers=_HEADERS, timeout=8)
    return r.json() if r.status_code == 200 else None


async def _search(client: httpx.AsyncClient, artist: str, title: str) -> dict | None:
    r = await client.get(f"{_BASE}/search", params={"artist_name": artist, "track_name": title},
                          headers=_HEADERS, timeout=8)
    if r.status_code != 200:
        return None
    results = r.json()
    return results[0] if results else None


async def fetch(artist: str, title: str, album: str | None = None, duration: float | None = None) -> dict:
    """Look up lyrics for one track. status is one of: synced, plain, instrumental, none."""
    key = f"{artist.lower()}|{title.lower()}"
    if key in _cache:
        return _cache[key]

    empty = {"status": "none", "lines": [], "plain": ""}
    if not artist or not title:
        return empty

    try:
        async with httpx.AsyncClient() as client:
            entry = await _get(client, artist, title, album, duration)
            if entry is None:
                # Exact match failed — likely a title with "(Remastered)", a
                # feature credit, etc. The loose search catches those.
                entry = await _search(client, artist, title)
    except Exception as exc:
        _LOGGER.warning("lrclib lookup failed for %s - %s: %s", artist, title, exc)
        return empty

    if entry is None:
        _cache[key] = empty
        return empty

    if entry.get("instrumental"):
        result = {"status": "instrumental", "lines": [], "plain": ""}
    elif entry.get("syncedLyrics"):
        result = {"status": "synced", "lines": _parse_synced(entry["syncedLyrics"]), "plain": entry.get("plainLyrics") or ""}
    elif entry.get("plainLyrics"):
        result = {"status": "plain", "lines": [], "plain": entry["plainLyrics"]}
    else:
        result = empty

    _cache[key] = result
    return result
