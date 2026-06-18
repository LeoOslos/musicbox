// ecosystem.config.js — PM2
// Uso: pm2 start ecosystem.config.js
//      pm2 save
// wiim-dashboard NO es Flask: es FastAPI servido por uvicorn (ASGI).
// Replica el arranque "venv/bin/python3 -m uvicorn backend.main:app ...".

module.exports = {
  apps: [
    {
      name: "wiim-dashboard",
      script: "/home/leoadmin/musicbox/wiim-dashboard/venv/bin/python3",
      args: "-m uvicorn backend.main:app --host 0.0.0.0 --port 8080",
      interpreter: "none",
      cwd: "/home/leoadmin/musicbox/wiim-dashboard",
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      kill_timeout: 5000, // margen para cierre graceful de uvicorn (evita SIGKILL en deploys)
    },
  ],
};
