#!/usr/bin/env bash
set -Eeuo pipefail
trap 'echo "[ERROR] line=$LINENO command=$BASH_COMMAND"; journalctl -u mini-cpanel -n 120 --no-pager 2>/dev/null || true; exit 1' ERR

export DEBIAN_FRONTEND=noninteractive
APP="${APP:-/opt/mini-cpanel}"
REPO_URL="${REPO_URL:-https://github.com/rickeyward17653-max/momnz.git}"
PORT="${PORT:-3000}"
DOMAIN="${DOMAIN:-}"
INSTALL_CYBERPANEL="${INSTALL_CYBERPANEL:-1}"

if [[ $EUID -ne 0 ]]; then
  exec sudo APP="$APP" REPO_URL="$REPO_URL" PORT="$PORT" DOMAIN="$DOMAIN" INSTALL_CYBERPANEL="$INSTALL_CYBERPANEL" bash "$0" "$@"
fi

log(){ echo -e "\n==> $*"; }
IP="$(curl -fsS4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"

log "Install base packages"
apt-get update -y
apt-get install -y ca-certificates curl git gnupg lsb-release ufw nginx rsync openssl jq expect unzip tar gzip software-properties-common certbot python3-certbot-nginx

log "Install Node.js 20 from NodeSource only"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v20'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

log "Install Docker official with conflict recovery"
install_docker(){
  install -m 0755 -d /etc/apt/keyrings
  rm -f /etc/apt/keyrings/docker.gpg
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}
if ! command -v docker >/dev/null 2>&1; then
  apt-get remove -y docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc containerd.io docker-compose-plugin || true
  apt-get autoremove -y || true
  install_docker
fi
systemctl enable --now docker

log "Create persistent folders"
mkdir -p "$APP"/{backend,frontend,sites,backups,data,data/logs,releases,scripts,systemd}
chmod 700 "$APP/data"

log "Create or preserve credentials"
if [[ ! -f "$APP/data/env" ]]; then
  ADMIN_USER="admin"
  ADMIN_PASS="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9@#%+=' | head -c 20)"
  SESSION_SECRET="$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 64)"
  cat > "$APP/data/env" <<ENV
ADMIN_USER=$ADMIN_USER
ADMIN_PASS=$ADMIN_PASS
SESSION_SECRET=$SESSION_SECRET
PORT=$PORT
HOST=0.0.0.0
NODE_ENV=production
APP_DIR=$APP
PUBLIC_IP=$IP
ENV
  chmod 600 "$APP/data/env"
else
  set -a; . "$APP/data/env"; set +a
  ADMIN_USER="${ADMIN_USER:-admin}"
  ADMIN_PASS="${ADMIN_PASS:-see-env-file}"
  sed -i "s/^PORT=.*/PORT=$PORT/" "$APP/data/env" || true
  grep -q '^APP_DIR=' "$APP/data/env" || echo "APP_DIR=$APP" >> "$APP/data/env"
  grep -q '^PUBLIC_IP=' "$APP/data/env" && sed -i "s/^PUBLIC_IP=.*/PUBLIC_IP=$IP/" "$APP/data/env" || echo "PUBLIC_IP=$IP" >> "$APP/data/env"
fi

log "Clone repository release"
REL="$APP/releases/src-$(date +%Y%m%d-%H%M%S)"
git clone "$REPO_URL" "$REL"

log "Sync application without deleting data/sites/backups"
rsync -a --delete "$REL/backend/" "$APP/backend/"
rsync -a --delete "$REL/frontend/" "$APP/frontend/"
rsync -a --delete "$REL/scripts/" "$APP/scripts/" 2>/dev/null || true
rsync -a --delete "$REL/systemd/" "$APP/systemd/" 2>/dev/null || true

log "Backend dependencies"
cd "$APP/backend"
rm -f package-lock.json
npm install --omit=dev
node --check src/server.js

log "Frontend build"
cd "$APP/frontend"
rm -f package-lock.json
npm install
npm run build
mkdir -p "$APP/backend/public"
rsync -a --delete dist/ "$APP/backend/public/"

log "Install scripts"
chmod +x "$APP/scripts/"* 2>/dev/null || true
ln -sf "$APP/scripts/cpanel-update" /usr/local/bin/cpanel-update
ln -sf "$APP/scripts/cpanel-backup" /usr/local/bin/cpanel-backup
ln -sf "$APP/scripts/cpanel-status" /usr/local/bin/cpanel-status
ln -sf "$APP/scripts/cpanel-clean" /usr/local/bin/cpanel-clean
ln -sf "$APP/scripts/cyberpanel-install-safe" /usr/local/bin/cyberpanel-install-safe

log "Systemd service"
cat > /etc/systemd/system/mini-cpanel.service <<SERVICE
[Unit]
Description=Momnz VPS Panel PRO
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=$APP/backend
EnvironmentFile=$APP/data/env
Environment=NODE_ENV=production
Environment=PORT=$PORT
ExecStart=/usr/bin/node $APP/backend/src/server.js
Restart=always
RestartSec=3
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable mini-cpanel
systemctl restart mini-cpanel

log "Nginx reverse proxy"
rm -f /etc/nginx/sites-enabled/default
cat > /etc/nginx/sites-available/mini-cpanel <<NGINX
server {
    listen 80 default_server;
    server_name ${DOMAIN:-_};
    client_max_body_size 200M;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/mini-cpanel /etc/nginx/sites-enabled/mini-cpanel
nginx -t
systemctl enable nginx
systemctl restart nginx

log "Firewall"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow "$PORT"/tcp
ufw allow 8090/tcp
ufw --force enable

if [[ -n "$DOMAIN" ]]; then
  log "Try Let's Encrypt for domain"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" --redirect || echo "SSL skipped. Check A record."
fi

if [[ "$INSTALL_CYBERPANEL" == "1" ]]; then
  log "Install/Fix CyberPanel safe. If it fails, Mini Panel continues."
  "$APP/scripts/cyberpanel-install-safe" || echo "CyberPanel install failed; check $APP/data/logs/cyberpanel-install.log"
fi

log "Final tests"
sleep 4
systemctl is-active --quiet mini-cpanel
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null
curl -fsS "http://127.0.0.1/health" >/dev/null

LOGIN_FILE="$APP/data/login-info.txt"
cat > "$LOGIN_FILE" <<INFO
================ MOMNZ VPS PANEL PRO ================

Mini Panel URL:
  http://$IP
  http://$IP:$PORT

Mini Panel Login:
  Username: $ADMIN_USER
  Password: $ADMIN_PASS

CyberPanel:
  URL: https://$IP:8090
  Username: admin
  Password: xem log / chạy adminPass YOUR_NEW_PASSWORD nếu cần

Commands:
  cpanel-status
  cpanel-update
  cpanel-backup
  cpanel-clean
  cyberpanel-install-safe
  systemctl status mini-cpanel --no-pager
  journalctl -u mini-cpanel -n 120 --no-pager
  curl -fsS http://127.0.0.1:$PORT/health
  curl -fsS http://127.0.0.1/health

Security:
  File này tự xóa sau 30 giây.
  Mật khẩu thật vẫn ở $APP/data/env chmod 600.

======================================================
INFO
chmod 600 "$LOGIN_FILE"
cat "$LOGIN_FILE"
(sleep 30 && rm -f "$LOGIN_FILE") >/dev/null 2>&1 &

echo "✅ Done: http://$IP"
