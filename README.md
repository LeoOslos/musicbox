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

## Niveles de desarrollo

- [x] **Nivel 1** — Controles básicos, polling 5s, EQ, fuentes
- [x] **Nivel 2** — WebSocket push, UPnP events, carátula, barra de progreso
- [x] **Nivel 3 (parcial)** — Auto-discovery desde inventario IoT local
- [ ] Nivel 3 (pendiente) — Alarmas, Squeezelite/LMS
