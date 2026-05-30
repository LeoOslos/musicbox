"""WebSocket broadcast manager."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable

from fastapi import WebSocket

_LOGGER = logging.getLogger(__name__)


class WSManager:
    def __init__(self) -> None:
        self._queues: list[asyncio.Queue] = []

    @property
    def has_clients(self) -> bool:
        return bool(self._queues)

    def broadcast(self, data: dict) -> None:
        payload = json.dumps(data)
        for q in list(self._queues):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass  # slow client; skip this update

    async def handle(self, ws: WebSocket, get_state: Callable[[], dict]) -> None:
        await ws.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=8)
        self._queues.append(q)
        try:
            # Send current state immediately on connect
            await ws.send_text(json.dumps(get_state()))
            while True:
                payload = await q.get()
                await ws.send_text(payload)
        except Exception:
            pass
        finally:
            self._queues.remove(q)
            _LOGGER.debug("WebSocket client disconnected (%d remaining)", len(self._queues))
