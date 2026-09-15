"""Formato estándar de log para código Python (plan: ~/PLAN-estandarizar-logs.md, Fase 0.4).

PLANTILLA: se COPIA a cada proyecto; la regla 6 de arquitectura prohíbe importarla desde otro repo.
Cambiar el formato es cambiar esta plantilla, sus copias y logcron.py (un test verifica que las
dos coincidan).

Uso, solo desde el punto de entrada (el resto del código usa logging.getLogger(__name__) y no
configura nada):

    from registro_log import configurar_logging
    log = configurar_logging("cierre_diario")
    log.info("listo")
    log.exception("falló el paso X")    # el traceback sale con el prefijo en cada línea

Salida:
    2026-09-11 18:40:03 -03 INFO cierre_diario leoadmin listo

Escribe a stdout: bajo cron lo toma logcron.py, que deja pasar intactas las líneas ya formateadas;
bajo pm2 va al -out.log. Con archivo=RUTA escribe además en ese archivo.

Un módulo-librería que tiene su PROPIO archivo de log (no es punto de entrada y no debe tocar el
logger raíz) usa logger_a_archivo:

    log = logger_a_archivo("gemelo_sync", "/ruta/gemelo_sync.log")
    log.warning("FALLO ...")

Solo stdlib.
"""

import logging
import os
import pwd
import re
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Argentina/Buenos_Aires")
PROCESO_VALIDO = re.compile(r"^[A-Za-z0-9_.-]+$")


class FormatoEstandar(logging.Formatter):
    def __init__(self, proceso):
        super().__init__()
        self.proceso = proceso
        self.usuario = pwd.getpwuid(os.geteuid()).pw_name

    def formatTime(self, record, datefmt=None):
        t = datetime.fromtimestamp(record.created, TZ)
        z = t.strftime("%z")
        return t.strftime("%Y-%m-%d %H:%M:%S ") + (z[:3] if z.endswith("00") else z)

    def format(self, record):
        texto = record.getMessage()
        if record.exc_info:
            texto += "\n" + self.formatException(record.exc_info)
        if record.stack_info:
            texto += "\n" + self.formatStack(record.stack_info)
        prefijo = f"{self.formatTime(record)} {record.levelname} {self.proceso} {self.usuario} "
        return "\n".join(prefijo + l for l in texto.splitlines() if l.strip()) or prefijo.rstrip()


def configurar_logging(proceso, nivel=logging.INFO, archivo=None):
    """Configura el logger raíz con el formato estándar y devuelve el logger del proceso.

    Se puede llamar más de una vez: reemplaza los handlers que puso antes, no los duplica.
    """
    if not PROCESO_VALIDO.match(proceso):
        raise ValueError(f"proceso inválido para el log (sin espacios): {proceso!r}")
    raiz = logging.getLogger()
    for h in [h for h in raiz.handlers if getattr(h, "_registro_log", False)]:
        raiz.removeHandler(h)
        h.close()
    handlers = [logging.StreamHandler(sys.stdout)]
    if archivo:
        os.makedirs(os.path.dirname(archivo) or ".", exist_ok=True)
        handlers.append(logging.FileHandler(archivo, encoding="utf-8"))
    formato = FormatoEstandar(proceso)
    for h in handlers:
        h._registro_log = True
        h.setFormatter(formato)
        raiz.addHandler(h)
    raiz.setLevel(nivel)
    logging.captureWarnings(True)
    return logging.getLogger(proceso)


def logger_a_archivo(proceso, ruta, nivel=logging.INFO):
    """Logger que escribe SOLO en `ruta` con el formato estándar, sin tocar el logger raíz.

    Para módulos con log propio que se importan desde otros procesos. No propaga (no duplica en
    stdout del que lo importa). El archivo se abre recién en la primera línea, así importar el
    módulo no crea archivos. Pedirlo dos veces con el mismo proceso y ruta devuelve el mismo logger.
    """
    if not PROCESO_VALIDO.match(proceso):
        raise ValueError(f"proceso inválido para el log (sin espacios): {proceso!r}")
    ruta = os.path.abspath(ruta)
    log = logging.getLogger(f"registro_log.archivo[{proceso}]{ruta}")
    if not log.handlers:
        os.makedirs(os.path.dirname(ruta), exist_ok=True)
        h = logging.FileHandler(ruta, encoding="utf-8", delay=True)
        h.setFormatter(FormatoEstandar(proceso))
        log.addHandler(h)
        log.propagate = False
    log.setLevel(nivel)
    return log
