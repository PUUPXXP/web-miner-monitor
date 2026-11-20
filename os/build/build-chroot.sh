#!/bin/bash
# ============================================================
# 在 Debian 12 chroot 里构建 MinerOS（推荐：环境与目标发行版一致）
# 适用于：WSL2 Ubuntu / 任意 Ubuntu / Debian 主机
#
# 优点：
#   * 使用 Debian 12 自带的 live-build（4.x），不需要给 Ubuntu 版打补丁
#   * chroot 是干净的 bookworm，避免 Ubuntu 包/脚本差异
#
# 用法：
#   sudo bash os/build/build-chroot.sh            # 构建
#   sudo bash os/build/build-chroot.sh --clean    # 重新 debootstrap
# 产物：os/dist/mineros-1.0.0-amd64.iso
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS_DIR="$(cd "$HERE/.." && pwd)"
PROJECT_DIR="$(cd "$OS_DIR/.." && pwd)"
ROOTFS="${MM_CHROOT:-/root/mineros-bookworm}"
DIST="$OS_DIR/dist"
LOG="$OS_DIR/build/build-chroot.log"
VERSION="1.0.0"

CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

mkdir -p "$DIST" "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
log()  { printf '\033[36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[ERROR]\033[0m %s\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root（sudo）"
command -v debootstrap >/dev/null || die "缺少 debootstrap（apt install debootstrap）"

# ---------- 1. 准备 bookworm rootfs ----------
if [ "$CLEAN" = "1" ]; then
  log "清理旧 chroot: $ROOTFS"
  umount -R "$ROOTFS" 2>/dev/null || true
  rm -rf "$ROOTFS"
fi

if [ ! -x "$ROOTFS/bin/bash" ]; then
  log "debootstrap Debian 12 → $ROOTFS（首次约 3-8 分钟）"
  debootstrap --variant=minbase --include=ca-certificates,curl,gnupg,xz-utils \
    bookworm "$ROOTFS" http://deb.debian.org/debian/ || die "debootstrap 失败"
else
  log "复用已有 chroot: $ROOTFS"
fi

# ---------- 2. chroot 基础配置 ----------
cat > "$ROOTFS/etc/resolv.conf" <<'EOF'
nameserver 1.1.1.1
nameserver 8.8.8.8
nameserver 223.5.5.5
EOF
chroot "$ROOTFS" /bin/bash -c 'apt-get update -qq'
chroot "$ROOTFS" /bin/bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  live-build debootstrap xorriso mtools dosfstools squashfs-tools \
  syslinux syslinux-common isolinux grub-pc-bin grub-efi-amd64-bin \
  rsync curl wget gnupg xz-utils zstd parted ca-certificates python3' || die "chroot 内安装 live-build 失败"

# ---------- 3. 拷贝项目 ----------
SRC="$ROOTFS/build/mineros"
log "拷贝项目到 $SRC"
rm -rf "$SRC"
mkdir -p "$SRC"
cd "$PROJECT_DIR"
tar -cf - \
  --exclude='data' --exclude='.tools' --exclude='node_modules' --exclude='os/build/.lbwork' \
  --exclude='os/dist' --exclude='os/build/.lbtmp' \
  agent shared server web scripts tests tools os package.json README.md docs config.example.json 2>/dev/null \
  | tar -xf - -C "$SRC"
chmod +x "$SRC/os/build/"*.sh "$SRC/os/live-build/custom/overlay/hooks/"*.hook.chroot 2>/dev/null || true
chmod +x "$SRC/os/live-build/custom/overlay/includes.chroot/usr/local/bin/"* 2>/dev/null || true

# ---------- 4. chroot 内构建 ----------
log "在 Debian 12 chroot 内构建 MinerOS…"
set +e
chroot "$ROOTFS" /bin/bash -c "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd /build/mineros && bash os/build/build.sh"
RC=$?
set -e

if [ "$RC" -ne 0 ]; then
  die "构建失败（退出码 $RC），详见 $LOG"
fi

# ---------- 5. 取回产物 ----------
ISO="$(find "$ROOTFS/build/mineros/os/dist" -maxdepth 1 -name '*.iso' | head -n1)"
[ -n "$ISO" ] || die "chroot 内未找到 ISO"
OUT="$DIST/mineros-${VERSION}-amd64.iso"
cp -f "$ISO" "$OUT"
( cd "$DIST" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )

log "构建完成：$OUT（$(du -h "$OUT" | cut -f1)）"
cat "$OUT.sha256"
log "下一步：Windows 用 os/tools/flash-usb.ps1 烧录 U 盘"
