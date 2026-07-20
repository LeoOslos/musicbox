"""Disc identification: MusicBrainz disc ID, lookups, and a local name cache.

A disc ID identifies a *pressing*, not an album, so plenty of perfectly common
records are not in the database — the local edition of Romanza on the shelf here
is one. When the exact lookup misses, a fuzzy lookup by TOC offers candidates
for the user to pick from once, and the choice is remembered against the disc ID.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import time
from pathlib import Path

import httpx

_LOGGER = logging.getLogger("discs")

MB = "https://musicbrainz.org/ws/2"
# MusicBrainz requires a contactable user agent and at most one call per second
USER_AGENT = "musicbox-wiim-dashboard/1.1 ( leosolsona@gmail.com )"
MIN_INTERVAL = 1.1

PREGAP = 150  # disc offsets are LBA plus the two second lead-in

CACHE_FILE = Path(os.environ.get("CD_NAMES_FILE", Path.home() / "musicbox" / "discs.json"))

_lock = asyncio.Lock()
_last_call = 0.0


def disc_id(tracks: list[dict]) -> str:
    """MusicBrainz disc ID for a TOC. Verified against the published example."""
    offsets = [0] * 100
    offsets[0] = tracks[-1]["begin"] + tracks[-1]["sectors"] + PREGAP
    for track in tracks:
        offsets[track["number"]] = track["begin"] + PREGAP
    blob = "%02X%02X" % (tracks[0]["number"], tracks[-1]["number"])
    blob += "".join("%08X" % value for value in offsets)
    raw = base64.b64encode(hashlib.sha1(blob.encode("ascii")).digest()).decode()
    return raw.replace("+", ".").replace("/", "_").replace("=", "-")


def toc_param(tracks: list[dict]) -> str:
    values = [tracks[0]["number"], tracks[-1]["number"],
              tracks[-1]["begin"] + tracks[-1]["sectors"] + PREGAP]
    values += [t["begin"] + PREGAP for t in tracks]
    return "+".join(str(v) for v in values)


# --- Local cache ---

def _read_cache() -> dict:
    try:
        return json.loads(CACHE_FILE.read_text())
    except (OSError, ValueError):
        return {}


def saved(discid: str) -> dict | None:
    return _read_cache().get(discid)


def remember(discid: str, entry: dict) -> None:
    cache = _read_cache()
    cache[discid] = entry
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2))
    tmp.replace(CACHE_FILE)
    _LOGGER.info("remembered %s as %s", discid, entry.get("album"))


# --- MusicBrainz ---

async def _get(path: str, params: dict) -> dict | None:
    """One rate-limited call. Returns None when the record simply is not there."""
    global _last_call
    async with _lock:
        wait = MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_call = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=25) as client:
                r = await client.get(f"{MB}/{path}", params=params,
                                     headers={"User-Agent": USER_AGENT})
        except httpx.HTTPError as exc:
            _LOGGER.warning("MusicBrainz unreachable: %s", exc)
            return None
    if r.status_code == 404:
        return None
    if r.status_code != 200:
        _LOGGER.warning("MusicBrainz answered %s for %s", r.status_code, path)
        return None
    return r.json()


def _artist(release: dict) -> str:
    credits = release.get("artist-credit") or []
    return "".join(c.get("name", "") + c.get("joinphrase", "")
                   for c in credits if isinstance(c, dict)).strip()


def _titles(release: dict, count: int) -> dict[int, str]:
    """Track titles from the medium that matches this disc's track count."""
    for medium in release.get("media", []):
        tracks = medium.get("tracks") or []
        if len(tracks) == count or not any(m.get("tracks") for m in release["media"]):
            titles = {}
            for track in tracks:
                try:
                    titles[int(track.get("number"))] = track.get("title") or ""
                except (TypeError, ValueError):
                    continue
            if titles:
                return titles
    return {}


def _as_entry(release: dict, count: int) -> dict:
    return {
        "release_id": release.get("id"),
        "album": release.get("title"),
        "artist": _artist(release),
        "date": release.get("date"),
        "country": release.get("country"),
        "tracks": {str(n): t for n, t in _titles(release, count).items()},
    }


async def lookup_exact(discid: str, count: int) -> dict | None:
    data = await _get(f"discid/{discid}", {"fmt": "json", "inc": "recordings+artist-credits"})
    releases = (data or {}).get("releases") or []
    return _as_entry(releases[0], count) if releases else None


async def lookup_candidates(tracks: list[dict], limit: int = 12) -> list[dict]:
    """Fuzzy match by TOC — same track count and roughly the same lengths.

    Deliberately not auto-applied: it routinely returns unrelated albums that
    happen to have the same shape, so a person has to say which one it is.
    """
    data = await _get("discid/-", {"toc": toc_param(tracks), "fmt": "json",
                                   "inc": "recordings+artist-credits"})
    releases = (data or {}).get("releases") or []
    entries = [_as_entry(r, len(tracks)) for r in releases]
    return [e for e in entries if e["tracks"]][:limit]


async def lookup_release(release_id: str, count: int) -> dict | None:
    data = await _get(f"release/{release_id}", {"fmt": "json", "inc": "recordings+artist-credits"})
    return _as_entry(data, count) if data else None
