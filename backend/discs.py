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

# Hand corrections live apart from the looked-up names on purpose: they have to
# survive picking another edition, and re-identifying a disc must never quietly
# overwrite something the user typed.
EDITS_FILE = Path(os.environ.get("CD_EDITS_FILE", CACHE_FILE.parent / "track_edits.json"))

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

def _read(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def _write(path: Path, data: dict) -> None:
    """Write through a temporary file: a half-written names file reads as empty
    and would silently lose every disc ever identified."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.replace(path)


def _read_cache() -> dict:
    return _read(CACHE_FILE)


def saved(discid: str) -> dict | None:
    return _read_cache().get(discid)


def forget(discid: str) -> bool:
    """Drop a saved identification. Any choice has to be undoable."""
    cache = _read_cache()
    if discid not in cache:
        return False
    del cache[discid]
    _write(CACHE_FILE, cache)
    _LOGGER.info("forgot the name saved for %s", discid)
    return True


def remember(discid: str, entry: dict) -> None:
    cache = _read_cache()
    cache[discid] = entry
    _write(CACHE_FILE, cache)
    _LOGGER.info("remembered %s as %s", discid, entry.get("album"))


# --- Hand corrections ---

def edits(discid: str) -> dict[str, str]:
    """Titles the user typed for this disc, keyed by track number."""
    return _read(EDITS_FILE).get(discid) or {}


def set_edit(discid: str, number: int, title: str) -> str | None:
    """Save one corrected title, or drop the correction when given nothing.

    Clearing is how a correction is undone: the name from the database comes
    back, and nothing about the identification itself is touched.
    """
    store = _read(EDITS_FILE)
    disc = dict(store.get(discid) or {})
    title = " ".join(title.split())
    if title:
        disc[str(number)] = title
    else:
        disc.pop(str(number), None)
    if disc:
        store[discid] = disc
    else:
        store.pop(discid, None)
    _write(EDITS_FILE, store)
    _LOGGER.info("track %s of %s renamed to %r", number, discid, title or None)
    return title or None


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


def _medium_titles(medium: dict) -> dict[int, str]:
    titles = {}
    for track in medium.get("tracks") or []:
        try:
            titles[int(track.get("number"))] = track.get("title") or ""
        except (TypeError, ValueError):
            continue
    return titles


def _titles(release: dict, count: int) -> dict[int, str]:
    """Track titles, preferring the medium with this disc's track count.

    Falls back to the closest medium: a pressing with a different track count
    can still be the album the person is looking at, and naming what we can
    beats naming nothing. The caller flags the mismatch.
    """
    media = [m for m in release.get("media", []) if m.get("tracks")]
    if not media:
        return {}
    exact = [m for m in media if len(m["tracks"]) == count]
    chosen = exact[0] if exact else min(media, key=lambda m: abs(len(m["tracks"]) - count))
    return _medium_titles(chosen)


def _as_entry(release: dict, count: int) -> dict:
    titles = _titles(release, count)
    return {
        "release_id": release.get("id"),
        "album": release.get("title"),
        "artist": _artist(release),
        "date": release.get("date"),
        "country": release.get("country"),
        "track_count": len(titles),
        # Names for a pressing with a different track count will not line up
        "exact": len(titles) == count,
        "tracks": {str(n): t for n, t in titles.items()},
        "source": "musicbrainz",
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


async def search_by_name(query: str, count: int, limit: int = 12) -> list[dict]:
    """Text search, for pressings nobody ever registered as a physical disc.

    The TOC search only matches releases someone submitted a disc ID for, so a
    perfectly well known album can be invisible to it — Carmine Meo is in the
    database eight times over and none of them matched the disc on the shelf.
    Titles are not fetched here: that is one call per release, and only the one
    the user picks is worth spending it on.
    """
    data = await _get("release/", {"query": query, "fmt": "json", "limit": str(limit)})
    results = []
    for release in (data or {}).get("releases", []):
        media = release.get("media") or []
        tracks = sum(m.get("track-count") or 0 for m in media)
        artists = release.get("artist-credit") or []
        results.append({
            "release_id": release.get("id"),
            "album": release.get("title"),
            "artist": "".join(c.get("name", "") + c.get("joinphrase", "")
                              for c in artists if isinstance(c, dict)).strip(),
            "date": release.get("date"),
            "country": release.get("country"),
            "track_count": tracks,
            "exact": tracks == count,
            "tracks": {},
            "source": "musicbrainz",
        })
    # Same track count first: those are the ones whose names will line up
    results.sort(key=lambda r: (not r["exact"], r.get("date") or ""))
    return results


async def lookup_release(release_id: str, count: int) -> dict | None:
    data = await _get(f"release/{release_id}", {"fmt": "json", "inc": "recordings+artist-credits"})
    return _as_entry(data, count) if data else None
