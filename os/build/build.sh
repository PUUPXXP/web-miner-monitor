#!/usr/bin/env bash
# ============================================================
# MinerOS 镜像构建（Debian live-build）
# 在 WSL2 / Docker / Debian/Ubuntu 主机上运行，需要 root 或 sudo
#
# 用法：
#   sudo ./build.sh                 # 完整构建
#   sudo ./build.sh --clean         # 先清理再构建
#   sudo ./build.sh --no-iso        # 只构建 chroot（调试用）
# 产物：dist/mineros-<version>-amd64.iso + .sha256
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS_DIR="$(cd "$HERE/.." && pwd)"          # os/
PROJECT_DIR="$(cd "$OS_DIR/.." && pwd)"   # web-miner-monitor/
LB_DIR="$OS_DIR/live-build"
DIST="$OS_DIR/dist"
CACHE="$OS_DIR/build/cache"
VERSION="1.0.0"
LOG="$OS_DIR/build/build.log"

CLEAN=0
NO_ISO=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --no-iso) NO_ISO=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
  esac
done

mkdir -p "$DIST" "$CACHE" "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1

log()  { printf '\033[36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[ERROR]\033[0m %s\n' "$*"; exit 1; }

# ---------- 环境检查 ----------
log "MinerOS 构建开始：$(date -Is)"
[ "$(id -u)" -eq 0 ] || die "需要 root 权限（WSL: sudo ./build.sh；Docker: 容器内为 root）"
[ -f /etc/debian_version ] || die "需要在 Debian/Ubuntu 系主机上构建（WSL2 安装的 Ubuntu 也可以）"
ARCH="$(dpkg --print-architecture)"
[ "$ARCH" = "amd64" ] || die "只支持 amd64 构建（当前 $ARCH）"

command -v lb >/dev/null 2>&1 || {
  log "安装 live-build 与依赖…"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    live-build debootstrap xorriso mtools dosfstools squashfs-tools \
    syslinux syslinux-common isolinux grub-pc-bin grub-efi-amd64-bin \
    rsync curl wget gnupg xz-utils zstd parted ca-certificates >/dev/null
}

for pkg in debootstrap xorriso mksquashfs; do
  command -v "$pkg" >/dev/null 2>&1 || die "缺少依赖 $pkg，请先安装"
done

# ---------- 预检：包名是否存在 ----------
log "预检软件包名（Debian 12 bookworm）…"
MISSING=""
while IFS= read -r line; do
  pkg="$(printf '%s' "$line" | sed 's/#.*//' | tr -d '[:space:]')"
  [ -n "$pkg" ] || continue
  if ! apt-cache show "$pkg" >/dev/null 2>&1; then MISSING="$MISSING $pkg"; fi
done < <(cat "$LB_DIR"/config/package-lists/*.list.chroot 2>/dev/null)
if [ -n "$MISSING" ]; then
  warn "以下包在当前源中不存在，构建可能失败：$MISSING"
  warn "（请检查 config/package-lists/*.list.chroot）"
fi

# ---------- 清理 ----------
if [ "$CLEAN" = "1" ]; then
  log "清理旧构建（lb clean）…"
  ( cd "$LB_DIR" && lb clean --purge ) || true
  rm -rf "$LB_DIR"/.build "$LB_DIR"/binary "$LB_DIR"/chroot 2>/dev/null || true
fi

# ---------- 放置采集端代码 ----------
# 自定义配置放在 os/live-build/custom/overlay，构建时再覆盖到工作目录的 config/，
# 避免 lb config 重置 config/common、hooks、includes.chroot 等文件。
log "准备自定义配置（overlay）…"
CUSTOM="$LB_DIR/custom/overlay"
[ -d "$CUSTOM" ] || die "缺少 $CUSTOM"

# 采集端代码同步到 overlay 的 includes.chroot
INC="$CUSTOM/includes.chroot"
mkdir -p "$INC/opt/mineros/agent" "$INC/opt/mineros/shared"
rsync -a --delete "$PROJECT_DIR/agent/" "$INC/opt/mineros/agent/"
rsync -a --delete "$PROJECT_DIR/shared/" "$INC/opt/mineros/shared/"
printf '%s\n' "1.1.0" > "$INC/opt/mineros/VERSION"

# 去掉 Windows 专用文件/日志（真实目录里不能有 agent-state/config/log）
find "$INC/opt/mineros" \( -name '*.log' -o -name 'agent-state.json' -o -name 'config.json' \) -delete 2>/dev/null || true

# 安装脚本 & systemd 单元可执行权限
chmod 755 "$INC/usr/local/bin/"mineros-*.sh 2>/dev/null || true
chmod -R u+rwX,go+rX "$INC/opt/mineros" 2>/dev/null || true

# ---------- 可选：离线 Node 包 ----------
# 放到镜像的 /root/，钩子 0150 会优先使用，避免构建时联网失败
if ls "$CACHE"/node-*-linux-x64.tar.xz >/dev/null 2>&1; then
  log "发现离线 Node 包，随镜像复制（/root/）"
  mkdir -p "$INC/root"
  cp "$CACHE"/node-*-linux-x64.tar.xz "$INC/root/" 2>/dev/null || true
fi

# ---------- 可选：离线矿工包 ----------
if [ -d "$CACHE/miners" ]; then
  log "发现离线矿工目录，复制到镜像"
  mkdir -p "$INC/opt/mineros/miners"
  cp -a "$CACHE/miners/." "$INC/opt/mineros/miners/"
fi

# ---------- 构建 ----------
# live-build 会把配置产物写到 $PWD/config。做法：
#   1) 先在一个临时目录里跑 lb config，生成完整骨架
#   2) 把骨架复制到工作目录，再叠加我们的自定义文件（overlay）
# 这样自定义配置不会被 lb config 重置。
WORK="$OS_DIR/build/.lbwork"
TMPCFG="$OS_DIR/build/.lbtmp"
log "准备构建目录 $WORK"
rm -rf "$WORK" "$TMPCFG"
mkdir -p "$TMPCFG"

log "生成 live-build 骨架…"
( cd "$TMPCFG" && bash "$HERE/lb-config.sh" ) || die "lb config 失败"

log "叠加自定义配置…"
cp -a "$TMPCFG" "$WORK"
rm -rf "$TMPCFG"
if [ -d "$WORK/auto" ]; then rm -rf "$WORK/auto"; fi
cp -a "$CUSTOM/." "$WORK/config/" || die "复制自定义配置失败"

# 钩子/脚本必须可执行（Windows 上复制过来可能丢权限）
chmod +x "$WORK"/config/hooks/*.hook.chroot 2>/dev/null || true
chmod +x "$WORK"/config/includes.chroot/usr/local/bin/* 2>/dev/null || true

# 可选：离线 Node 包已由上面拷进 overlay；这里只处理构建参数

# Debian 的 Contents 文件在 dists/<dist>/<component>/ 下，Ubuntu 版 live-build 3.x
# 会去 dists/<dist>/Contents-<arch>.gz 找而 404；预填缓存 + 幂等补丁


log "预填 Contents 缓存…"
LB_MIRROR_CHROOT_VAL="$(sed -n 's/^LB_MIRROR_CHROOT="\(.*\)"$/\1/p' "$WORK/config/bootstrap" | head -n1)"
LB_ARCHIVE_AREAS_VAL="$(sed -n 's/^LB_ARCHIVE_AREAS="\(.*\)"$/\1/p' "$WORK/config/bootstrap" | head -n1)"
bash "$HERE/stage-contents.sh" "$WORK" bookworm amd64 "${LB_MIRROR_CHROOT_VAL:-http://deb.debian.org/debian}" "${LB_ARCHIVE_AREAS_VAL:-main contrib non-free non-free-firmware}" || warn "Contents 预填失败（继续）"

LBIMG=/usr/lib/live/build/lb_chroot_linux-image
if [ -f "$LBIMG" ] && grep -q '/dists/${LB_PARENT_DISTRIBUTION}/Contents-' "$LBIMG"; then
  log "修补 live-build Contents 路径（$LBIMG）…"
  cp -n "$LBIMG" "$LBIMG.orig" 2>/dev/null || true
  sed -i 's#/dists/${LB_PARENT_DISTRIBUTION}/Contents-#/dists/${LB_PARENT_DISTRIBUTION}/main/Contents-#g; s#/dists/${LB_DISTRIBUTION}/Contents-#/dists/${LB_DISTRIBUTION}/main/Contents-#g' "$LBIMG"
fi

# 第一遍：只构建 chroot（--no-binary），让 chroot 目录生成出来
log "第一遍：构建 chroot（--no-binary）…"
set +e
( cd "$WORK" && lb build --no-binary ) >/dev/null 2>&1
set -e
if [ -d "$WORK/chroot/root" ]; then
  mkdir -p "$WORK/chroot/root/lb_chroot_hooks"
  cp "$WORK"/config/hooks/*.hook.chroot "$WORK/chroot/root/lb_chroot_hooks/" 2>/dev/null || true
  chmod +x "$WORK/chroot/root/lb_chroot_hooks/"* 2>/dev/null || true
  log "钩子已注入 chroot/root/lb_chroot_hooks（$(ls "$WORK/chroot/root/lb_chroot_hooks" 2>/dev/null | wc -l) 个）"
fi

log "开始构建（首次约 20-40 分钟，取决于网速）…"
# 网络不稳时 bootstrap 会少数包下载失败；保留 packages 缓存并重试 3 次
build_once() {
  # chroot 里的 DNS：WSL2 的 resolv.conf 指向网关 10.255.255.254，
  # 只要文件存在就能解析；不存在会导致 apt "Temporary failure resolving"
  mkdir -p "$WORK/chroot/etc"
  # chroot 里可能是指向 systemd-resolved 运行时的悬空 symlink，先删掉再写真实文件
  if [ -L "$WORK/chroot/etc/resolv.conf" ] && [ ! -e "$WORK/chroot/etc/resolv.conf" ]; then
    rm -f "$WORK/chroot/etc/resolv.conf"
  fi
  if [ ! -s "$WORK/chroot/etc/resolv.conf" ]; then
    cp "$CUSTOM/includes.chroot/etc/resolv.conf" "$WORK/chroot/etc/resolv.conf" 2>/dev/null \
      || cp /etc/resolv.conf "$WORK/chroot/etc/resolv.conf" 2>/dev/null || true
  fi
  # 上一次失败可能删掉了 .build，缺 config 阶段 lb build 会直接退出
  if [ ! -f "$WORK/.build/config" ]; then
    log "重跑 lb config（补齐 .build/config 阶段）…"
    ( cd "$WORK" && bash "$HERE/lb-config.sh" ) || log "lb config 失败（继续尝试）"
  fi
  if [ "$NO_ISO" = "1" ]; then
    ( cd "$WORK" && lb build --no-binary )
  else
    ( cd "$WORK" && lb build )
  fi
}

RC=1
for attempt in 1 2 3; do
  set +e
  build_once
  RC=$?
  set -e
  [ "$RC" -eq 0 ] && break
  if [ "$attempt" -lt 3 ]; then
    log "第 $attempt 次构建失败（退出码 $RC），清理半成品后重试（保留已下载的 .deb 缓存）…"
    rm -rf "$WORK/chroot" "$WORK/.build" "$WORK/binary" 2>/dev/null || true
    sleep 5
  fi
done

if [ "$RC" -ne 0 ]; then
  die "lb build 失败（退出码 $RC），详见 $LOG"
fi

# ---------- 产物 ----------
ISO="$(find "$WORK" -maxdepth 2 -name '*.iso' | head -n1)"
if [ -z "$ISO" ]; then
  ISO="$(find "$LB_DIR" -maxdepth 2 -name '*.iso' | head -n1)"
fi
if [ -z "$ISO" ]; then
  warn "未找到 ISO 产物，请检查 $WORK 与 $LB_DIR"
  exit 1
fi

OUT="$DIST/mineros-${VERSION}-amd64.iso"
mv -f "$ISO" "$OUT"
( cd "$DIST" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )

SIZE="$(du -h "$OUT" | cut -f1)"
log "构建完成：$OUT（$SIZE）"
log "校验文件：$OUT.sha256"
cat "$OUT.sha256"

# ---------- 快速自检 ----------
log "镜像自检…"
bash "$HERE/verify-image.sh" "$OUT" || warn "自检发现告警（详见上方输出）"

log "下一步：Windows 上用 os/tools/flash-usb.ps1 烧录 U 盘，或 Linux 上 dd。"
