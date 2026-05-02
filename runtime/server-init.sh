#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
MC_DIR="${MC_DIR:-/data/mc}"
RUN_SCRIPT="${RUN_SCRIPT:-/data/mc/run.sh}"
MONITOR_SCRIPT="${MONITOR_SCRIPT:-/opt/mc-monitor/monitor.mjs}"
JAVA_XMS="${JAVA_XMS:-2G}"
JAVA_XMX="${JAVA_XMX:-12G}"

mkdir -p "$MC_DIR"
cd "$MC_DIR"

if [ ! -f server.properties ]; then
  echo "server.properties not found in $MC_DIR."
  echo "Place your migrated Minecraft server folder under /data/mc."
  sleep infinity
fi

if [ -n "${MINECRAFT_RCON_PASSWORD:-}" ]; then
  if grep -q '^enable-rcon=' server.properties; then
    sed -i 's/^enable-rcon=.*/enable-rcon=true/' server.properties
  else
    printf '\nenable-rcon=true\n' >> server.properties
  fi
  if grep -q '^rcon.port=' server.properties; then
    sed -i "s/^rcon.port=.*/rcon.port=${MINECRAFT_RCON_PORT:-25575}/" server.properties
  else
    printf 'rcon.port=%s\n' "${MINECRAFT_RCON_PORT:-25575}" >> server.properties
  fi
  if grep -q '^rcon.password=' server.properties; then
    sed -i "s/^rcon.password=.*/rcon.password=${MINECRAFT_RCON_PASSWORD}/" server.properties
  else
    printf 'rcon.password=%s\n' "$MINECRAFT_RCON_PASSWORD" >> server.properties
  fi
fi

if [ -f "$MONITOR_SCRIPT" ]; then
  node "$MONITOR_SCRIPT" &
  monitor_pid="$!"
  trap 'kill "$monitor_pid" 2>/dev/null || true' EXIT
fi

if [ -x "$RUN_SCRIPT" ]; then
  exec "$RUN_SCRIPT"
fi

jar_file="$(ls -1 *.jar 2>/dev/null | head -n 1 || true)"
if [ -z "$jar_file" ]; then
  echo "No executable run.sh or server jar found in $MC_DIR."
  sleep infinity
fi

exec java "-Xms${JAVA_XMS}" "-Xmx${JAVA_XMX}" -jar "$jar_file" nogui
