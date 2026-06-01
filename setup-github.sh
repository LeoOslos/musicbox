#!/usr/bin/env bash
set -e

REPO_NAME="wiim-dashboard"
DESCRIPTION="Dashboard web local para controlar WiiM vía HTTP API — FastAPI + WebSocket + pywiim"

echo "=== WiiM Dashboard — GitHub setup ==="

# 1. Instalar gh si no está
if ! command -v gh &>/dev/null; then
  echo "Instalando GitHub CLI..."
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /tmp/ghkey.gpg
  sudo mv /tmp/ghkey.gpg /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  sudo apt update -qq && sudo apt install gh -y
fi

# 2. Autenticar con token (funciona por SSH sin browser)
if ! gh auth status &>/dev/null; then
  echo ""
  echo "Necesitás un GitHub Personal Access Token."
  echo "Generalo en: https://github.com/settings/tokens/new"
  echo "  → Scope requerido: repo"
  echo ""
  read -rsp "Pegá el token y presioná Enter: " GH_TOKEN_INPUT
  echo ""
  echo "$GH_TOKEN_INPUT" | gh auth login --with-token
fi

# 3. Inicializar git
if [ ! -d .git ]; then
  git init
  git branch -M main
fi

# 4. Crear repo remoto privado
echo "Creando repo $REPO_NAME en GitHub..."
gh repo create "$REPO_NAME" \
  --private \
  --description "$DESCRIPTION" \
  --source . \
  --remote origin

# 5. Primer commit y push
git add .
git commit -m "feat: WiiM dashboard — Niveles 1, 2 y 3 (auto-discovery)

- Backend FastAPI con pywiim (UPnP events + HTTP polling)
- WebSocket push para actualizaciones en tiempo real
- Carátula, barra de progreso con seek
- Auto-discovery IP desde inventario IoT (device-baseline.json + ARP)
- Frontend HTML/CSS/JS vanilla sin build tools

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

git push -u origin main

echo ""
echo "Listo: $(gh repo view $REPO_NAME --json url -q .url)"
