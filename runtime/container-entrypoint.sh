#!/usr/bin/env bash
set -euo pipefail

if [ ! -x /data/server-init.sh ]; then
  echo "/data/server-init.sh is missing or not executable."
  echo "Keep this container running for manual inspection."
  sleep infinity
fi

exec /data/server-init.sh
