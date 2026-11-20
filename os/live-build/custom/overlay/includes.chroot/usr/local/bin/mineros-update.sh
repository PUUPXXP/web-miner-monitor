#!/bin/sh
# ============================================================
# MinerOS 采集端自动更新：从控制台下载最新采集端包
# 版本比较：/opt/mineros/VERSION vs 服务器 /api/os/manifest
# ============================================================
set -eu
LOG=/var/log/mineros-update.log
exec >>"$LOG" 2>&1
echo "=== update $(date -Is) ==="

CFG=/etc/mineros/agent.json
[ -f "$CFG" ] || { echo "缺少 $CFG"; exit 0; }

SERVER="$(python3 -c 'import json;print(json.load(open("/etc/mineros/agent.json"))["serverUrl"])' 2>/dev/null || true)"
TOKEN="$(python3 -c 'import json;print(json.load(open("/etc/mineros/agent.json")).get("token",""))' 2>/dev/null || true)"
[ -n "$SERVER" ] || { echo "未配置服务器"; exit 0; }

MANIFEST="$SERVER/api/os/manifest"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! curl -fsSL --max-time 20 "$MANIFEST" -o "$TMP/manifest.json"; then
  echo "manifest 获取失败（离线？）"
  exit 0
fi

LATEST="$(python3 -c 'import json;print(json.load(open("'$TMP'/manifest.json")).get("agentVersion",""))' 2>/dev/null || true)"
CURRENT="$(cat /opt/mineros/VERSION 2>/dev/null || echo 0)"
echo "当前 $CURRENT / 最新 $LATEST"
[ "$LATEST" = "$CURRENT" ] && { echo "已是最新"; exit 0; }

# 新版本：下载 agent 包，校验后替换
if curl -fsSL --max-time 120 -H "x-rig-token: $TOKEN" "$SERVER/api/agent/bundle" -o "$TMP/agent.zip"; then
  mkdir -p "$TMP/x"
  ( cd "$TMP/x" && unzip -q ../agent.zip )
  [ -f "$TMP/x/agent/agent.js" ] || { echo "包内容异常"; exit 1; }
  cp -a "$TMP/x/agent/." /opt/mineros/agent/
  cp -a "$TMP/x/shared/." /opt/mineros/shared/
  echo "$LATEST" > /opt/mineros/VERSION
  systemctl restart mineros-agent.service || true
  echo "已更新到 $LATEST"
else
  echo "下载失败"
fi
