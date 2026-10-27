#!/usr/bin/env bash
# Back up every business's data: to Google Drive (or any rclone remote), or only on this server.
#
#   bash deploy/backup.sh
#
# Google Drive: install rclone and create a remote called "gdrive" (see README, "Daily backups").
# This server only: put BACKUP_REMOTE=local in .env (no rclone needed). Copies go to backups/.
# Run daily at 02:30 server time:
#   (crontab -l 2>/dev/null; echo "30 2 * * * cd $PWD && bash deploy/backup.sh >> backup.log 2>&1") | crontab -
#
# Optional settings in .env:
#   BACKUP_REMOTE=gdrive:WA-Reach-backups   where to upload (rclone remote:folder), or "local"
#   BACKUP_KEEP_DAYS=14                     delete uploaded backups older than this
#   BACKUP_KEEP_LOCAL=7                     copies kept in backups/ (default 7 with "local", else 3)
#   BACKUP_PASSPHRASE=...                   encrypt each archive (keep this phrase safe; without it
#                                           the backup cannot be opened)
#   BACKUP_WHATSAPP_SESSIONS=no             yes = also back up WhatsApp logins (large; without them
#                                           numbers just scan the QR code again after a restore)
set -euo pipefail
umask 077  # archives hold every business's data and the .env secrets
cd "$(dirname "$0")/.."

# Read only BACKUP_* settings from .env, without executing the file.
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    case "$key" in BACKUP_*) export "$key=${value%$'\r'}" ;; esac
  done < <(grep -E '^BACKUP_[A-Z_]+=' .env || true)
fi
REMOTE="${BACKUP_REMOTE:-gdrive:WA-Reach-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
if [ "$REMOTE" = "local" ]; then KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-7}"; else KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-3}"; fi
[[ "$KEEP_LOCAL" =~ ^[1-9][0-9]*$ ]] || { echo "BACKUP_KEEP_LOCAL must be a number of copies, e.g. 7"; exit 1; }
compose=(docker compose -f docker-compose.yml)
app="$("${compose[@]}" ps -q wa-reach)"
[ -n "$app" ] || { echo "WA Reach is not running"; exit 1; }
node_cmd=(node --disable-warning=ExperimentalWarning dist/server/backup.js)

record() { "${compose[@]}" exec -T wa-reach "${node_cmd[@]}" record "$@" >/dev/null 2>&1 || true; }
trap 'record failed "Backup stopped at line $LINENO. See backup.log on the server."' ERR

if [ "$REMOTE" != "local" ] && ! command -v rclone >/dev/null; then
  record failed "rclone is not installed on the server"
  echo "rclone is not installed. See README, Daily backups."
  exit 1
fi

stamp="$(date -u +%Y%m%d-%H%M%S)"
work="backups/$stamp"
mkdir -p backups
echo "$(date -u +%FT%TZ) backup $stamp"

# 1. A consistent snapshot, taken by the running app (safe while it keeps working).
"${compose[@]}" exec -T wa-reach "${node_cmd[@]}" snapshot "/app/data/.backup/$stamp"
docker cp "$app:/app/data/.backup/$stamp" "$work"
"${compose[@]}" exec -T wa-reach rm -rf "/app/data/.backup/$stamp"

# 2. Settings (the app secret in .env is needed to read saved Meta tokens) and, optionally, WhatsApp logins.
cp .env "$work/env.txt"
if [ "${BACKUP_WHATSAPP_SESSIONS:-no}" = "yes" ]; then
  gateway="$("${compose[@]}" ps -q openwa)"
  [ -n "$gateway" ] && docker cp "$gateway:/app/data" "$work/openwa-data"
fi

# 3. One archive, encrypted when a passphrase is set.
archive="backups/wa-reach-$stamp.tar.gz"
tar czf "$archive" -C backups "$stamp"
rm -rf "$work"
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -salt -in "$archive" -out "$archive.enc" -pass env:BACKUP_PASSPHRASE
  rm -f "$archive"
  archive="$archive.enc"
fi
chmod 600 "$archive"

# 4. Upload (unless local only), prune old copies, keep the newest on the server.
if [ "$REMOTE" != "local" ]; then
  rclone copy "$archive" "$REMOTE"
  rclone delete "$REMOTE" --min-age "${KEEP_DAYS}d" --include "wa-reach-*" || true
fi
ls -1t backups/wa-reach-* 2>/dev/null | tail -n "+$((KEEP_LOCAL + 1))" | xargs -r rm -f

size="$(du -h "$archive" | cut -f1)"
record ok "$(basename "$archive") ($size)"
if [ "$REMOTE" = "local" ]; then
  echo "$(date -u +%FT%TZ) saved $archive ($size) on this server; keeping the newest $KEEP_LOCAL"
else
  echo "$(date -u +%FT%TZ) uploaded $(basename "$archive") ($size) to $REMOTE"
fi
