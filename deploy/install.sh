#!/bin/bash
# ============================================================
# web-miner-monitor 一键部署脚本（Ubuntu / Debian）
#
# 用法（root）：
#   bash deploy/install.sh                        # 默认端口 32001，随机密码
#   bash deploy/install.sh --port 32001 --password 'MyPass123'
#   bash deploy/install.sh --uninstall            # 卸载（保留数据）
#
# 会在本机安装成 systemd 服务，开机自启、挂掉自动重启：
#   代码目录 /opt/web-miner-monitor
#   数据目录 /var/lib/web-miner-monitor
#   配置     /etc/web-miner-monitor.env   (chmod 600)
#   服务     web-miner-monitor.service
# ============================================================
set -euo pipefail

APP_USER="minermon"
APP_DIR="/opt/web-miner-monitor"
DATA_DIR="/var/lib/web-miner-monitor"
ENV_FILE="/etc/web-miner-monitor.env"
UNIT="/etc/systemd/system/web-miner-monitor.service"
PORT="32001"
ADMIN_USER="admin"
ADMIN_PASS=""
PUBLIC_URL=""
UNINSTALL=0
WITH_BUILD=0
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --password) ADMIN_PASS="$2"; shift 2 ;;
    --user) APP_USER="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --source-dir) SRC_DIR="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --with-iso-build) WITH_BUILD=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "请用 root 运行（sudo bash $0）"; exit 1; }

if [ "$UNINSTALL" = "1" ]; then
  echo "==> 停止并删除服务（保留 $DATA_DIR）"
  systemctl disable --now web-miner-monitor 2>/dev/null || true
  systemctl disable --now mineros-autobuild.timer 2>/dev/null || true
  systemctl stop mineros-build 2>/dev/null || true
  rm -f "$UNIT" /etc/systemd/system/mineros-build.service \
        /etc/systemd/system/mineros-autobuild.service \
        /etc/systemd/system/mineros-autobuild.timer \
        /etc/sudoers.d/web-miner-monitor-build
  systemctl daemon-reload
  echo "    已卸载。数据目录仍在：$DATA_DIR"
  echo "    构建缓存仍在：/var/lib/mineros-build（可手动删除）"
  exit 0
fi

# ---------- 1. 检查 Node ----------
command -v node >/dev/null || { echo "缺少 Node.js（需要 >= 22.5）：apt install -y nodejs 或 https://nodejs.org"; exit 1; }
NODE_VER=$(node -p "process.versions.node")
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 版本过低：$NODE_VER，需要 >= 22.5"
  exit 1
fi
echo "==> Node.js $NODE_VER"

# ---------- 2. 用户与目录 ----------
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
  echo "==> 已创建系统用户 $APP_USER"
fi
mkdir -p "$DATA_DIR/logs"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ---------- 3. 代码 ----------
echo "==> 安装代码到 $APP_DIR"
if [ ! -f "$SRC_DIR/server/app.js" ]; then
  echo "找不到源码：$SRC_DIR/server/app.js（用 --source-dir 指定仓库目录）"
  exit 1
fi
mkdir -p "$APP_DIR"
tar -cf - -C "$SRC_DIR" \
  --exclude='.git' --exclude='data' --exclude='node_modules' \
  --exclude='os/dist' --exclude='os/build/.lbwork' --exclude='os/build/cache' \
  . 2>/dev/null | tar -xf - -C "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod +x "$APP_DIR"/os/build/*.sh 2>/dev/null || true

# ---------- 4. 密码 ----------
if [ -z "$ADMIN_PASS" ]; then
  ADMIN_PASS=$(head -c 32 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 16)
  echo "==> 已生成管理员密码：$ADMIN_PASS"
fi
if [ -z "$PUBLIC_URL" ]; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  PUBLIC_URL="http://${IP:-127.0.0.1}:$PORT"
fi

# ---------- 5. 环境文件 ----------
umask 077
cat > "$ENV_FILE" <<EOF
MM_PORT=$PORT
MM_HOST=0.0.0.0
MM_ADMIN_USER=$ADMIN_USER
MM_ADMIN_PASSWORD=$ADMIN_PASS
MM_DATA_DIR=$DATA_DIR
MM_LOG_DIR=$DATA_DIR/logs
MM_PUBLIC_URL=$PUBLIC_URL
MM_AGENT_AUTO_REGISTER=true
EOF
chmod 600 "$ENV_FILE"
echo "==> 写入 $ENV_FILE"

# ---------- 6. systemd ----------
cat > "$UNIT" <<EOF
[Unit]
Description=Web Miner Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $APP_DIR/server/app.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=web-miner-monitor
NoNewPrivileges=true
PrivateTmp=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable web-miner-monitor >/dev/null 2>&1
systemctl restart web-miner-monitor
echo "==> 服务已启动"

# ---------- 6.5 镜像自动构建（可选） ----------
if [ "$WITH_BUILD" = "1" ]; then
  echo "==> 启用 MinerOS 镜像自动构建"
  BUILD_ROOT="/var/lib/mineros-build"
  mkdir -p "$BUILD_ROOT/logs"
  chmod 755 "$BUILD_ROOT"
  chmod 755 "$BUILD_ROOT/logs"

  for u in mineros-build.service mineros-autobuild.service mineros-autobuild.timer; do
    sed "s#/opt/web-miner-monitor#${APP_DIR}#g" "$APP_DIR/deploy/$u" > "/etc/systemd/system/$u"
  done
  chmod +x "$APP_DIR/os/build/build-iso-server.sh" "$APP_DIR/deploy/auto-build.sh" 2>/dev/null || true

  # 允许服务用户触发构建（只放行这两个 unit）
  SUDO_FILE="/etc/sudoers.d/web-miner-monitor-build"
  cat > "$SUDO_FILE" <<EOF
$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block mineros-build.service, /usr/bin/systemctl start mineros-build.service, /usr/bin/systemctl is-active mineros-build.service
EOF
  chmod 440 "$SUDO_FILE"
  visudo -cf "$SUDO_FILE" >/dev/null 2>&1 || { echo "    sudoers 校验失败，已回滚"; rm -f "$SUDO_FILE"; }

  systemctl daemon-reload
  systemctl enable --now mineros-autobuild.timer >/dev/null 2>&1
  echo "    已启用：每 10 分钟检查源码变化，自动重建"
  echo "    手动构建：systemctl start mineros-build"
fi

# ---------- 7. 健康检查 ----------
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    echo ""
    echo "================================================"
    echo " 部署完成"
    echo "   地址：$PUBLIC_URL"
    echo "   账号：$ADMIN_USER"
    echo "   密码：$ADMIN_PASS"
    echo "   日志：journalctl -u web-miner-monitor -f"
    echo "================================================"
    exit 0
  fi
  sleep 1
done

echo "启动失败，查看日志："
journalctl -u web-miner-monitor -n 40 --no-pager
exit 1
