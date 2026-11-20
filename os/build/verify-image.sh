#!/usr/bin/env bash
# ============================================================
# MinerOS 镜像自检
# 用法: verify-image.sh path/to/mineros-1.0.0-amd64.iso
# 检查项：
#   1. ISO 是混合启动镜像（BIOS + UEFI）
#   2. squashfs 内包含采集端 / Node / systemd 单元 / 首启脚本
#   3. systemd 单元格式正确
#   4. 关键脚本有可执行位
# ============================================================
set -uo pipefail

ISO="${1:-}"
[ -n "$ISO" ] || { echo "用法: $0 <iso>"; exit 2; }
[ -f "$ISO" ] || { echo "文件不存在: $ISO"; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAIL=0
ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
warn() { echo "  ! $*"; }

echo "== 镜像 =="
echo "  文件: $ISO"
echo "  大小: $(du -h "$ISO" | cut -f1)"
echo "  SHA256: $(sha256sum "$ISO" | cut -d' ' -f1)"

# ---------- 1. 启动结构 ----------
echo "== 启动结构 =="
if grep -aq "ISOLINUX" "$ISO" 2>/dev/null; then ok "检测到 ISOLINUX（BIOS 启动）"; else bad "未检测到 ISOLINUX"; fi
if grep -aq "EFI/BOOT" "$ISO" 2>/dev/null; then ok "检测到 EFI/BOOT（UEFI 启动）"; else warn "未直接检测到 EFI/BOOT（可能在 El Torito 镜像中）"; fi
if command -v xorriso >/dev/null 2>&1; then
  xorriso -indev "$ISO" -report_el_torito plain 2>/dev/null | grep -q "El Torito" && ok "El Torito 引导记录存在" || warn "未检测到 El Torito 记录"
fi

# ---------- 2. 提取 squashfs ----------
echo "== 提取文件系统 =="
mkdir -p "$WORK/iso"
if command -v xorriso >/dev/null 2>&1; then
  xorriso -osirrox on -indev "$ISO" -extract /live "$WORK/iso/live" >/dev/null 2>&1 || true
fi
SQ="$(find "$WORK/iso" -name 'filesystem.squashfs' | head -n1)"
if [ -z "$SQ" ]; then
  warn "无法从 ISO 提取 squashfs（缺少 xorriso 或镜像结构不同），跳过内容检查"
  exit "$FAIL"
fi
ok "找到 $(basename "$SQ")（$(du -h "$SQ" | cut -f1)）"

LIST="$WORK/list.txt"
if ! unsquashfs -l "$SQ" > "$LIST" 2>/dev/null; then
  warn "unsquashfs 不可用，跳过内容检查"
  exit "$FAIL"
fi

check_file() {
  if grep -qxF "$1" "$LIST"; then ok "存在 $1"; else bad "缺少 $1"; fi
}
echo "== 关键文件 =="
check_file "/opt/mineros/agent/agent.js"
check_file "/opt/mineros/shared/miners.js"
check_file "/opt/mineros/node/bin/node"
check_file "/opt/mineros/tools/status-panel.js"
check_file "/opt/mineros/tools/lan-console.js"
check_file "/usr/local/bin/mineros-firstboot.sh"
check_file "/usr/local/bin/mineros-update.sh"
check_file "/usr/local/bin/mineros-status"
check_file "/etc/systemd/system/mineros-agent.service"
check_file "/etc/systemd/system/mineros-firstboot.service"
check_file "/etc/systemd/system/mineros-console.service"
check_file "/etc/systemd/system/mineros-panel.service"
check_file "/etc/systemd/system/mineros-update.timer"
check_file "/etc/mineros-release"
check_file "/etc/mineros/version"

# ---------- 3. systemd 单元语法 ----------
echo "== systemd 单元 =="
for unit in mineros-agent.service mineros-firstboot.service mineros-console.service mineros-panel.service mineros-update.service mineros-update.timer; do
  if unsquashfs -cat "$SQ" "/etc/systemd/system/$unit" 2>/dev/null > "$WORK/unit" && [ -s "$WORK/unit" ]; then
    if grep -q '^\[' "$WORK/unit" && grep -qE '^(Description|ExecStart)=' "$WORK/unit"; then
      ok "$unit 格式正确"
    else
      bad "$unit 缺少 Description/ExecStart"
    fi
  else
    bad "$unit 缺失"
  fi
done

# ---------- 4. 脚本权限 ----------
echo "== 可执行权限 =="
while IFS= read -r line; do
  case "$line" in
    *mineros-*.sh*|*mineros-status*|*status-panel.js*|*lan-console.js*)
      # unsquashfs -l 输出形如: squashfs-root/usr/local/bin/mineros-firstboot.sh
      perms="$(printf '%s' "$line" | awk '{print $1}')"
      case "$perms" in
        *x*) ;;
      esac
      ;;
  esac
done < "$LIST"

# 用 unsquashfs -ll 检查具体权限
unsquashfs -ll "$SQ" 2>/dev/null | grep -E "mineros-(firstboot|update|status)|status-panel\.js|lan-console\.js" | while read -r perms _rest; do
  case "$perms" in
    -rwx*|lrwx*|*x*) echo "  ✓ 可执行: $perms $(echo "$_rest" | tail -n1)" ;;
    *) echo "  ! 缺少可执行位: $perms" ;;
  esac
done

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "✅ 自检通过"
else
  echo "❌ 自检发现 $FAIL 项问题"
fi
exit "$FAIL"
