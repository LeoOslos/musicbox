"""Botón on/off de luces-musica: las LIFX siguen la música (proyecto aparte, ~/luces-musica).

No se importa nada de ese repo: se lo corre como subproceso con SU venv, y se lo apaga con
SIGTERM, que es lo que le hace restaurar el color de cada lámpara antes de salir. Queda en el
mismo grupo de procesos que el dashboard, así un `pm2 restart` también lo corta (y restaura).
Su salida va al log del dashboard, con su propio nombre de proceso (luces_musica).
"""
import asyncio
import logging
import os
import signal

DIR = os.environ.get("LUCES_MUSICA_DIR", os.path.expanduser("~/luces-musica"))
PYTHON = os.path.join(DIR, "venv", "bin", "python")
SCRIPT = os.path.join(DIR, "luces_musica.py")
ESPERA_APAGADO_S = 5

_LOGGER = logging.getLogger("luces")
_proceso: asyncio.subprocess.Process | None = None
_lock = asyncio.Lock()


def prendidas() -> bool:
    return _proceso is not None and _proceso.returncode is None


async def prender() -> None:
    global _proceso
    async with _lock:
        if prendidas():
            return
        if not (os.path.exists(PYTHON) and os.path.exists(SCRIPT)):
            raise FileNotFoundError(f"luces-musica no está instalado en {DIR}")
        _proceso = await asyncio.create_subprocess_exec(PYTHON, SCRIPT, "correr", cwd=DIR)
        _LOGGER.info("luces-musica prendido (pid %d)", _proceso.pid)


async def apagar() -> None:
    async with _lock:
        if not prendidas():
            return
        _proceso.send_signal(signal.SIGTERM)
        try:
            await asyncio.wait_for(_proceso.wait(), ESPERA_APAGADO_S)
        except asyncio.TimeoutError:
            _LOGGER.warning("luces-musica no terminó en %d s: se lo mata (las lámparas pueden "
                            "quedar con el último color)", ESPERA_APAGADO_S)
            _proceso.kill()
            await _proceso.wait()
        _LOGGER.info("luces-musica apagado (rc=%d)", _proceso.returncode)
