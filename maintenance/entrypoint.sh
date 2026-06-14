#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
NGINX_PATH="${MAINTENANCE_NGINX_PATH:-/nRxcU/filedownload}"
TIMEOUT_MIN="${MAINTENANCE_TIMEOUT_MINUTES:-60}"
# Safety net beyond the control-plane release window, in case the control plane is unreachable.
SELF_DESTRUCT_EXTRA_MIN="${MAINTENANCE_SELF_DESTRUCT_EXTRA_MINUTES:-10}"

mkdir -p "$DATA_DIR"

# --- SSH setup -------------------------------------------------------------
mkdir -p /run/sshd /root/.ssh
chmod 700 /root/.ssh

if [ -n "${SSH_AUTHORIZED_KEYS:-}" ]; then
  printf '%s\n' "$SSH_AUTHORIZED_KEYS" > /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  echo "[maintenance] Installed authorized_keys for root."
fi

# Generate a random password without tripping 'set -o pipefail' (head closes the pipe early).
gen_pw() {
  ( set +o pipefail; tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16 )
}

if [ -n "${SSH_ROOT_PASSWORD:-}" ]; then
  ROOT_PW="$SSH_ROOT_PASSWORD"
  echo "[maintenance] Using SSH_ROOT_PASSWORD for root."
else
  ROOT_PW="$(gen_pw)"
  echo "[maintenance] ==============================================="
  echo "[maintenance] Generated root SSH password: ${ROOT_PW}"
  echo "[maintenance] (set SSH_ROOT_PASSWORD or SSH_AUTHORIZED_KEYS to override)"
  echo "[maintenance] ==============================================="
fi
echo "root:${ROOT_PW}" | chpasswd

sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
ssh-keygen -A

# --- nginx setup: list and download files under $DATA_DIR ------------------
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
cat > /etc/nginx/conf.d/filedownload.conf <<EOF
server {
    listen 80 default_server;
    server_name _;

    location ${NGINX_PATH}/ {
        alias ${DATA_DIR}/;
        autoindex on;
        autoindex_exact_size off;
        autoindex_localtime on;
    }

    location = / {
        return 302 ${NGINX_PATH}/;
    }
}
EOF

echo "[maintenance] Data dir : ${DATA_DIR}"
echo "[maintenance] Download : http://<server-ip>${NGINX_PATH}/"
echo "[maintenance] Starting sshd (:22) and nginx (:80)..."

/usr/sbin/sshd
nginx

# --- Self-destruct safety net ---------------------------------------------
SELF_DESTRUCT_SEC=$(( (TIMEOUT_MIN + SELF_DESTRUCT_EXTRA_MIN) * 60 ))
echo "[maintenance] Container will self-exit after $((TIMEOUT_MIN + SELF_DESTRUCT_EXTRA_MIN)) minutes if not released earlier."
sleep "$SELF_DESTRUCT_SEC"

echo "[maintenance] Self-destruct timeout reached. Shutting down."
nginx -s stop 2>/dev/null || true
exit 0
