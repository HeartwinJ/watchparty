#!/bin/sh
# Nightly SQLite backup sidecar (see compose.yaml / DEPLOY.md).
# Uses SQLite's online backup API (sqlite3 .backup), which copies a consistent snapshot
# while the app keeps writing (WAL mode: readers don't block the writer).
set -eu

DB="${BACKUP_DB:-/data/watchparty.db}"
DEST="${BACKUP_DIR:-/data/backups}"
KEEP="${BACKUP_KEEP:-7}"
HOUR="${BACKUP_HOUR:-3}" # UTC hour of the nightly run

log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

backup() {
  mkdir -p "$DEST"
  if [ ! -f "$DB" ]; then
    log "no database at $DB yet, skipping"
    return 0
  fi
  ts="$(date -u +%Y%m%d-%H%M%S)"
  tmp="$DEST/.watchparty-$ts.db.partial"
  out="$DEST/watchparty-$ts.db"
  # .timeout waits for the app's write lock instead of failing with SQLITE_BUSY
  if sqlite3 "$DB" ".timeout 30000" ".backup '$tmp'" &&
    [ "$(sqlite3 "$tmp" 'PRAGMA integrity_check')" = "ok" ]; then
    mv "$tmp" "$out"
    log "wrote $out ($(wc -c <"$out") bytes)"
  else
    rm -f "$tmp"
    log "FAILED"
    return 1
  fi
  # Keep the newest $KEEP backups (names sort chronologically)
  ls -1 "$DEST"/watchparty-*.db 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" |
    while read -r old; do
      rm -f "$old"
      log "pruned $old"
    done
}

# Seconds until the next HOUR:00 UTC
seconds_until_next_run() {
  now="$(date -u +%s)"
  next="$(date -u -d "$(date -u +%Y-%m-%d) $(printf %02d "$HOUR"):00:00" +%s)"
  if [ "$next" -le "$now" ]; then
    next=$((next + 86400))
  fi
  echo $((next - now))
}

if [ "${1:-}" = "once" ]; then
  backup
  exit $?
fi

trap 'log "stopping"; exit 0' TERM INT

# Catch up right away if the newest backup is missing or older than a day
# (first start, or the stack was down during the nightly run)
latest="$(ls -1 "$DEST"/watchparty-*.db 2>/dev/null | sort -r | head -n 1 || true)"
if [ -z "$latest" ] || [ -n "$(find "$latest" -mmin +1440)" ]; then
  backup || true
fi

while true; do
  wait_s="$(seconds_until_next_run)"
  log "next backup in ${wait_s}s"
  # Background sleep + wait so SIGTERM is handled immediately
  sleep "$wait_s" &
  wait $!
  backup || true
done
