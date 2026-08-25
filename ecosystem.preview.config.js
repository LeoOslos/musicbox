// ecosystem.preview.config.js — PM2, vista previa del rediseño en :8081
// El proceso solo sirve el frontend nuevo: la API y el WebSocket los reenvía
// al dashboard de producción (:8080), que sigue siendo el único que habla con
// el WiiM y con la lectora de CD.
//
// Uso: pm2 start ecosystem.preview.config.js && pm2 save

module.exports = {
  apps: [
    {
      name: "wiim-dashboard-v2",
      script: "/home/leoadmin/musicbox/wiim-dashboard/venv/bin/python3",
      args: "-m uvicorn backend.preview:app --host 0.0.0.0 --port 8081",
      interpreter: "none",
      cwd: "/home/leoadmin/musicbox/wiim-dashboard-v2",
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      kill_timeout: 5000,
    },
  ],
};
