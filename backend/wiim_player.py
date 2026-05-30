"""Singleton wrapper around pywiim Player with broadcast callback support."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from pywiim import Player
from pywiim.client import WiiMClient

_LOGGER = logging.getLogger(__name__)

POLL_INTERVAL = 5  # seconds between HTTP polls


class WiimManager:
    def __init__(self) -> None:
        self.player: Player | None = None
        self._callbacks: list[Callable[[], None]] = []
        self._poll_task: asyncio.Task | None = None
        self.ip: str = ""

    # --- Lifecycle ---

    async def setup(self, ip: str) -> None:
        await self.teardown()
        self.ip = ip
        client = WiiMClient(host=ip)
        self.player = Player(client, on_state_changed=self._on_state_changed)
        await self.player.refresh(full=True)
        self._poll_task = asyncio.create_task(self._poll_loop(), name="wiim-poll")
        _LOGGER.info("WiimManager ready for %s", ip)

    async def teardown(self) -> None:
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None
        if self.player:
            await self.player.close()
            self.player = None

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(POLL_INTERVAL)
            try:
                await self.player.refresh()
            except Exception as exc:
                _LOGGER.warning("Poll error: %s", exc)

    # --- Callbacks (called by pywiim on any state change) ---

    def add_callback(self, cb: Callable[[], None]) -> None:
        if cb not in self._callbacks:
            self._callbacks.append(cb)

    def remove_callback(self, cb: Callable[[], None]) -> None:
        self._callbacks.discard(cb)

    def _on_state_changed(self) -> None:
        for cb in list(self._callbacks):
            try:
                cb()
            except Exception as exc:
                _LOGGER.debug("Callback error: %s", exc)

    # --- Source detection ---

    # pywiim misidentifies mode=5 (WiFi/Cast) as bluetooth (Issue #6 in pywiim,
    # vendor "CAST" is not in their _VENDOR_MAP). We derive source from the raw mode.
    _MODE_TO_SOURCE: dict[str, str] = {
        "1":  "wifi",       # AirPlay
        "2":  "wifi",       # DLNA
        "4":  "bluetooth",
        "5":  "wifi",       # Network / Cast
        "10": "wifi",       # Internet radio
        "11": "wifi",       # USB
        "20": "hdmi",
        "21": "optical",
        "40": "line-in",
        "41": "bluetooth",
        "43": "hdmi",
    }

    def _get_source(self) -> str | None:
        if not self.player or not self.player._status_model:
            return None
        raw_mode = self.player._status_model.mode
        return self._MODE_TO_SOURCE.get(str(raw_mode)) if raw_mode is not None else None

    # --- State snapshot ---

    def get_state(self) -> dict:
        if not self.player:
            return {"available": False}
        p = self.player
        vol = p.volume_level
        source = self._get_source()
        return {
            "available":    p.available,
            "name":         p.name,
            "model":        p.model_name,
            "firmware":     p.firmware,
            "ip":           self.ip,
            "play_state":   p.play_state,
            "is_playing":   p.is_playing,
            "title":        p.media_title,
            "artist":       p.media_artist,
            "album":        p.media_album,
            "position":     p.media_position,
            "duration":     p.media_duration,
            "volume":       round(vol * 100) if vol is not None else None,
            "muted":        p.is_muted,
            "source":       source,
            "source_name":  p.source_name if source == p.source else source,
            "has_artwork":  bool(p.media_image_url),
            "eq_preset":    p.eq_preset,
        }

    # --- Artwork proxy ---

    async def fetch_artwork(self) -> tuple[bytes, str] | None:
        if not self.player:
            return None
        url = self.player.media_image_url
        if not url:
            return None
        return await self.player.fetch_cover_art(url)
