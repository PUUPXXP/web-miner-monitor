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

echo ">>> lb config: MinerOS"

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
  --mirror-bootstrap "http://deb.debian.org/debian/" \
  --mirror-chroot "http://deb.debian.org/debian/" \
  --mirror-chroot-security "http://security.debian.org/debian-security/" \
  --mirror-binary "http://deb.debian.org/debian/" \
  --mirror-binary-security "http://security.debian.org/debian-security/" \
  --memtest none \
  --debian-installer none \
  --debian-installer-gui false \
  --initsystem systemd \
  --initramfs live-boot \
  --compression xz \
  --image-name "mineros" \
  --iso-application "MinerOS" \
  --iso-publisher "MinerOS" \
  --iso-volume "MINEROS" \
  --iso-preparer "MinerOS build system" \
  --bootappend-live "boot=live components quiet splash noeject noprompt persistence persistence-encryption=none" \
  --verbose

echo ">>> lb config done"
