#!/usr/bin/env bash
set -euo pipefail

BUNDLED_INIT=/opt/mc-runtime/server-init.sh

pick_init_script() {
  if [ -x /data/server-init.sh ] && grep -q 'MC_SAVE_SUBDIR' /data/server-init.sh; then
    echo /data/server-init.sh
    return
  fi
  if [ -x "$BUNDLED_INIT" ]; then
    if [ -x /data/server-init.sh ]; then
      echo "[entrypoint] /data/server-init.sh is outdated (no MC_SAVE_SUBDIR); using bundled server-init.sh." >&2
    fi
    echo "$BUNDLED_INIT"
    return
  fi
  if [ -x /data/server-init.sh ]; then
    echo /data/server-init.sh
    return
  fi
  return 1
}

INIT_SCRIPT="$(pick_init_script)" || {
  echo "/data/server-init.sh is missing or not executable."
  echo "Keep this container running for manual inspection."
  sleep infinity
}

exec "$INIT_SCRIPT"
