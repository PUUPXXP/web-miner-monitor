#!/bin/bash
# ============================================================
# MinerOS 后处理：把构建钩子真正应用到 squashfs，再重新打包 ISO
#
# 背景：Ubuntu/Debian 的 live-build 4.x 在某些配置下不会执行
# config/hooks/*.hook.chroot（chroot_hooks 阶段被跳过），导致 Node、
# 用户、systemd 使能等定制内容缺失。这里用「解包 squashfs → 应用定制 →
# 重新打包」的方式保证产物完整，且完全可重复。
#
# 用法（WSL/Debian 主机，root）：
#   bash os/build/postprocess-iso.sh <input.iso> <output.iso>
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS_DIR="$(cd "$HERE/.." && pwd)"
PROJECT_DIR="$(cd "$OS_DIR/.." && pwd)"

IN="${1:-$OS_DIR/dist/mineros-1.0.0-amd64.iso}"
OUT="${2:-$OS_DIR/dist/mineros-1.0.0-amd64.iso}"
WORK="${MM_POST_WORK:-/root/mineros-post}"
CUSTOM="$OS_DIR/live-build/custom/overlay/includes.chroot"

[ -f "$IN" ] || { echo "input ISO not found: $IN"; exit 1; }

# squashfs 压缩算法：与 build.sh 保持一致（低配构建机用 zstd 快很多）
SQ_COMP="${MM_SQUASHFS:-xz}"

# 转绝对路径：脚本后面会 cd 到工作目录，相对路径会指错地方
case "$IN" in /*) ;; *) IN="$(readlink -f "$IN")" ;; esac
case "$OUT" in
  /*) ;;
  *) OUT="$(cd "$(dirname "$OUT")" 2>/dev/null && pwd)/$(basename "$OUT")" ;;
esac

echo "=== 1. 解包 ISO ==="
rm -rf "$WORK"
mkdir -p "$WORK"
xorriso -osirrox on -indev "$IN" -extract / "$WORK/iso" >/dev/null 2>&1

echo "=== 2. 解包 squashfs ==="
SQ="$WORK/iso/live/filesystem.squashfs"
[ -f "$SQ" ] || { echo "squashfs not found in ISO"; exit 1; }
unsquashfs -q -d "$WORK/fs" "$SQ" >/dev/null

ROOT="$WORK/fs"

echo "=== 3. 应用定制 ==="

# 3.1 用户 / 主机名 / 时区
mkdir -p "$ROOT/etc"
grep -q '^mineros:' "$ROOT/etc/passwd" 2>/dev/null || \
  chroot "$ROOT" /usr/sbin/useradd -m -s /bin/bash mineros 2>/dev/null || true
grep -q '^mineros:' "$ROOT/etc/passwd" 2>/dev/null || \
  echo 'mineros:x:1000:1000::/home/mineros:/bin/bash' >> "$ROOT/etc/passwd"

echo "mineros" > "$ROOT/etc/hostname"
cat > "$ROOT/etc/hosts" <<'EOF'
127.0.0.1 localhost
127.0.1.1 mineros
::1 localhost ip6-localhost ip6-loopback
EOF

# 3.2 采集端代码与本地工具
mkdir -p "$ROOT/opt/mineros/agent" "$ROOT/opt/mineros/shared" "$ROOT/opt/mineros/tools"
rsync -a --delete \
  --exclude 'backup/' --exclude 'logs/' --exclude 'miners/' \
  --exclude 'agent-state.json' --exclude 'config.json' --exclude '*.log' \
  "$PROJECT_DIR/agent/" "$ROOT/opt/mineros/agent/"
rsync -a --delete "$PROJECT_DIR/shared/" "$ROOT/opt/mineros/shared/"
rsync -a "$CUSTOM/opt/mineros/tools/" "$ROOT/opt/mineros/tools/"
find "$ROOT/opt/mineros" \( -name 'agent-state.json' -o -name 'config.json' -o -name '*.log' \) -delete 2>/dev/null || true
rm -rf "$ROOT/opt/mineros/agent/backup" "$ROOT/opt/mineros/agent/logs" "$ROOT/opt/mineros/agent/miners" 2>/dev/null || true

# 版本号从 shared/version.js 读取，避免镜像里写死
AGENT_VER="$(sed -n "s/.*AGENT_VERSION = '\([0-9.]*\)'.*/\1/p" "$PROJECT_DIR/shared/version.js" | head -n1)"
printf '%s\n' "${AGENT_VER:-1.2.0}" > "$ROOT/opt/mineros/VERSION"
echo "  采集端版本: ${AGENT_VER:-unknown}"

# 3.3 Node.js（从构建缓存解压）
# Node 包可能在 build/cache 或 chroot 构建目录里
NODE_TGZ="$(ls "$OS_DIR"/build/cache/node-*-linux-x64.tar.xz 2>/dev/null | head -n1 || true)"
if [ -z "$NODE_TGZ" ]; then
  NODE_TGZ="$(find /root/mineros-bookworm /root/mineros-build -maxdepth 4 -name 'node-*-linux-x64.tar.xz' 2>/dev/null | head -n1 || true)"
fi
if [ -n "$NODE_TGZ" ] && [ -f "$NODE_TGZ" ]; then
  echo "  Node: $(basename "$NODE_TGZ")"
  mkdir -p "$ROOT/opt/mineros/node"
  tar -xJf "$NODE_TGZ" -C "$ROOT/opt/mineros/node" --strip-components=1
else
  echo "  WARN: 找不到 Node 缓存包（os/build/cache/node-*.tar.xz）"
fi

# 3.4 systemd 单元 + 使能
mkdir -p "$ROOT/etc/systemd/system"
cp "$CUSTOM/etc/systemd/system/"*.service "$CUSTOM/etc/systemd/system/"*.timer "$ROOT/etc/systemd/system/" 2>/dev/null || true
chmod 644 "$ROOT/etc/systemd/system/"mineros-* 2>/dev/null || true
mkdir -p "$ROOT/etc/systemd/system/multi-user.target.wants" "$ROOT/etc/systemd/system/timers.target.wants"
for u in mineros-agent.service mineros-firstboot.service mineros-console.service mineros-panel.service; do
  ln -sfn "/etc/systemd/system/$u" "$ROOT/etc/systemd/system/multi-user.target.wants/$u"
done
ln -sfn /etc/systemd/system/mineros-update.timer "$ROOT/etc/systemd/system/timers.target.wants/mineros-update.timer"
rm -f "$ROOT/etc/systemd/system/getty@tty1.service.d/autologin.conf" 2>/dev/null || true
ln -sfn /dev/null "$ROOT/etc/systemd/system/getty@tty1.service" 2>/dev/null || true

# 3.4b NVIDIA 持久化服务：没有 /dev/nvidia* 时跳过（VM / AMD 机器）
mkdir -p "$ROOT/etc/systemd/system/nvidia-persistenced.service.d"
cat > "$ROOT/etc/systemd/system/nvidia-persistenced.service.d/mineros.conf" <<'EOF'
[Unit]
ConditionPathExistsGlob=/dev/nvidia[0-9]*
EOF

# 3.5 首启/更新脚本与状态命令
mkdir -p "$ROOT/usr/local/bin"
cp "$CUSTOM/usr/local/bin/mineros-firstboot.sh" "$CUSTOM/usr/local/bin/mineros-update.sh" "$ROOT/usr/local/bin/" 2>/dev/null || true
cat > "$ROOT/usr/local/bin/mineros-status" <<'EOF'
#!/bin/sh
echo "=== MinerOS ==="
cat /etc/mineros-release 2>/dev/null
echo ""
echo "=== 服务 ==="
systemctl is-active mineros-agent.service mineros-console.service mineros-firstboot.service 2>/dev/null | paste -sd' ' -
echo ""
echo "=== GPU ==="
nvidia-smi --query-gpu=index,name,temperature.gpu,fan.speed,utilization.gpu,power.draw,power.limit,memory.used,memory.total --format=csv,noheader 2>/dev/null || echo "nvidia-smi 不可用"
echo ""
echo "=== 最近日志 ==="
tail -n 15 /var/log/mineros/agent.log 2>/dev/null || journalctl -u mineros-agent -n 15 --no-pager 2>/dev/null
EOF
chmod 755 "$ROOT/usr/local/bin/mineros-"* "$ROOT/usr/local/bin/mineros-status" 2>/dev/null || true

# 3.6 运行目录 / 配置 / 版本
mkdir -p "$ROOT/etc/mineros" "$ROOT/var/lib/mineros" "$ROOT/var/log/mineros" "$ROOT/opt/mineros/miners"
cp "$CUSTOM/etc/mineros/version" "$ROOT/etc/mineros/version" 2>/dev/null || true
cat > "$ROOT/etc/mineros-release" <<'EOF'
MinerOS 1.0.0 (Debian 12 bookworm, amd64)
auto-register on first boot
EOF
cat > "$ROOT/etc/resolv.conf" <<'EOF'
nameserver 1.1.1.1
nameserver 8.8.8.8
nameserver 223.5.5.5
EOF
cat > "$ROOT/etc/fstab" <<'EOF'
tmpfs /var/lib/mineros tmpfs mode=0755,nosuid,nodev,size=64M 0 0
tmpfs /var/log/mineros tmpfs mode=0755,nosuid,nodev,size=32M 0 0
tmpfs /etc/mineros tmpfs mode=0700,nosuid,nodev,size=8M 0 0
EOF
chmod 700 "$ROOT/etc/mineros" 2>/dev/null || true

# 3.7 motd / 时区 / sysctl
cat > "$ROOT/etc/motd" <<'EOF'

  ⛏  MinerOS 1.0.0  —  矿机专用 Linux（Debian 12 base）

  本地控制台 : http://<本机IP>:4000
  状态查看   : mineros-status
  服务管理   : systemctl status mineros-agent
  配置       : /etc/mineros/agent.json
  矿工目录   : /opt/mineros/miners/
  日志       : /var/log/mineros/agent.log

  默认账号 root / mineros（首次登录请修改：passwd）

EOF
ln -sfn /usr/share/zoneinfo/Asia/Shanghai "$ROOT/etc/localtime"
echo "Asia/Shanghai" > "$ROOT/etc/timezone"

echo "=== 4. 校验 ==="
for f in opt/mineros/agent/agent.js opt/mineros/shared/miners.js opt/mineros/node/bin/node \
         opt/mineros/tools/lan-console.js opt/mineros/tools/status-panel.js \
         usr/local/bin/mineros-firstboot.sh etc/systemd/system/mineros-agent.service; do
  if [ -e "$ROOT/$f" ]; then echo "  OK $f"; else echo "  MISSING $f"; fi
done
[ -x "$ROOT/opt/mineros/node/bin/node" ] && "$ROOT/opt/mineros/node/bin/node" --version || true

echo "=== 5. 重新打包 squashfs（$SQ_COMP）==="
mksquashfs "$ROOT" "$SQ" -comp "$SQ_COMP" -noappend -no-progress >/dev/null

echo "=== 6. 重新生成 ISO ==="
cd "$WORK/iso"
xorriso -as mkisofs \
  -iso-level 3 -full-iso9660-filenames -volid MINEROS \
  -b isolinux/isolinux.bin -c isolinux/boot.cat -no-emul-boot -boot-load-size 4 -boot-info-table \
  -eltorito-alt-boot -e boot/grub/efi.img -no-emul-boot \
  -isohybrid-mbr /usr/lib/ISOLINUX/isohdpfx.bin \
  -isohybrid-gpt-basdat \
  -o "$OUT" . 2>&1 | tail -5

if [ ! -s "$OUT" ]; then echo "[ERROR] xorriso 打包失败：$OUT 不存在"; exit 6; fi
sha256sum "$OUT" > "$OUT.sha256"
echo "=== 完成：$OUT ($(du -h "$OUT" | cut -f1)) ==="
cat "$OUT.sha256"
