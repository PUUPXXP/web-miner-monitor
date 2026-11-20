#!/bin/bash
# Helper: run a command inside the Debian 12 chroot (mounted proc/dev/sys)
# Usage: bash os/build/chroot-exec.sh <command...>
set -eu
R="${MM_CHROOT:-/root/mineros-bookworm}"
[ -d "$R" ] || { echo "chroot not found: $R"; exit 1; }

mountpoint -q "$R/proc" || mount -t proc proc "$R/proc" 2>/dev/null || true
mountpoint -q "$R/dev" || mount --bind /dev "$R/dev" 2>/dev/null || true
mountpoint -q "$R/dev/pts" || mount --bind /dev/pts "$R/dev/pts" 2>/dev/null || true

exec chroot "$R" /bin/bash -lc "$*"
