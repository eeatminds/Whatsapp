#!/usr/bin/env bash
# First-time setup of WA Reach on a fresh Ubuntu server, with HTTPS on your own domain.
#
#   git clone --depth 1 -b claude/sweet-fermat-9qszg4 https://github.com/digitalmarketing-RNS/Shreyas ~/Shreyas
#   cd ~/Shreyas/wa-reach && bash deploy/install.sh
#
# Asks for your domain and admin email (or: bash deploy/install.sh wa.example.com you@example.com),
# installs Docker if needed, writes .env with strong random secrets, opens the firewall for HTTPS
# and starts everything. Running it again keeps the existing .env and just starts WA Reach.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$*"; }
secret() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }

if [ "$(id -u)" != 0 ]; then
  echo "Run this as root (log in with: ssh root@YOUR_SERVER_IP)."
  exit 1
fi

if [ -f .env ]; then
  say "Using the existing .env"
  domain="$(grep -E '^DOMAIN=' .env | head -1 | cut -d= -f2- | tr -d '\r"' || true)"
  email="$(grep -E '^ADMIN_EMAIL=' .env | head -1 | cut -d= -f2- | tr -d '\r"' || true)"
  password=""
  [ -n "$domain" ] || { echo ".env has no DOMAIN=. Add DOMAIN=your.domain and PUBLIC_URL=https://your.domain, then run this again."; exit 1; }
else
  domain="${1:-}"
  email="${2:-}"
  while ! [[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; do
    [ -n "$domain" ] && echo "  '$domain' doesn't look like a domain. Type it without https://, e.g. wa.yourbrand.com"
    read -r -p "Domain for WA Reach (e.g. wa.yourbrand.com): " domain
    domain="$(printf '%s' "$domain" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##')"
  done
  while ! [[ "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; do
    [ -n "$email" ] && echo "  '$email' doesn't look like an email address."
    read -r -p "Your admin login email: " email
  done
  password="$(secret 9)"
  total_gb=$(( ($(awk '/MemTotal/ {print $2}' /proc/meminfo) + 524288) / 1048576 ))
  mem_limit=$(( total_gb > 4 ? total_gb - 2 : 2 ))
  say "Writing .env"
  (
    umask 077
    cat > .env <<EOF
# Created by deploy/install.sh on $(date -u +%F). Keep this file private.

# Platform-admin login, created on first start. Change the password later in Admin > Settings.
ADMIN_EMAIL=$email
ADMIN_PASSWORD=$password

# Shared by OpenWA and WA Reach. Don't change it after the first start.
OPENWA_API_KEY=$(secret 24)

# HTTPS on your domain.
DOMAIN=$domain
PUBLIC_URL=https://$domain

DEFAULT_TIMEZONE=Asia/Kolkata
DEFAULT_COUNTRY=IN

# Memory for WhatsApp numbers (~300-500 MB each); this server has about ${total_gb} GB of RAM.
OPENWA_MEM_LIMIT=${mem_limit}g
EOF
  )
  echo "  done (WhatsApp numbers get up to ${mem_limit} GB of RAM)"
fi

if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  say "Opening the firewall for HTTPS"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  echo "  ports 22, 80 and 443 open"
fi

say "Checking DNS for $domain"
ips="$(hostname -I 2>/dev/null || true)"
resolved="$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1; exit}' || true)"
dns_ok=""
if [ -n "$resolved" ] && grep -qwF -- "$resolved" <<<"$ips"; then
  dns_ok=1
  echo "  $domain points to this server."
else
  echo "  $domain points to ${resolved:-nowhere yet}, not to this server ($(awk '{print $1}' <<<"$ips"))."
  echo "  Change its DNS A record to this server's IP. HTTPS starts by itself once it points here."
fi

say "Starting WA Reach (the first build takes a few minutes)"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker image prune -f >/dev/null

say "Checking"
ok=""
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then ok=1 && break; fi
  sleep 5
done
if [ -n "$ok" ]; then
  echo "  WA Reach is running."
else
  echo "  WA Reach did not answer yet. See: docker compose logs --tail 50 wa-reach"
fi
if [ -n "$dns_ok" ]; then
  for _ in $(seq 1 12); do
    curl -fsS --max-time 10 "https://$domain/api/health" >/dev/null 2>&1 && { echo "  https://$domain is live."; break; }
    sleep 5
  done
fi

cat <<EOF

Open https://$domain and sign in:
  Email:    $email
EOF
if [ -n "$password" ]; then
  cat <<EOF
  Password: $password
Save this password now (it is also in .env). You can change it in Admin > Settings.
EOF
else
  echo "  Password: the ADMIN_PASSWORD in .env (or the one you changed it to)"
fi
cat <<EOF

Recommended next:
  - Daily Google Drive backups, so a server or hosting problem never loses data:
    see "Daily backups" in README.md.
  - Automatic updates every 10 minutes:
    (crontab -l 2>/dev/null; echo "*/10 * * * * cd $PWD && bash deploy/update.sh --if-changed >> update.log 2>&1") | crontab -
EOF
