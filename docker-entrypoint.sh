#!/bin/sh
# Run as PUID:PGID (default 1000:1000) so files written to /fonts and /data
# belong to you on the host. If the container is started with `user:`, the
# chown/drop steps are skipped and it runs as that user directly.
set -e
FONTS="${TYPESTASH_FONTS:-/fonts}"
DATA="${TYPESTASH_DATA:-/data}"

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  mkdir -p "$FONTS" "$DATA"
  # Our own state: always safe to own.
  chown -R "$PUID:$PGID" "$DATA"
  # Your fonts: never chown recursively, just make sure a fresh folder is writable.
  if [ -z "$(ls -A "$FONTS" 2>/dev/null)" ]; then chown "$PUID:$PGID" "$FONTS"; fi
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi
exec "$@"
