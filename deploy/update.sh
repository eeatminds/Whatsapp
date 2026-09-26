#!/usr/bin/env bash
# Update a live server to the latest version on GitHub and restart with HTTPS.
#
#   bash deploy/update.sh              # update now
#   bash deploy/update.sh --if-changed # only rebuild when GitHub has something new (for cron)
#
# Automatic updates every 10 minutes (optional):
#   (crontab -l 2>/dev/null; echo "*/10 * * * * cd $PWD && bash deploy/update.sh --if-changed >> update.log 2>&1") | crontab -
set -euo pipefail
cd "$(dirname "$0")/.."

branch="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$branch"
if [ "${1:-}" = "--if-changed" ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch")" ]; then
  exit 0
fi

echo "$(date -u +%FT%TZ) updating to $(git rev-parse --short "origin/$branch")"
git merge --ff-only --quiet "origin/$branch"
compose=(docker compose -f docker-compose.yml)
[ -f docker-compose.prod.yml ] && grep -q '^DOMAIN=' .env 2>/dev/null && compose+=(-f docker-compose.prod.yml)
"${compose[@]}" up -d --build
docker image prune -f >/dev/null
echo "$(date -u +%FT%TZ) done"
