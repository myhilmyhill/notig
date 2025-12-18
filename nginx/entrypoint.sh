#!/bin/sh
set -e

IS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then
  IS_ROOT=1
  TARGET_USER=${TARGET_USER:-notig}
  TARGET_GROUP=${TARGET_GROUP:-notig}
else
  TARGET_USER=${TARGET_USER:-$(id -un 2>/dev/null || echo notig)}
  TARGET_GROUP=${TARGET_GROUP:-$(id -gn 2>/dev/null || echo notig)}
fi

SKIP_CHOWN=${SKIP_CHOWN:-0}
FCGI_SOCKET_DIR=${FCGI_SOCKET_DIR:-/tmp/fcgiwrap}
FCGI_SOCKET=${FCGI_SOCKET_DIR}/fcgiwrap.sock

ensure_dir() {
  dir="$1"
  mkdir -p "$dir"
  if [ "$IS_ROOT" -eq 1 ] && [ "$SKIP_CHOWN" -eq 0 ]; then
    chown -R "$TARGET_USER:$TARGET_GROUP" "$dir" 2>/dev/null || echo "warn: chown $dir skipped (permission denied)" >&2
  fi
}

ensure_dir "$FCGI_SOCKET_DIR"
ensure_dir /data/repos

enable_receive_pack() {
  # Allow pushes over Smart HTTP; backend defaults to deny.
  if [ "$IS_ROOT" -eq 1 ]; then
    su -s /bin/sh -c "git config --global http.receivepack true" "$TARGET_USER" || true
  else
    git config --global http.receivepack true || true
  fi

  if [ -d /data/repos/notig.git ]; then
    if [ "$IS_ROOT" -eq 1 ]; then
      su -s /bin/sh -c "git config --file /data/repos/notig.git/config http.receivepack true" "$TARGET_USER" || true
    else
      git config --file /data/repos/notig.git/config http.receivepack true || true
    fi
  fi
}

if [ ! -d /data/repos/notig.git ]; then
  echo "Initializing bare repo /data/repos/notig.git"
  if [ "$IS_ROOT" -eq 1 ]; then
    su -s /bin/sh -c "git init --bare /data/repos/notig.git --initial-branch=main >/dev/null" "$TARGET_USER"
  else
    git init --bare /data/repos/notig.git --initial-branch=main >/dev/null
  fi
fi

if [ "$IS_ROOT" -eq 1 ]; then
  su -s /bin/sh -c "git config --global --add safe.directory /data/repos/notig.git" "$TARGET_USER" || true
else
  git config --global --add safe.directory /data/repos/notig.git || true
fi

enable_receive_pack

if [ "$IS_ROOT" -eq 1 ]; then
  spawn-fcgi -s "$FCGI_SOCKET" -U "$TARGET_USER" -G "$TARGET_GROUP" /usr/bin/fcgiwrap
else
  spawn-fcgi -s "$FCGI_SOCKET" /usr/bin/fcgiwrap
fi

# Start nginx in the foreground.
exec nginx -g 'daemon off;'
