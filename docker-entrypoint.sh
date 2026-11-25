#!/bin/sh
# Runs as root only long enough to make the data directory writable by the app user,
# then drops privileges. This avoids "unable to open database file" when the host's
# ./data bind mount was created by Docker (root-owned) or never chown'ed.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
APP_UID=1000
APP_GID=1000

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only fix what's wrong, so a large data dir isn't re-chowned on every start
  if [ "$(stat -c %u "$DATA_DIR")" != "$APP_UID" ]; then
    echo "entrypoint: fixing ownership of $DATA_DIR (was uid $(stat -c %u "$DATA_DIR"))"
    chown -R "$APP_UID:$APP_GID" "$DATA_DIR" || true
  fi
  if ! su-exec node test -w "$DATA_DIR"; then
    echo "entrypoint: ERROR: $DATA_DIR is not writable by uid $APP_UID." >&2
    echo "entrypoint: On SELinux hosts add ':z' to the ./data volume in compose.yaml." >&2
    exit 1
  fi
  exec su-exec node "$@"
fi

# Already non-root (e.g. started with --user): just check and run
if [ ! -w "$DATA_DIR" ]; then
  echo "entrypoint: ERROR: $DATA_DIR is not writable by uid $(id -u)." >&2
  exit 1
fi
exec "$@"
