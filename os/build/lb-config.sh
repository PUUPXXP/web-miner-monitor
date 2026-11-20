#!/bin/sh
# ============================================================
# MinerOS live-build config entry (Debian 12 live-build 4.x)
# Target: Debian 12 (bookworm) amd64, BIOS + UEFI hybrid ISO
# Run from the live-build working directory (LB_WORKDIR overrides).
#
# Notes:
#   * LB_SECURITY=false: bookworm-security is shipped via
#     config/includes.chroot/etc/apt/sources.list instead.
#   * --bootloaders (plural) is the live-build 4.x option name.
# ============================================================
set -eu

cd "${LB_WORKDIR:-.}"

# squashfs 压缩算法：默认 xz（体积小），低配/内存紧张的构建机可用 MM_SQUASHFS=zstd
SQ_TYPE="${MM_SQUASHFS:-xz}"
# Debian 源：国外/国际带宽用 deb.debian.org；国内构建机可换镜像加速
MIRROR="${MM_MIRROR:-http://deb.debian.org/debian}"
MIRROR="${MIRROR%/}"
MIRROR_SEC="${MM_MIRROR_SEC:-}"
if [ -z "$MIRROR_SEC" ]; then
  case "$MIRROR" in
    *deb.debian.org*) MIRROR_SEC="http://security.debian.org/debian-security" ;;
    *)                MIRROR_SEC="${MIRROR%/debian}/debian-security" ;;
  esac
fi

echo ">>> lb config: MinerOS（squashfs=$SQ_TYPE, mirror=$MIRROR）"

lb config \
  --mode debian \
  --system live \
  --distribution bookworm \
  --parent-distribution bookworm \
  --distribution-chroot bookworm \
  --distribution-binary bookworm \
  --architectures amd64 \
  --binary-images iso-hybrid \
  --bootloaders "syslinux grub-efi" \
  --linux-flavours amd64 \
  --apt-indices false \
  --apt-options "--yes --no-install-recommends" \
  --apt-recommends false \
  --apt-secure true \
  --backports false \
  --security false \
  --updates true \
  --archive-areas "main contrib non-free non-free-firmware" \
  --firmware-chroot true \
  --mirror-bootstrap "$MIRROR/" \
  --mirror-chroot "$MIRROR/" \
  --mirror-chroot-security "$MIRROR_SEC/" \
  --mirror-binary "$MIRROR/" \
  --mirror-binary-security "$MIRROR_SEC/" \
  --memtest none \
  --debian-installer none \
  --debian-installer-gui false \
  --initsystem systemd \
  --initramfs live-boot \
  --compression xz \
  --chroot-squashfs-compression-type "$SQ_TYPE" \
  --image-name "mineros" \
  --iso-application "MinerOS" \
  --iso-publisher "MinerOS" \
  --iso-volume "MINEROS" \
  --iso-preparer "MinerOS build system" \
  --bootappend-live "boot=live components quiet splash noeject noprompt persistence persistence-encryption=none" \
  --verbose

echo ">>> lb config done"
