# WiiM Dashboard

Dashboard web local para controlar dispositivos WiiM vía HTTP API. Backend Python + FastAPI, frontend HTML/JS vanilla, sin dependencias de build tools.

## Features

- **Auto-discovery**: lee la IP del WiiM desde el inventario IoT local (`device-baseline.json`) y la resuelve vía ARP al arrancar
- **WebSocket push**: actualizaciones en tiempo real sin polling — reacciona a eventos UPnP del dispositivo
- **Carátula**: artwork del track actual, actualizada al cambiar canción
- **Barra de progreso**: posición en tiempo real con interpolación local entre updates, clickeable para seek
- **Controles completos**: play/pause/stop/anterior/siguiente, volumen, mute, fuente de entrada, ecualizador
- **EQ**: selector de los 24 presets del WiiM

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Python 3.12, FastAPI, uvicorn |
| WiiM client | [pywiim](https://github.com/mjcumming/pywiim) (async, UPnP events) |
| Frontend | HTML + CSS + JS vanilla |
| Transporte | WebSocket (`/ws`) |

## Estructura

```
wiim-dashboard/
├── backend/
│   ├── main.py          # FastAPI app — endpoints REST + WebSocket
│   ├── wiim_player.py   # WiimManager: wrapper pywiim con broadcast callbacks
│   ├── ws_manager.py    # WebSocket broadcast a múltiples clientes
│   └── inventory.py     # Resolución de IP desde device-baseline.json + ARP
├── frontend/
│   ├── index.html
│   └── static/
│       ├── style.css
│       └── app.js
└── start.sh
```

## Setup

```bash
python3 -m venv venv
./venv/bin/pip install fastapi uvicorn httpx pywiim websockets
```

## Uso

```bash
# Arrancar (fondo, logs en /tmp/wiim-dashboard.log)
nohup ./start.sh > /tmp/wiim-dashboard.log 2>&1 &

# Ver logs
tail -f /tmp/wiim-dashboard.log

# Parar
kill $(lsof -ti:8080)
```

El dashboard queda disponible en `http://<IP-del-servidor>:8080`.

La IP del WiiM se resuelve automáticamente al iniciar desde `~/iot-mvp/device-baseline.json` (busca el dispositivo llamado "Music Box") + tabla ARP. Si no se encuentra, se puede ingresar manualmente en la UI.

## API REST

| Método | Path | Descripción |
|---|---|---|
| GET | `/api/config` | IP configurada actualmente |
| POST | `/api/config` | Configurar IP manualmente |
| GET | `/api/discover` | Descubrir IP desde inventario |
| GET | `/api/status` | Estado del dispositivo |
| POST | `/api/toggle` | Play/pause |
| POST | `/api/volume/{0-100}` | Setear volumen |
| POST | `/api/mute/{0\|1}` | Mute/unmute |
| POST | `/api/source/{name}` | Cambiar fuente |
| GET | `/api/eq/list` | Listar presets EQ |
| POST | `/api/eq/preset/{name}` | Aplicar preset EQ |
| GET | `/api/artwork` | Carátula actual (imagen) |
| WS | `/ws` | Stream de estado en tiempo real |
| GET | `/api/cd/status` | Disco presente, cantidad de temas, álbum, tema en curso |
| GET | `/api/cd/tracks` | Lista de temas con duración y título (si el disco está identificado) |
| GET | `/api/cd/track/{n}.wav` | Audio del tema, leído en vivo del disco. Acepta `Range` |
| POST | `/api/cd/play/{n}` | Reproducir un tema |
| POST | `/api/cd/next` / `prev` / `stop` | Transporte del disco |
| POST | `/api/transport` | Play/pausa que además arranca el disco si el equipo está detenido |
| POST | `/api/cd/eject` | Expulsar (para la música antes) |
| GET | `/api/cd/candidates` | Álbumes que coinciden con el TOC, para elegir a mano |
| POST | `/api/cd/identify/{release_id}` | Fijar el álbum y recordarlo |
| POST | `/api/cd/title/{n}` | Corregir a mano el nombre de un tema (vacío = volver al de la base) |
| POST | `/api/cd/forget` | Deshacer la identificación |

## Niveles de desarrollo

- [x] **Nivel 1** — Controles básicos, polling 5s, EQ, fuentes
- [x] **Nivel 2** — WebSocket push, UPnP events, carátula, barra de progreso
- [x] **Nivel 3 (parcial)** — Auto-discovery desde inventario IoT local
- [ ] Nivel 3 (pendiente) — Alarmas, Squeezelite/LMS


## CD de audio

La lectora de Mint (`/dev/sr0`) se reproduce en el WiiM **sin copiar nada al disco**: `cdparanoia` lee
el tema y el propio dashboard lo sirve como WAV en el puerto 8080, que es la URL que el WiiM busca.

Detalles que no son obvios:

- **Nada se escribe a disco.** La lectora entrega a ~4,4x la velocidad de reproducción (medido, con
  `-Z`), suficiente para escuchar en vivo. Importa porque Mint tiene el swap sobre un HDD 5400rpm.
- **El WiiM buferea minutos por delante**, así que al sacar el disco hay que **mandar parar el equipo**
  explícitamente o sigue sonando. Las dos vías de expulsión (botón y bandeja física) pasan por
  `_stop_for_disc_release`.
- **`play_status` crudo del equipo** es lo único que distingue *pausado* de *detenido*: pywiim y los
  eventos UPnP informan `pause` para ambos.
- **El disc id de MusicBrainz identifica una edición, no un álbum.** Los prensados locales suelen no
  estar cargados; para esos hay elección manual, guardada en `~/musicbox/discs.json`.
- **Los nombres se buscan en dos bases**: MusicBrainz primero (datos más limpios) y **GnuDB** después,
  que es donde sí están las ediciones locales. Ninguna adivina: se aplica sola únicamente si devuelve
  **una** coincidencia. Si hay varias — Romanza da dos, la castellana y la italiana, con títulos
  distintos — van a la lista de candidatos para elegir a mano.
- **GnuDB es CDDB por HTTP, no HTTPS** (por HTTPS da 404), en `gnudb.gnudb.org/~cddb/cddb.cgi`;
  `freedb.org` está muerto desde 2020. Sus datos son de peor calidad: hay entradas con los acentos ya
  rotos **en origen** (llegan como U+FFFD, no es problema de encoding del cliente), así que se limpian
  al entrar.
- **Los nombres corregidos a mano le ganan a las dos bases** y sobreviven a cambiar de edición: viven
  aparte, en `~/musicbox/track_edits.json` (el lápiz de cada tema; vaciar el texto vuelve al de la base).
- **La búsqueda de nombres nunca bloquea la reproducción**: corre en segundo plano y avisa por WebSocket.

### Requisitos

`cdparanoia` y `eject` (paquetes del sistema). El puerto 8080 debe estar habilitado en ufw — es la
razón por la que el audio se sirve desde el dashboard y no desde un servidor aparte.

