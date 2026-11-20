#!/bin/sh
# ============================================================
# 预填 live-build 的 Contents 缓存（兼容性修复）
#
# 背景：Ubuntu 的 live-build 3.x 会去下载
#   dists/<发行版>/Contents-<arch>.gz
# 而 Debian 12 的该文件在
#   dists/<发行版>/<component>/Contents-<arch>.gz
# 直接用会 404，导致 lb_chroot_linux-image 失败。
# 这里把各 component 的 Contents 合并后写入 cache，build 阶段会直接复用。
# ============================================================
set -eu

WORK="${1:-.}"
DIST="${2:-bookworm}"
ARCH="${3:-amd64}"
MIRROR="${4:-http://deb.debian.org/debian}"
COMPONENTS="${5:-main contrib non-free non-free-firmware}"

CACHE="$WORK/cache/contents.chroot"
mkdir -p "$CACHE"
TARGET="$CACHE/contents.${DIST}.${ARCH}"

if [ -s "$TARGET" ] && [ "$(wc -l < "$TARGET")" -gt 1000 ]; then
  echo ">>> Contents 缓存已存在（$(wc -l < "$TARGET") 行）"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

OUT="$TMP/contents.txt"
: > "$OUT"
GOT=0
for comp in $COMPONENTS; do
  url="$MIRROR/dists/$DIST/$comp/Contents-$ARCH.gz"
  if wget -q -O "$TMP/c.gz" "$url" 2>/dev/null && [ -s "$TMP/c.gz" ]; then
    gunzip -c "$TMP/c.gz" >> "$OUT" 2>/dev/null && GOT=$((GOT + 1))
    echo ">>> Contents: $comp"
  fi
done

if [ "$GOT" -eq 0 ] || [ ! -s "$OUT" ]; then
  echo ">>> 警告：无法获取 Contents（离线构建？），live-build 可能在内核安装步骤失败"
  exit 0
fi

cp "$OUT" "$TARGET"
echo ">>> Contents 缓存已写入：$(wc -l < "$TARGET") 行"
