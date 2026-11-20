#!/bin/bash
# ============================================================
# 自动构建检查（由 systemd timer 每 10 分钟调用）
#
# 逻辑：
#   1. 算出当前源码指纹
#   2. 和上次构建成功的指纹比较
#   3. 不一样（或镜像缺失）就触发一次构建
#   4. 已经有构建在跑就跳过
# ============================================================
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_ROOT="${MM_BUILD_ROOT:-/var/lib/mineros-build}"
STAMP_FILE="$BUILD_ROOT/last-built-fp"
LOCK_FILE="$BUILD_ROOT/lock"
DIST_DIR="$PROJECT_DIR/os/dist"

[ -d "$BUILD_ROOT" ] || exit 0

# 正在构建？直接退出
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "构建进行中，跳过"
  exit 0
fi
exec 9>&-

SRC_FP=$(cd "$PROJECT_DIR" && find agent shared os scripts deploy web server -type f \
  -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.lbwork/*' \
  -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1)
PREV_FP=$(cat "$STAMP_FILE" 2>/dev/null || echo "")
ISO=$(ls -1 "$DIST_DIR"/mineros-*-amd64.iso 2>/dev/null | head -1)

if [ -n "$ISO" ] && [ "$SRC_FP" = "$PREV_FP" ]; then
  exit 0
fi

echo "源码有变化（或镜像缺失），触发构建"
echo "  当前: $SRC_FP"
echo "  上次: ${PREV_FP:-无}"
systemctl start mineros-build.service
