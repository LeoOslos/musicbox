import asyncio
import os
import socket
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import cdrom
from .inventory import discover_wiim_ip
from .wiim_player import WiimManager
from .ws_manager import WSManager

wiim = WiimManager()
ws_mgr = WSManager()


def _broadcast() -> None:
    ws_mgr.broadcast(wiim.get_state())


@asynccontextmanager
async def lifespan(app: FastAPI):
    wiim.add_callback(_broadcast)
    # Auto-connect from inventory on startup
    ip = discover_wiim_ip()
    if ip:
        await wiim.setup(ip)
    yield
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

# Port the WiiM must reach us on — the dashboard's own port (see ecosystem.config.js)
HTTP_PORT = int(os.environ.get("PORT", "8080"))


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


def _track(tracks: list[dict], number: int) -> dict:
    for t in tracks:
        if t["number"] == number:
            return t
    raise HTTPException(status_code=404, detail=f"Track {number} not on disc")


@app.get("/api/cd/status")
async def cd_status():
    status = await asyncio.to_thread(cdrom.disc_status)
    if status != "audio":
        _toc_cache.clear()
        return {"status": status, "tracks": 0}
    tracks = await _toc()
    return {"status": status, "tracks": len(tracks)}


@app.get("/api/cd/tracks")
async def cd_tracks(refresh: bool = False):
    if await asyncio.to_thread(cdrom.disc_status) != "audio":
        raise HTTPException(status_code=404, detail="No audio CD in the drive")
    return await _toc(refresh)


@app.get("/api/cd/track/{number}.wav")
async def cd_track_audio(number: int):
    track = _track(await _toc(), number)
    return StreamingResponse(
        cdrom.stream_track(number, track["sectors"]),
        media_type="audio/wav",
        headers={"Content-Length": str(cdrom.wav_size(track["sectors"]))},
    )


@app.post("/api/cd/play/{number}")
async def cd_play(number: int):
    _track(await _toc(), number)
    url = f"http://{_local_ip()}:{HTTP_PORT}/api/cd/track/{number}.wav"
    await _player().play_url(url)
    return {"ok": True, "track": number, "url": url}


@app.post("/api/cd/stop")
async def cd_stop():
    await _player().stop()
    await cdrom.stop_reading()
    return {"ok": True}


@app.post("/api/cd/eject")
async def cd_eject():
    await cdrom.stop_reading()
    await asyncio.to_thread(cdrom.eject)
    _toc_cache.clear()
    return {"ok": True}


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
