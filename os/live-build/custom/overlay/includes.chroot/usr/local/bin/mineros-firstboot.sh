#!/bin/sh
# ============================================================
# MinerOS 启动配置（每次启动执行，幂等）
# 1. 挂载 MINEROS-DATA 数据分区（若存在）
# 2. 从 U 盘读取 rig.conf（Hive OS 风格）
# 3. 生成 /etc/mineros/agent.json
# 4. 安装/更新采集端（U 盘离线包 > 服务器下载）
# ============================================================
# 不使用 set -e：任何一步失败都不应阻断 agent 启动

LOG=/var/log/mineros-firstboot.log
mkdir -p /var/log /etc/mineros /var/lib/mineros /opt/mineros/miners 2>/dev/null
exec >"$LOG" 2>&1
echo "=== MinerOS firstboot $(date -Is) ==="

# ---------- 1. 数据分区 ----------
if [ -b /dev/disk/by-label/MINEROS-DATA ]; then
  mkdir -p /data
  if mount -t ext4 /dev/disk/by-label/MINEROS-DATA /data 2>/dev/null; then
    echo "数据分区 /data 已挂载"
    mkdir -p /data/state /data/miners /data/etc
    if [ -f /data/etc/agent.json ]; then
      cp /data/etc/agent.json /etc/mineros/agent.json
      echo "从数据分区恢复 agent.json"
    fi
    rm -rf /var/lib/mineros /opt/mineros/miners
    ln -sfn /data/state /var/lib/mineros
    ln -sfn /data/miners /opt/mineros/miners
    mkdir -p /var/lib/mineros /opt/mineros/miners
  else
    echo "数据分区挂载失败，使用内存目录"
  fi
fi

# ---------- 2. 解析 rig.conf ----------
cfg_get() {
  [ -f "$1" ] || return 0
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" | head -n1 \
    | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//' -e 's/[[:space:]]*$//'
}

find_rig_conf() {
  for d in /media/* /media/*/* /run/media/*/* /mnt/* /opt/mineros/usb; do
    [ -d "$d" ] || continue
    [ -f "$d/rig.conf" ] && { echo "$d/rig.conf"; return 0; }
    [ -f "$d/mineros/rig.conf" ] && { echo "$d/mineros/rig.conf"; return 0; }
  done
  for dev in /dev/disk/by-label/MINEROS /dev/disk/by-label/MMBOOT; do
    [ -e "$dev" ] || continue
    mkdir -p /mnt/mmboot
    if mount -o ro "$dev" /mnt/mmboot 2>/dev/null; then
      if [ -f /mnt/mmboot/rig.conf ]; then echo /mnt/mmboot/rig.conf; return 0; fi
      umount /mnt/mmboot 2>/dev/null || true
    fi
  done
  return 0
}

RIG_CONF="$(find_rig_conf)"
SERVER_URL=""
RIG_ID=""
RIG_PASSWD=""
RIG_NAME=""
ALLOW_REBOOT="true"
ALLOW_RUN="true"

if [ -n "${RIG_CONF:-}" ]; then
  echo "找到配置: $RIG_CONF"
  SERVER_URL="$(cfg_get "$RIG_CONF" SERVER_URL)"
  RIG_ID="$(cfg_get "$RIG_CONF" RIG_ID)"
  RIG_PASSWD="$(cfg_get "$RIG_CONF" RIG_PASSWD)"
  RIG_NAME="$(cfg_get "$RIG_CONF" RIG_NAME)"
  ALLOW_REBOOT="$(cfg_get "$RIG_CONF" ALLOW_REBOOT)"
  ALLOW_RUN="$(cfg_get "$RIG_CONF" ALLOW_RUN)"
  cp "$RIG_CONF" /etc/mineros/rig.conf 2>/dev/null
else
  echo "未找到 rig.conf，将自动注册"
fi

SERVER_URL="${SERVER_URL:-${MM_DEFAULT_SERVER:-http://127.0.0.1:8787}}"
SERVER_URL="${SERVER_URL%/}"
RIG_NAME="${RIG_NAME:-$(cat /proc/sys/kernel/hostname 2>/dev/null || echo mineros)}"
ALLOW_REBOOT="${ALLOW_REBOOT:-true}"
ALLOW_RUN="${ALLOW_RUN:-true}"
MACHINE_ID="$(cat /etc/machine-id 2>/dev/null || echo unknown)"
FP="mm-linux-$(printf '%s' "$MACHINE_ID" | sha256sum | cut -c1-24)"

# ---------- 3. 写 agent.json（纯 shell，不依赖 python）----------
CFG=/etc/mineros/agent.json
if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<EOF
{
  "serverUrl": "$SERVER_URL",
  "token": "$RIG_PASSWD",
  "rigId": "$RIG_ID",
  "name": "$RIG_NAME",
  "workDir": "/var/lib/mineros",
  "minerPath": "/opt/mineros/miners",
  "intervalSec": 5,
  "allowReboot": $ALLOW_REBOOT,
  "allowRun": $ALLOW_RUN,
  "allowUpdate": true,
  "fingerprint": "$FP",
  "osImage": "MinerOS"
}
EOF
  echo "写入 $CFG"
else
  # 已有配置：用 rig.conf 覆盖服务器/密钥相关字段
  sed -i "s#\"serverUrl\":.*#\"serverUrl\": \"$SERVER_URL\",#" "$CFG"
  [ -n "$RIG_ID" ] && sed -i "s#\"rigId\":.*#\"rigId\": \"$RIG_ID\",#" "$CFG"
  [ -n "$RIG_PASSWD" ] && sed -i "s#\"token\":.*#\"token\": \"$RIG_PASSWD\",#" "$CFG"
  echo "更新 $CFG"
fi
[ -d /data/etc ] && cp "$CFG" /data/etc/agent.json 2>/dev/null

# ---------- 4. 安装采集端 ----------
install_agent() {
  for d in /media/* /media/*/* /run/media/*/* /mnt/*; do
    [ -f "$d/mineros-agent.tar.gz" ] || continue
    echo "离线安装采集端: $d/mineros-agent.tar.gz"
    if tar -xzf "$d/mineros-agent.tar.gz" -C /opt/mineros; then return 0; fi
  done
  echo "从服务器下载采集端: $SERVER_URL/api/agent/bundle"
  TMP="$(mktemp -d)"
  if curl -fsSL --max-time 60 "$SERVER_URL/api/agent/bundle" -o "$TMP/agent.zip"; then
    mkdir -p "$TMP/x"
    ( cd "$TMP/x" && unzip -q "$TMP/agent.zip" ) || true
    if [ -f "$TMP/x/agent/agent.js" ]; then
      cp -a "$TMP/x/agent/." /opt/mineros/agent/
      cp -a "$TMP/x/shared/." /opt/mineros/shared/
      echo 1.1.0 > /opt/mineros/VERSION
      rm -rf "$TMP"
      return 0
    fi
  fi
  rm -rf "$TMP"
  return 1
}

if [ ! -f /opt/mineros/agent/agent.js ]; then
  install_agent || echo "采集端安装失败（可稍后手动放入）"
fi

# ---------- 5. 其他 ----------
cat > /etc/mineros-release <<EOF
MinerOS 1.0.0 (Debian 12 bookworm, amd64)
rig: $RIG_NAME
server: $SERVER_URL
EOF
setterm -blank 0 -powerdown 0 2>/dev/null

echo "=== firstboot 完成 ==="
