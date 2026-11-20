#!/bin/sh
# ============================================================
# MinerOS 首次启动：从 U 盘读取 rig.conf，生成采集端配置
# 兼容 Hive OS 风格的 rig.conf（SERVER_URL / RIG_ID / RIG_PASSWD）
# ============================================================
set -eu

LOG=/var/log/mineros-firstboot.log
mkdir -p /var/log /etc/mineros /var/lib/mineros /opt/mineros/miners
exec >"$LOG" 2>&1
echo "=== MinerOS firstboot $(date -Is) ==="

# ---------- 数据分区：卷标 MINEROS-DATA 的 ext4 会挂到 /data ----------
# 作用：把「配置 + 采集端状态 + 已下载矿工」从根 overylay 分离，重刷镜像后仍保留
if [ -b /dev/disk/by-label/MINEROS-DATA ]; then
  mkdir -p /data
  if mount -t ext4 /dev/disk/by-label/MINEROS-DATA /data 2>/dev/null; then
    echo "数据分区已挂载到 /data"
    mkdir -p /data/state /data/miners /data/etc
    # 已有配置优先（重刷镜像后沿用）
    if [ -f /data/etc/agent.json ]; then
      cp /data/etc/agent.json /etc/mineros/agent.json
      echo "从数据分区恢复 agent.json"
    fi
    rm -rf /var/lib/mineros /opt/mineros/miners
    ln -sfn /data/state /var/lib/mineros
    ln -sfn /data/miners /opt/mineros/miners
    mkdir -p /var/lib/mineros /opt/mineros/miners
  else
    echo "数据分区挂载失败，使用内存持久化"
  fi
fi

# ---------- 解析 key=value ----------
cfg_get() {
  [ -f "$1" ] || return 0
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" | head -n1 | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//' -e 's/[[:space:]]*$//'
}

# ---------- 寻找包含 rig.conf 的分区 ----------
find_rig_conf() {
  for d in /media/* /media/*/* /run/media/*/* /mnt/* /boot /cdrom /opt/mineros/usb; do
    [ -d "$d" ] || continue
    if [ -f "$d/rig.conf" ]; then echo "$d/rig.conf"; return 0; fi
    if [ -f "$d/mineros/rig.conf" ]; then echo "$d/mineros/rig.conf"; return 0; fi
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
  cp "$RIG_CONF" /etc/mineros/rig.conf 2>/dev/null || true
else
  echo "未找到 rig.conf，将自动注册（需先在控制台开启自动注册）"
fi

SERVER_URL="${SERVER_URL:-${MM_DEFAULT_SERVER:-http://127.0.0.1:8787}}"
SERVER_URL="${SERVER_URL%/}"
[ -n "$SERVER_URL" ] || SERVER_URL="http://127.0.0.1:8787"

HOSTNAME_DEFAULT="$(cat /proc/sys/kernel/hostname 2>/dev/null || echo mineros)"
RIG_NAME="${RIG_NAME:-$HOSTNAME_DEFAULT}"
ALLOW_REBOOT="${ALLOW_REBOOT:-true}"
ALLOW_RUN="${ALLOW_RUN:-true}"

# 机器指纹：machine-id（持久化后保持不变）
MACHINE_ID="$(cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || echo unknown)"
FP="mm-linux-$(printf '%s' "$MACHINE_ID" | sha256sum | cut -c1-24)"

# ---------- 写 agent 配置 ----------
# 已有配置（数据分区恢复）则不覆盖服务器/密钥，只补全缺失字段
python3 - "$SERVER_URL" "$RIG_ID" "$RIG_PASSWD" "$RIG_NAME" "$FP" "$ALLOW_REBOOT" "$ALLOW_RUN" <<'PY'
import json, os, sys
server, rig_id, token, name, fp, reboot, run = sys.argv[1:8]
path = "/etc/mineros/agent.json"
cfg = {}
if os.path.exists(path):
    try:
        cfg = json.load(open(path))
    except Exception:
        cfg = {}
cfg.setdefault("serverUrl", server)
if rig_id:
    cfg["rigId"] = rig_id
if token:
    cfg["token"] = token
cfg.setdefault("name", name)
cfg.setdefault("workDir", "/var/lib/mineros")
cfg.setdefault("minerPath", "/opt/mineros/miners")
cfg.setdefault("intervalSec", 5)
cfg.setdefault("allowReboot", reboot.lower() != "false")
cfg.setdefault("allowRun", run.lower() != "false")
cfg.setdefault("allowUpdate", True)
cfg.setdefault("fingerprint", fp)
cfg["osImage"] = "MinerOS"
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
# 同步一份到数据分区，重刷镜像后可恢复
if os.path.isdir("/data/etc"):
    try:
        json.dump(cfg, open("/data/etc/agent.json", "w"), indent=2)
    except Exception:
        pass
print("已写入", path)
PY

# ---------- 安装采集端：U 盘离线包 > 服务器下载 ----------
install_agent() {
  for d in /media/* /media/*/* /run/media/*/* /mnt/*; do
    [ -f "$d/mineros-agent.tar.gz" ] || continue
    echo "离线安装采集端: $d/mineros-agent.tar.gz"
    if tar -xzf "$d/mineros-agent.tar.gz" -C /opt/mineros; then return 0; fi
  done
  echo "从服务器下载采集端: $SERVER_URL/api/agent/bundle"
  TMP="$(mktemp -d)"
  if curl -fsSL --max-time 120 "$SERVER_URL/api/agent/bundle" -o "$TMP/agent.zip"; then
    mkdir -p "$TMP/x"
    ( cd "$TMP/x" && unzip -q "$TMP/agent.zip" )
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
  if ! install_agent; then
    echo "采集端安装失败：请检查服务器地址/网络，或把 mineros-agent.tar.gz 放到 U 盘根目录后重启"
  fi
fi

# Node 由镜像内置（/opt/mineros/node/bin/node）
if [ ! -x /opt/mineros/node/bin/node ]; then
  echo "警告：镜像内未找到 Node.js"
fi

# ---------- 系统信息 ----------
cat > /etc/mineros-release <<EOF
MinerOS 1.0.0 (Debian 12 bookworm, amd64)
rig: $RIG_NAME
server: $SERVER_URL
EOF

# 控制台不休眠
setterm -blank 0 -powerdown 0 2>/dev/null || true

echo "=== firstboot 完成 ==="
