from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

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
