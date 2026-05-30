"""Resolve WiiM IP from the local IoT device inventory (device-baseline.json + ARP)."""

from __future__ import annotations

import json
import logging
import re
import subprocess
from pathlib import Path

_LOGGER = logging.getLogger(__name__)

BASELINE_PATH = Path("/home/leoadmin/iot-mvp/device-baseline.json")

# Keywords that identify the WiiM in the inventory
_WIIM_KEYWORDS = ("music box", "wiim", "linkplay")


def _load_baseline() -> dict:
    try:
        return json.loads(BASELINE_PATH.read_text())
    except Exception as exc:
        _LOGGER.warning("Could not read device baseline: %s", exc)
        return {}


def _find_wiim_mac(baseline: dict) -> str | None:
    """Return the MAC address of the WiiM entry in the baseline, or None."""
    for mac, info in baseline.items():
        name = (info.get("device_name") or "").lower()
        if any(kw in name for kw in _WIIM_KEYWORDS):
            _LOGGER.info("Found WiiM in inventory: %s → %s", mac, info.get("device_name"))
            return mac
    return None


def _arp_lookup(mac: str) -> str | None:
    """Return the current IP for a MAC address via the ARP table."""
    try:
        out = subprocess.check_output(["arp", "-n"], text=True, timeout=3)
        for line in out.splitlines():
            if mac.lower() in line.lower():
                # ARP line: IP  HWtype  MAC  flags  iface
                ip = line.split()[0]
                if re.match(r"\d+\.\d+\.\d+\.\d+", ip):
                    return ip
    except Exception as exc:
        _LOGGER.warning("ARP lookup failed: %s", exc)
    return None


def discover_wiim_ip() -> str | None:
    """Look up the WiiM IP from the local inventory + ARP table."""
    baseline = _load_baseline()
    mac = _find_wiim_mac(baseline)
    if not mac:
        _LOGGER.warning("WiiM not found in device inventory (%s)", BASELINE_PATH)
        return None
    ip = _arp_lookup(mac)
    if not ip:
        _LOGGER.warning("WiiM MAC %s found in inventory but not in ARP table", mac)
    return ip
