"""Spotify Web API: song search + play-to-WiiM via Spotify Connect.

Authorization Code with PKCE — no client secret needed, just SPOTIFY_CLIENT_ID.

Spotify's redirect URI policy requires HTTPS *unless* the URI is an explicit
loopback address (127.0.0.1); "localhost" and LAN IPs (like the dashboard's own
192.168.1.155) are both rejected (verified against Spotify's docs, 2026-08-31).
So the redirect always points at 127.0.0.1 on this same port. Day-to-day use of
the dashboard is unaffected — only the one-time login has to be done through a
browser that can reach that loopback address: on Mint's own display, or via an
SSH -L tunnel (`ssh -L 8080:localhost:8080 leoadmin@192.168.1.155`) from wherever
the browser runs.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import time
from pathlib import Path

import httpx

_LOGGER = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parent.parent
_ENV_PATH = _ROOT / ".env"
_TOKEN_PATH = _ROOT / "spotify_token.json"


def _load_env() -> None:
    if not _ENV_PATH.exists():
        return
    for line in _ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env()

CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
PORT = int(os.environ.get("PORT", "8080"))
REDIRECT_URI = f"http://127.0.0.1:{PORT}/api/spotify/callback"
SCOPES = "user-read-playback-state user-modify-playback-state"

# Match hint for picking the WiiM out of the Spotify Connect device list — same
# hint the old standalone play_spotify_wiim.py script used.
WIIM_NAME_HINT = "wiim"

_AUTH_BASE = "https://accounts.spotify.com"
_API_BASE = "https://api.spotify.com/v1"

# state -> code_verifier, for the seconds between redirect and callback.
# In-memory is fine: this is a single-user app, a restart just means logging in again.
_pending: dict[str, str] = {}


class SpotifyError(Exception):
    pass


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def build_authorize_url() -> str:
    if not CLIENT_ID:
        raise SpotifyError("SPOTIFY_CLIENT_ID no está configurado (.env)")
    verifier = _b64url(secrets.token_bytes(64))
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    state = _b64url(secrets.token_bytes(16))
    _pending[state] = verifier
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
        "scope": SCOPES,
        "state": state,
    }
    return f"{_AUTH_BASE}/authorize?{httpx.QueryParams(params)}"


def _save_token(data: dict) -> None:
    data["obtained_at"] = time.time()
    _TOKEN_PATH.write_text(json.dumps(data))
    _TOKEN_PATH.chmod(0o600)


def _load_token() -> dict | None:
    if not _TOKEN_PATH.exists():
        return None
    try:
        return json.loads(_TOKEN_PATH.read_text())
    except Exception:
        return None


def is_authenticated() -> bool:
    tok = _load_token()
    return bool(tok and tok.get("refresh_token"))


async def exchange_code(code: str, state: str) -> None:
    verifier = _pending.pop(state, None)
    if not verifier:
        raise SpotifyError("Login expirado o inválido — reintentá desde /api/spotify/login")
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{_AUTH_BASE}/api/token", data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "client_id": CLIENT_ID,
            "code_verifier": verifier,
        })
    if r.status_code != 200:
        raise SpotifyError(f"Spotify rechazó el token: {r.status_code} {r.text}")
    _save_token(r.json())


async def _access_token() -> str:
    tok = _load_token()
    if not tok:
        raise SpotifyError("No conectado a Spotify — andá a /api/spotify/login")
    # 60s buffer so a token expiring mid-request never gets used.
    if time.time() < tok.get("obtained_at", 0) + tok.get("expires_in", 0) - 60:
        return tok["access_token"]
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{_AUTH_BASE}/api/token", data={
            "grant_type": "refresh_token",
            "refresh_token": tok["refresh_token"],
            "client_id": CLIENT_ID,
        })
    if r.status_code != 200:
        raise SpotifyError(f"No se pudo refrescar el token de Spotify: {r.status_code} {r.text}")
    fresh = r.json()
    fresh.setdefault("refresh_token", tok["refresh_token"])  # Spotify no siempre manda uno nuevo
    _save_token(fresh)
    return fresh["access_token"]


async def _api(method: str, path: str, **kwargs) -> httpx.Response:
    token = await _access_token()
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient() as client:
        return await client.request(method, f"{_API_BASE}{path}", headers=headers, timeout=8, **kwargs)


async def search_tracks(query: str, limit: int = 12) -> list[dict]:
    r = await _api("GET", "/search", params={"q": query, "type": "track", "limit": limit})
    if r.status_code != 200:
        raise SpotifyError(f"Búsqueda falló: {r.status_code} {r.text}")
    items = r.json().get("tracks", {}).get("items", [])
    return [{
        "uri": t["uri"],
        "name": t["name"],
        "artist": ", ".join(a["name"] for a in t["artists"]),
        "album": t["album"]["name"],
        "image": (t["album"]["images"][-1]["url"] if t["album"]["images"] else None),
    } for t in items]


async def _devices() -> list[dict]:
    r = await _api("GET", "/me/player/devices")
    if r.status_code != 200:
        raise SpotifyError(f"No se pudo listar dispositivos: {r.status_code} {r.text}")
    return r.json().get("devices", [])


async def _wiim_device_id() -> str:
    devices = await _devices()
    wiim = next((d for d in devices if WIIM_NAME_HINT in d["name"].lower()), None)
    if not wiim:
        names = ", ".join(d["name"] for d in devices) or "ninguno"
        raise SpotifyError(f"El WiiM no aparece como dispositivo Spotify Connect (visibles: {names})")
    return wiim["id"]


async def play_track(uri: str) -> None:
    device_id = await _wiim_device_id()
    # device_id here both transfers playback to the WiiM and starts the track,
    # in the one call — no separate transfer step needed.
    r = await _api("PUT", "/me/player/play", params={"device_id": device_id}, json={"uris": [uri]})
    if r.status_code == 403:
        raise SpotifyError("Spotify rechazó la reproducción (403) — requiere cuenta Premium")
    if r.status_code not in (200, 204):
        raise SpotifyError(f"No se pudo reproducir: {r.status_code} {r.text}")


async def seek(position_ms: int) -> None:
    """Move the position of the current Spotify Connect session on the WiiM.

    The WiiM's own local seek command (LinkPlay's setPlayerCmd:seek) is a no-op
    while it's a Spotify Connect *receiver* — verified against the device's raw
    HTTP API directly: it replies "OK" and curpos keeps advancing untouched. The
    receiver only plays what Spotify's session feeds it; only Spotify's own API
    actually controls the position of that session.
    """
    device_id = await _wiim_device_id()
    r = await _api("PUT", "/me/player/seek", params={"position_ms": position_ms, "device_id": device_id})
    if r.status_code not in (200, 204):
        raise SpotifyError(f"No se pudo mover la posición en Spotify: {r.status_code} {r.text}")
