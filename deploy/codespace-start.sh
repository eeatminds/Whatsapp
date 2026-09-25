#!/usr/bin/env bash
# Starts WA Reach + OpenWA inside a GitHub Codespace (called by .devcontainer/devcontainer.json).
# First run writes wa-reach/.env with generated secrets and prints the admin login.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  password="$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 14)"
  public_url=""
  if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
    public_url="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  fi
  cat > .env <<ENV
ADMIN_EMAIL=admin@test.local
ADMIN_PASSWORD=${password}
OPENWA_API_KEY=$(openssl rand -hex 24)
PUBLIC_URL=${public_url}
OPENWA_IMAGE=ghcr.io/rmyndharis/openwa:0.23
DEFAULT_TIMEZONE=Asia/Kolkata
DEFAULT_COUNTRY=IN
ENV
fi

# The Docker daemon can take a few seconds to come up after the codespace starts.
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker compose up -d --build

for _ in $(seq 1 90); do curl -sf http://localhost:3000/api/health >/dev/null 2>&1 && break; sleep 2; done

email="$(grep '^ADMIN_EMAIL=' .env | cut -d= -f2-)"
password="$(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2-)"
url="$(grep '^PUBLIC_URL=' .env | cut -d= -f2-)"
cat <<MSG

============================================================
 WA Reach is running.
 Open:      ${url:-the "Ports" tab -> port 3000 -> globe icon}
 Email:     ${email}
 Password:  ${password}
 (Saved in wa-reach/.env. Show it again: grep ADMIN wa-reach/.env)
============================================================
MSG
