#!/bin/bash
# ============================================================
# 在服务器上构建 MinerOS ISO（Debian 12 chroot，增量复用）
#
# 设计目标：
#   * 不污染宿主机：只用 debootstrap/chroot，不往系统装 live-build
#   * 增量：chroot 与 live-build 缓存复用，第二次起快很多
#   * 可观测：状态写 status.json，控制台能看进度和日志
#   * 幂等：flock 防并发，失败可重试
#
# 用法（root）：
#   bash os/build/build-iso-server.sh [--force] [--no-clean]
#
# 产物：
#   <项目>/os/dist/mineros-<ver>-amd64.iso (+ .sha256)
#   <项目>/os/dist/os-image.json
# ============================================================
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_ROOT="${MM_BUILD_ROOT:-/var/lib/mineros-build}"
CHROOT_DIR="$BUILD_ROOT/chroot"
TOOLS_DIR="${MM_TOOLS_DIR:-/var/lib/mineros-build/tools}"
STATE_DIR="$BUILD_ROOT"
LOG_DIR="$STATE_DIR/logs"
STATUS_FILE="$STATE_DIR/status.json"
STAMP_FILE="$STATE_DIR/last-built-fp"
LOCK_FILE="$STATE_DIR/lock"
DIST_DIR="$PROJECT_DIR/os/dist"
CHROOT_PROJECT="/build/mineros"
NODE_VERSION="${NODE_VERSION:-v24.11.0}"
SQUASHFS_TYPE="${MM_SQUASHFS:-zstd}"   # zstd 比 xz 快很多、内存占用低；镜像略大
MIRROR="${MM_DEBIAN_MIRROR:-http://deb.debian.org/debian}"
FORCE=0
CLEAN_AFTER=1
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --keep-binaries) CLEAN_AFTER=0 ;;
  esac
done

mkdir -p "$STATE_DIR" "$LOG_DIR" "$DIST_DIR"
LOG_FILE="$LOG_DIR/build-$(date +%Y%m%d-%H%M%S).log"

# ---------- 状态输出 ----------
STATUS_STARTED=$(date +%s)
set_status() {
  local phase="$1" pct="$2" msg="$3"
  local now; now=$(date +%s)
  python3 - "$STATUS_FILE" "$phase" "$pct" "$msg" "$STATUS_STARTED" "$now" "$LOG_FILE" <<'PY' 2>/dev/null || true
import json, sys, os, datetime
path, phase, pct, msg, started, now, log = sys.argv[1:8]
d = {
    "state": phase,
    "percent": int(pct),
    "message": msg,
    "startedAt": int(started) * 1000,
    "updatedAt": int(now) * 1000,
    "elapsedSec": int(now) - int(started),
    "logFile": log,
}
tail = []
try:
    with open(log, "r", errors="replace") as f:
        tail = f.readlines()[-60:]
except Exception:
    pass
d["logTail"] = "".join(tail)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
os.replace(tmp, path)
PY
}
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }

fail() {
  set_status "error" 0 "$1"
  printf '\n\033[31m[FAIL] %s\033[0m\n' "$1" >&2
  exit 1
}

# 全程记录日志
exec > >(tee -a "$LOG_FILE") 2>&1

# ---------- 防并发 ----------
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "已有构建在运行，退出"
  exit 0
fi

START_TS=$(date +%s)
step "MinerOS 服务器构建开始 $(date -Is)"

# ---------- 0. 环境检查 ----------
command -v python3 >/dev/null || fail "缺少 python3"
command -v rsync >/dev/null || fail "缺少 rsync"
FREE_GB=$(df -BG --output=avail "$BUILD_ROOT" | tail -1 | tr -dc '0-9')
[ "${FREE_GB:-0}" -ge 12 ] || fail "磁盘不足：剩余 ${FREE_GB}GB，至少需要 12GB"

# ---------- 1. 源码指纹 ----------
SRC_FP=$(cd "$PROJECT_DIR" && find agent shared os scripts deploy web server -type f \
  -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.lbwork/*' \
  -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1)
echo "源码指纹: $SRC_FP"
PREV_FP=$(cat "$STAMP_FILE" 2>/dev/null || echo "")
ISO_PATH=$(ls -1 "$DIST_DIR"/mineros-*-amd64.iso 2>/dev/null | head -1)

if [ "$FORCE" != "1" ] && [ -n "$ISO_PATH" ] && [ "$SRC_FP" = "$PREV_FP" ]; then
  echo "源码未变化且已有镜像，跳过构建"
  set_status "done" 100 "源码未变化，沿用现有镜像"
  exit 0
fi

# ---------- 2. debootstrap 工具 ----------
DB_VERSION="1.0.145"
DB_EXE="$TOOLS_DIR/debootstrap/usr/sbin/debootstrap"
if [ ! -x "$DB_EXE" ]; then
  step "准备 debootstrap $DB_VERSION"
  mkdir -p "$TOOLS_DIR"
  curl -fsSL -m 120 -o "$TOOLS_DIR/debootstrap.deb" \
    "$MIRROR/pool/main/d/debootstrap/debootstrap_${DB_VERSION}_all.deb" \
    || fail "下载 debootstrap 失败"
  rm -rf "$TOOLS_DIR/debootstrap"
  dpkg-deb -x "$TOOLS_DIR/debootstrap.deb" "$TOOLS_DIR/debootstrap" || fail "解包 debootstrap 失败"
fi
[ -x "$DB_EXE" ] || fail "debootstrap 不可用"
export DEBOOTSTRAP_DIR="$TOOLS_DIR/debootstrap/usr/share/debootstrap"

# ---------- 3. chroot ----------
if [ ! -x "$CHROOT_DIR/bin/bash" ]; then
  step "debootstrap Debian 12（首次约 5-10 分钟）"
  set_status "preparing" 5 "创建 Debian 12 基础系统"
  rm -rf "$CHROOT_DIR"
  "$DB_EXE" --variant=minbase --include=ca-certificates,curl,gnupg,xz-utils \
    bookworm "$CHROOT_DIR" "$MIRROR" >>"$LOG_FILE" 2>&1 \
    || "$DB_EXE" --no-check-gpg --variant=minbase --include=ca-certificates,curl,gnupg,xz-utils \
         bookworm "$CHROOT_DIR" "$MIRROR" >>"$LOG_FILE" 2>&1 \
    || fail "debootstrap 失败，见日志"
fi

# chroot 内的 DNS
printf 'nameserver 223.5.5.5\nnameserver 1.1.1.1\n' > "$CHROOT_DIR/etc/resolv.conf"

mount_chroot() {
  mountpoint -q "$CHROOT_DIR/proc" || mount -t proc proc "$CHROOT_DIR/proc" 2>/dev/null || true
  mountpoint -q "$CHROOT_DIR/dev"  || mount --bind /dev "$CHROOT_DIR/dev" 2>/dev/null || true
  mountpoint -q "$CHROOT_DIR/dev/pts" || mount --bind /dev/pts "$CHROOT_DIR/dev/pts" 2>/dev/null || true
}
umount_chroot() {
  for m in "$CHROOT_DIR/dev/pts" "$CHROOT_DIR/dev" "$CHROOT_DIR/proc"; do
    mountpoint -q "$m" && umount -l "$m" 2>/dev/null || true
  done
}
trap 'umount_chroot' EXIT

# ---------- 4. 构建依赖（装一次即可）----------
PKG_MARK="$CHROOT_DIR/.build-deps-v2"
if [ ! -f "$PKG_MARK" ]; then
  step "安装构建依赖（live-build 等，首次约 5-10 分钟）"
  set_status "preparing" 12 "安装 live-build 与打包工具"
  chroot "$CHROOT_DIR" /bin/bash -c '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
      live-build debootstrap xorriso mtools dosfstools squashfs-tools \
      syslinux syslinux-common isolinux grub-pc-bin grub-efi-amd64-bin \
      rsync curl wget gnupg xz-utils zstd parted ca-certificates python3
  ' >>"$LOG_FILE" 2>&1 || fail "chroot 内安装依赖失败"
  touch "$PKG_MARK"
fi

# ---------- 5. 同步源码 ----------
step "同步源码到 chroot:$CHROOT_PROJECT"
set_status "preparing" 22 "同步源码"
mkdir -p "$CHROOT_DIR$CHROOT_PROJECT"
rsync -a --delete \
  --exclude '.git' --exclude 'data' --exclude 'node_modules' \
  --exclude 'os/dist' --exclude 'os/build/.lbwork' --exclude 'os/build/.lbtmp' \
  --exclude 'os/build/cache' --exclude 'tests/.work*' \
  "$PROJECT_DIR/" "$CHROOT_DIR$CHROOT_PROJECT/" || fail "同步源码失败"
chmod +x "$CHROOT_DIR$CHROOT_PROJECT"/os/build/*.sh 2>/dev/null || true
chmod +x "$CHROOT_DIR$CHROOT_PROJECT"/scripts/*.js 2>/dev/null || true

# ---------- 6. 离线 Node 包 ----------
NODE_TGZ="node-${NODE_VERSION}-linux-x64.tar.xz"
mkdir -p "$PROJECT_DIR/os/build/cache"
if [ ! -s "$PROJECT_DIR/os/build/cache/$NODE_TGZ" ]; then
  step "下载 Node $NODE_VERSION"
  set_status "preparing" 24 "下载 Node 运行时"
  ok=0
  for base in "https://cdn.npmmirror.com/binaries/node" "https://nodejs.org/dist" "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release"; do
    if curl -fsSL -m 180 -o "$PROJECT_DIR/os/build/cache/$NODE_TGZ" "$base/$NODE_VERSION/$NODE_TGZ" 2>/dev/null; then ok=1; break; fi
  done
  [ "$ok" = "1" ] || fail "下载 Node 失败"
fi
mkdir -p "$CHROOT_DIR$CHROOT_PROJECT/os/build/cache"
cp -f "$PROJECT_DIR/os/build/cache/$NODE_TGZ" "$CHROOT_DIR$CHROOT_PROJECT/os/build/cache/" 2>/dev/null || true

# ---------- 7. 构建 ----------
mount_chroot
step "live-build 构建（这一步最久，40-90 分钟）"
set_status "building" 28 "live-build 构建中"

# 后台把 live-build 阶段名映射成进度
(
  LAST=0
  while sleep 15; do
    if [ -f "$CHROOT_DIR$CHROOT_PROJECT/os/build/.lbwork/build.log" ]; then
      STAGE=$(grep -oE 'lb_(chroot|binary)_[a-z-]+' "$CHROOT_DIR$CHROOT_PROJECT/os/build/.lbwork/build.log" 2>/dev/null | tail -1)
      N=$(grep -cE '^\[[0-9]{4}-' "$CHROOT_DIR$CHROOT_PROJECT/os/build/.lbwork/build.log" 2>/dev/null || echo 0)
      PCT=$(( 28 + (N > 55 ? 55 : N) ))
      [ "$PCT" -lt 28 ] && PCT=28
      set_status "building" "$PCT" "构建中：${STAGE:-准备}"
    fi
    kill -0 $$ 2>/dev/null || break
  done
) &
PROGRESS_PID=$!

BUILD_RC=0
chroot "$CHROOT_DIR" /bin/bash -lc \
  "cd '$CHROOT_PROJECT' && MM_SQUASHFS='$SQUASHFS_TYPE' bash os/build/build.sh" \
  >>"$LOG_FILE" 2>&1 || BUILD_RC=$?
kill "$PROGRESS_PID" 2>/dev/null || true

if [ "$BUILD_RC" != "0" ]; then
  umount_chroot
  fail "live-build 构建失败（退出码 $BUILD_RC），见 $LOG_FILE"
fi

# ---------- 7.5 后处理（补 Node / systemd / 首启脚本，重打包 ISO）----------
RAW_ISO=$(ls -1 "$CHROOT_DIR$CHROOT_PROJECT/os/dist/"mineros-*-amd64.iso 2>/dev/null | head -1)
[ -n "$RAW_ISO" ] || { umount_chroot; fail "构建完成但没找到 ISO"; }
RAW_NAME=$(basename "$RAW_ISO")

step "后处理：注入采集端/Node/systemd 并重打包"
set_status "publishing" 86 "后处理并重打包 ISO"
POST_RC=0
chroot "$CHROOT_DIR" /bin/bash -lc \
  "cd '$CHROOT_PROJECT' && bash os/build/postprocess-iso.sh 'os/dist/$RAW_NAME' 'os/dist/$RAW_NAME'" \
  >>"$LOG_FILE" 2>&1 || POST_RC=$?
if [ "$POST_RC" != "0" ]; then
  umount_chroot
  fail "后处理失败（退出码 $POST_RC），见 $LOG_FILE"
fi

CHROOT_ISO="$CHROOT_DIR$CHROOT_PROJECT/os/dist/$RAW_NAME"
[ -f "$CHROOT_ISO" ] || { umount_chroot; fail "后处理后 ISO 不存在"; }

# ---------- 8. 发布产物 ----------
step "取回 ISO 并生成元数据"
set_status "publishing" 92 "复制 ISO 到下载目录"
ISO_NAME=$(basename "$CHROOT_ISO")
cp -f "$CHROOT_ISO" "$DIST_DIR/$ISO_NAME" || { umount_chroot; fail "复制 ISO 失败"; }
chmod 644 "$DIST_DIR/$ISO_NAME"

cd "$DIST_DIR"
SHA=$(sha256sum "$ISO_NAME" | cut -d' ' -f1)
printf '%s  %s\n' "$SHA" "$ISO_NAME" > "$ISO_NAME.sha256"

AGENT_VER=$(sed -n "s/.*AGENT_VERSION = '\([0-9.]*\)'.*/\1/p" "$PROJECT_DIR/shared/version.js" | head -1)
python3 - "$DIST_DIR/os-image.json" "$PROJECT_DIR" "$ISO_NAME" "$SHA" "$AGENT_VER" "$SRC_FP" "$LOG_FILE" <<'PY'
import json, os, sys, datetime
path, project, iso, sha, agent, fp, log = sys.argv[1:8]
iso_path = os.path.join(project, 'os/dist', iso)
st = os.stat(iso_path)
meta = {
    "version": "1.0.0",
    "agentVersion": agent,
    "base": "Debian 12 bookworm amd64",
    "file": iso,
    "size": st.st_size,
    "sha256": sha,
    "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "builtOn": "yl2025.cn build server (Debian 12 chroot, live-build 4.x)",
    "sourceFingerprint": fp,
    "buildLog": log,
    "features": [
        "BIOS+UEFI 双启动", "U 盘即插即跑", "NVIDIA 535 驱动内置", "数据分区持久化",
        "首启自动注册", "本地控制台 :4000",
        "在线升级（采集端/挖矿程序/系统组件）", "每 6 小时自动更新采集端",
    ],
}
with open(path, 'w') as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)
print(f"    {iso}  {st.st_size/1024/1024:.0f} MB")
print(f"    sha256 {sha}")
PY

chown -R minermon:minermon "$DIST_DIR" 2>/dev/null || true
echo "$SRC_FP" > "$STAMP_FILE"

# ---------- 9. 清理 ----------
if [ "$CLEAN_AFTER" = "1" ]; then
  step "清理中间产物（保留 chroot 与包缓存，下次更快）"
  rm -rf "$CHROOT_DIR$CHROOT_PROJECT/os/build/.lbwork/binary" 2>/dev/null || true
  rm -f "$CHROOT_DIR$CHROOT_PROJECT/os/dist/"*.iso 2>/dev/null || true
  rm -rf "$CHROOT_DIR/root/mineros-post" 2>/dev/null || true
fi

umount_chroot
ELAPSED=$(( $(date +%s) - START_TS ))
set_status "done" 100 "构建完成：$ISO_NAME（耗时 $((ELAPSED/60)) 分 $((ELAPSED%60)) 秒）"
step "完成，用时 $((ELAPSED/60)) 分 $((ELAPSED%60)) 秒"
