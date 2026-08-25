"""Servidor de vista previa del rediseño (puerto 8081).

Sirve el frontend nuevo, pero **no habla con el equipo**: cada llamada a la API
y el WebSocket se reenvían al dashboard de producción (8080). Es a propósito.
El backend real posee cosas que no admiten dos dueños — la lectora de CD, el
vigía que detecta cambios de disco, el autoplay — y un segundo proceso leyendo
`/dev/sr0` en paralelo se pisaría con el que está en uso. Acá la única diferencia
entre las dos versiones es la piel.

El audio del CD no pasa por acá: el backend de producción le da al WiiM su propia
URL (puerto 8080), que es la que ya está habilitada en ufw.
"""

import asyncio
import os

import httpx
import websockets
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

UPSTREAM = os.environ.get("WIIM_UPSTREAM", "http://127.0.0.1:8080")
UPSTREAM_WS = UPSTREAM.replace("http://", "ws://").replace("https://", "wss://")

app = FastAPI(title="wiim-dashboard preview")
client = httpx.AsyncClient(base_url=UPSTREAM, timeout=60.0)


@app.on_event("shutdown")
async def _close() -> None:
    await client.aclose()


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_api(path: str, request: Request):
    body = await request.body()
    # Host se recalcula solo; el resto de los headers se pasan tal cual para que
    # el Range de los WAV siga funcionando si alguien pide audio desde acá.
    headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}
    upstream = await client.request(
        request.method,
        f"/api/{path}",
        params=request.query_params,
        content=body or None,
        headers=headers,
    )
    passthrough = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in ("content-encoding", "transfer-encoding", "connection", "content-length")
    }
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=passthrough,
        media_type=upstream.headers.get("content-type"),
    )


@app.websocket("/ws")
async def proxy_ws(ws: WebSocket):
    await ws.accept()
    try:
        async with websockets.connect(f"{UPSTREAM_WS}/ws") as upstream:

            async def to_client() -> None:
                async for message in upstream:
                    await ws.send_text(message if isinstance(message, str) else message.decode())

            async def to_upstream() -> None:
                while True:
                    await upstream.send(await ws.receive_text())

            done, pending = await asyncio.wait(
                [asyncio.create_task(to_client()), asyncio.create_task(to_upstream())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
    except (WebSocketDisconnect, ConnectionError, OSError):
        pass
    finally:
        try:
            await ws.close()
        except RuntimeError:
            pass


app.mount("/static", StaticFiles(directory="frontend/static"), name="static")


@app.get("/")
async def index():
    return FileResponse("frontend/index.html")
