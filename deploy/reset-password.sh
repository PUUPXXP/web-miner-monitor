#!/bin/bash
# ============================================================
# 重置管理员密码（忘密码 / 改环境变量不生效时用）
#
# 用法（root）：
#   sudo bash deploy/reset-password.sh 'NewPass123'
#   sudo bash deploy/reset-password.sh 'NewPass123' --user admin
#
# 说明：MM_ADMIN_PASSWORD 只在「数据库里还没有管理员」时生效，
#       已经建号以后再改环境变量没用，要用这个脚本或控制台改。
# ============================================================
set -euo pipefail

NEW_PASS="${1:-}"
APP_DIR="${MM_APP_DIR:-/opt/web-miner-monitor}"
DATA_DIR="${MM_DATA_DIR:-/var/lib/web-miner-monitor}"
USER_NAME="admin"
shift 2>/dev/null || true

while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_NAME="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "请用 root 运行"; exit 1; }
[ -n "$NEW_PASS" ] || { echo "用法: $0 '新密码' [--user admin]"; exit 1; }
[ -f "$DATA_DIR/monitor.sqlite" ] || { echo "找不到数据库: $DATA_DIR/monitor.sqlite"; exit 1; }
[ "${#NEW_PASS}" -ge 8 ] || { echo "密码太短（至少 8 位）"; exit 1; }

echo "==> 停服务（避免 SQLite 写入冲突）"
systemctl stop web-miner-monitor 2>/dev/null || true

echo "==> 更新密码（复用应用自己的 scrypt 实现）"
NEW_PASS="$NEW_PASS" USER_NAME="$USER_NAME" APP_DIR="$APP_DIR" DATA_DIR="$DATA_DIR" \
node --input-type=module <<'EOF'
import { DatabaseSync } from 'node:sqlite';

const { APP_DIR, DATA_DIR, USER_NAME, NEW_PASS } = process.env;
const { hashPassword } = await import(`file://${APP_DIR}/shared/util.js`);

const db = new DatabaseSync(`${DATA_DIR}/monitor.sqlite`);
const row = db.prepare('SELECT id, username FROM users WHERE username = ?').get(USER_NAME);
if (!row) {
  console.error(`用户 ${USER_NAME} 不存在。当前用户：`);
  for (const u of db.prepare('SELECT username FROM users').all()) console.error('  -', u.username);
  process.exit(2);
}
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(NEW_PASS), row.id);
console.log(`    已更新用户 ${row.username}`);
db.close();
EOF

echo "==> 启动服务"
systemctl start web-miner-monitor
PORT=$(grep '^MM_PORT=' /etc/web-miner-monitor.env 2>/dev/null | cut -d= -f2)
PORT=${PORT:-32001}
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "==> 完成，用新密码登录即可（端口 $PORT）"
    exit 0
  fi
  sleep 1
done
echo "服务未就绪，查看：journalctl -u web-miner-monitor -n 40"
exit 1
