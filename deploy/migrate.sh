#!/usr/bin/env bash
# Move WA Reach to a new server, with every business's data and the WhatsApp logins.
#
# 1. On the OLD server:   bash deploy/migrate.sh export
#      Stops WA Reach here (so no message is sent twice) and writes ~/wa-reach-move.tar.gz with
#      .env, all data, the WhatsApp logins, the HTTPS certificate, the Google Drive backup login
#      and the WA Reach cron jobs (which are switched off here). It prints the next commands.
# 2. Copy it across:      scp ~/wa-reach-move.tar.gz root@NEW_SERVER_IP:~/
# 3. On the NEW server:   get the code with git clone (printed by step 1), then
#                         cd <repo>/wa-reach && bash deploy/migrate.sh import
# 4. Point the domain's DNS A record at the new server.
#
# If something goes wrong, start the old server again with: bash deploy/migrate.sh restart
set -euo pipefail
cd "$(dirname "$0")/.."
app="$(pwd)"
volumes=(wa-reach-data openwa-data caddy-data caddy-config)
# Chromium rebuilds these caches by itself; leaving them out keeps the file small.
cache_excludes=(--exclude '*/Cache' --exclude '*/Code Cache' --exclude '*/GPUCache')

compose=(docker compose -f docker-compose.yml)
[ -f docker-compose.prod.yml ] && grep -q '^DOMAIN=' .env 2>/dev/null && compose+=(-f docker-compose.prod.yml)
domain="$(grep -E '^DOMAIN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r"' || true)"

say() { printf '\n== %s\n' "$*"; }
need_docker() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not installed or not running. Install it with:"
    echo "  curl -fsSL https://get.docker.com | sh"
    exit 1
  fi
  docker image inspect alpine >/dev/null 2>&1 || docker pull -q alpine >/dev/null
}
volume_used() { docker run --rm -v "wa-reach_$1:/v:ro" alpine sh -c '[ -n "$(ls -A /v)" ]' 2>/dev/null; }
server_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }

export_all() {
  need_docker
  [ -f .env ] || { echo "No .env here; run this inside the wa-reach folder of the live server."; exit 1; }
  local url branch commit rel changed
  url="$(git remote get-url origin 2>/dev/null || true)"
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  commit="$(git rev-parse --short HEAD 2>/dev/null || true)"
  rel="$(git rev-parse --show-prefix 2>/dev/null || true)"
  rel="${rel%/}"
  changed="$(git status --porcelain --untracked-files=no 2>/dev/null || true)"
  if [ -n "$changed" ]; then
    echo "Note: these files were changed by hand on this server and will NOT move (the new server"
    echo "gets the code from GitHub). Copy them yourself if you need them:"
    printf '%s\n' "$changed" | sed 's/^/  /'
  fi
  if [ "${1:-}" != "--yes" ]; then
    echo "This STOPS WA Reach on this server (WhatsApp numbers, campaigns, lead links) until the"
    echo "new server takes over. Do it at a quiet time; it usually takes 10-30 minutes in total."
    read -r -p "Type yes to continue: " answer
    [ "$answer" = "yes" ] || { echo "Nothing changed."; exit 1; }
  fi
  trap 'echo; echo "Export failed. WA Reach is stopped here; start it again with: bash deploy/migrate.sh restart"' ERR

  say "Stopping WA Reach"
  "${compose[@]}" stop

  local work out kept
  work="$(mktemp -d "$HOME/wa-reach-move.XXXXXX")"
  mkdir "$work/wa-reach-move"
  local move="$work/wa-reach-move"

  say "Switching off WA Reach cron jobs on this server"
  if crontab -l 2>/dev/null | grep -qF 'deploy/'; then
    crontab -l | grep -F 'deploy/' > "$move/cron.txt"
    cp "$move/cron.txt" "$HOME/wa-reach-old-cron.txt"
    kept="$(crontab -l | grep -vF 'deploy/' || true)"
    printf '%s\n' "$kept" | sed '/^$/d' | crontab -
    sed 's/^/  off: /' "$move/cron.txt"
  else
    echo "  none"
  fi

  say "Copying data"
  cp .env "$move/env"
  for v in "${volumes[@]}"; do
    if docker volume inspect "wa-reach_$v" >/dev/null 2>&1; then
      docker run --rm -v "wa-reach_$v:/v:ro" -v "$move:/out" alpine tar cf "/out/$v.tar" "${cache_excludes[@]}" -C /v .
      echo "  $v: $(du -h "$move/$v.tar" | cut -f1)"
    fi
  done
  local rclone_conf
  rclone_conf="$(rclone config file 2>/dev/null | tail -1 || true)"
  rclone_conf="${rclone_conf:-$HOME/.config/rclone/rclone.conf}"
  if [ -f "$rclone_conf" ]; then cp "$rclone_conf" "$move/rclone.conf" && echo "  Google Drive backup login"; fi
  printf 'from=%s\nurl=%s\nbranch=%s\ncommit=%s\ndir=%s\nat=%s\n' "$(hostname)" "$url" "$branch" "$commit" "$rel" "$(date -u +%FT%TZ)" > "$move/manifest"

  say "Packing"
  out="$HOME/wa-reach-move.tar.gz"
  (umask 077 && tar czf "$out" -C "$work" wa-reach-move)
  rm -rf "$work"
  trap - ERR

  local repo="${url##*/}"
  repo="${repo%.git}"
  cat <<EOF

Done: $out ($(du -h "$out" | cut -f1)). It holds passwords and customer data; delete it once the move works.

Next, from THIS server, copy it to the new one (type the new server's root password when asked):
  scp $out root@NEW_SERVER_IP:~/

Then on the NEW server:
  git clone --depth 1 -b ${branch:-<branch>} ${url:-<repository url>} ~/${repo:-<repo>}
  cd ~/${repo:-<repo>}${rel:+/$rel} && bash deploy/migrate.sh import

To undo and run here again instead: bash deploy/migrate.sh restart
EOF
}

import_all() {
  local archive="$HOME/wa-reach-move.tar.gz" force=""
  for arg in "$@"; do
    case "$arg" in
      --force) force=1 ;;
      *) archive="$arg" ;;
    esac
  done
  [ -f "$archive" ] || { echo "Can't find $archive. Copy it here from the old server first (see 'export')."; exit 1; }
  need_docker

  for v in "${volumes[@]}"; do
    if docker volume inspect "wa-reach_$v" >/dev/null 2>&1 && volume_used "$v" && [ -z "$force" ]; then
      echo "This server already has WA Reach data ($v). Refusing to overwrite it."
      echo "If you are sure, run: bash deploy/migrate.sh import --force"
      exit 1
    fi
  done

  local move
  import_work="$(mktemp -d "$HOME/wa-reach-import.XXXXXX")"
  trap 'rm -rf "$import_work"' EXIT
  local work="$import_work"
  say "Unpacking $archive"
  tar xzf "$archive" -C "$work"
  move="$work/wa-reach-move"
  [ -f "$move/env" ] || { echo "That file is not a WA Reach move file."; exit 1; }
  local their_commit ours
  their_commit="$(sed -n 's/^commit=//p' "$move/manifest")"
  ours="$(git rev-parse --short HEAD 2>/dev/null || true)"
  if [ -n "$their_commit" ] && [ -n "$ours" ] && [ "$their_commit" != "$ours" ]; then
    echo "  Note: the old server ran version $their_commit, this copy is $ours (newer code is fine)."
  fi

  if [ -f .env ] && ! cmp -s .env "$move/env"; then
    cp .env ".env.before-move"
    echo "  Kept your previous .env as .env.before-move"
  fi
  install -m 600 "$move/env" .env
  domain="$(grep -E '^DOMAIN=' .env | head -1 | cut -d= -f2- | tr -d '\r"' || true)"
  compose=(docker compose -f docker-compose.yml)
  [ -f docker-compose.prod.yml ] && [ -n "$domain" ] && compose+=(-f docker-compose.prod.yml)

  say "Restoring data"
  "${compose[@]}" down >/dev/null 2>&1 || true
  for v in "${volumes[@]}"; do
    [ -f "$move/$v.tar" ] || continue
    docker volume inspect "wa-reach_$v" >/dev/null 2>&1 ||
      docker volume create --label com.docker.compose.project=wa-reach --label "com.docker.compose.volume=$v" "wa-reach_$v" >/dev/null
    docker run --rm -v "wa-reach_$v:/v" -v "$move:/in:ro" alpine sh -c "find /v -mindepth 1 -delete && tar xf /in/$v.tar -C /v"
    echo "  $v"
  done

  if [ -f "$move/rclone.conf" ] && [ ! -f "$HOME/.config/rclone/rclone.conf" ]; then
    mkdir -p "$HOME/.config/rclone"
    install -m 600 "$move/rclone.conf" "$HOME/.config/rclone/rclone.conf"
    echo "  Google Drive backup login"
  fi

  # Room for more QR-linked numbers on a bigger server: give OpenWA all but ~2 GB of the RAM.
  if ! grep -q '^OPENWA_MEM_LIMIT=' .env; then
    local total_gb limit
    total_gb=$(( ($(awk '/MemTotal/ {print $2}' /proc/meminfo) + 524288) / 1048576 ))
    limit=$(( total_gb > 4 ? total_gb - 2 : 2 ))
    printf '\n# Memory for WhatsApp numbers (~300-500 MB each), set by migrate.sh for this server.\nOPENWA_MEM_LIMIT=%sg\n' "$limit" >> .env
    echo "  OPENWA_MEM_LIMIT=${limit}g (this server has about ${total_gb} GB of RAM)"
  fi

  say "Starting WA Reach (the first build takes a few minutes)"
  "${compose[@]}" up -d --build
  docker image prune -f >/dev/null

  if [ -f "$move/cron.txt" ]; then
    say "Turning on cron jobs"
    local current line
    current="$(crontab -l 2>/dev/null || true)"
    while IFS= read -r line; do
      line="$(printf '%s' "$line" | sed -E "s#cd [^ ]+ &&#cd $app \&\&#")"
      grep -qxF "$line" <<<"$current" || current="$current"$'\n'"$line"
      echo "  $line"
    done < "$move/cron.txt"
    printf '%s\n' "$current" | sed '/^$/d' | crontab -
    if grep -qF 'backup.sh' "$move/cron.txt" && ! command -v rclone >/dev/null; then
      echo "  Daily backups need rclone on this server too: curl https://rclone.org/install.sh | sudo bash"
    fi
  fi

  say "Checking"
  local port="${WA_REACH_PORT:-3000}" ok=""
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then ok=1 && break; fi
    sleep 5
  done
  if [ -n "$ok" ]; then echo "  WA Reach is running."; else echo "  WA Reach did not answer yet. See: docker compose logs --tail 50 wa-reach"; fi
  local ip
  ip="$(server_ip)"
  cat <<EOF

Last step: in your domain's DNS, set the A record for ${domain:-your domain} to this server's IP${ip:+ ($ip; check it matches the IP in your hosting panel)}.
Once it points here, https://${domain:-your-domain} works as before (allow up to an hour for DNS).
When everything works, delete the move file (it holds passwords and customer data):
  rm ~/wa-reach-move.tar.gz
EOF
}

case "${1:-}" in
  export) shift; export_all "$@" ;;
  import) shift; import_all "$@" ;;
  restart)
    docker info >/dev/null 2>&1 || { echo "Docker is not running."; exit 1; }
    "${compose[@]}" up -d
    if [ -f "$HOME/wa-reach-old-cron.txt" ]; then
      current="$(crontab -l 2>/dev/null || true)"
      printf '%s\n%s\n' "$current" "$(cat "$HOME/wa-reach-old-cron.txt")" | sed '/^$/d' | crontab -
      rm "$HOME/wa-reach-old-cron.txt"
    fi
    echo "WA Reach is running on this server again."
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
