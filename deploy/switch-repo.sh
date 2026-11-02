#!/usr/bin/env bash
# Moves a server set up from the earlier repository (~/Shreyas/wa-reach) to this folder:
#
#   git clone https://github.com/eeatminds/Whatsapp ~/whatsapp && bash ~/whatsapp/deploy/switch-repo.sh
#
# Data, WhatsApp logins and the HTTPS certificate live in Docker volumes named after the project
# ("wa-reach"), not in the folder, so they stay as they are. Copies .env (and local backups), rebuilds
# from here, and points the scheduled update and backup jobs at this folder. Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
new="$PWD"
old="${1:-$HOME/Shreyas/wa-reach}"

if [ "$(id -u)" != 0 ]; then
  echo "Run this as root."
  exit 1
fi
if [ ! -f .env ]; then
  if [ ! -f "$old/.env" ]; then
    echo "No .env here or in $old. If the old folder is elsewhere: bash deploy/switch-repo.sh /path/to/old/wa-reach"
    exit 1
  fi
  install -m 600 "$old/.env" .env
  echo "== Copied .env from $old"
fi
if [ -d "$old/backups" ] && [ ! -d backups ]; then
  cp -a "$old/backups" backups
  echo "== Copied local backups"
fi

echo "== Rebuilding WA Reach from $new (offline for about a minute)"
bash deploy/update.sh

if crontab -l >/dev/null 2>&1 && crontab -l | grep -qF "$old"; then
  crontab -l | sed "s#$old#$new#g" | crontab -
  echo "== Scheduled jobs now run from $new"
fi

for _ in $(seq 1 24); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo
    echo "Done. WA Reach is running from $new."
    echo "Open your dashboard and check your WhatsApp numbers are still connected."
    echo "From now on update with:  cd $new && bash deploy/update.sh"
    echo "Once everything works you can remove the old folder:  rm -rf $(dirname "$old")"
    exit 0
  fi
  sleep 5
done
echo "WA Reach did not answer yet. See: cd $new && docker compose logs --tail 50 wa-reach"
exit 1
