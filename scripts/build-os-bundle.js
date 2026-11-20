#!/usr/bin/env node
// MinerOS 发布包构建（不需要 Linux）：
//   node scripts/build-os-bundle.js [--server http://IP:8787] [--rig 矿机名]
// 产物（os/dist/）：
//   os-image.json        镜像元数据（服务端 /api/os 读取）
//   mineros-agent.tar.gz 离线采集端包（U 盘首启可直接安装）
//   rig-<name>.conf      示例 rig.conf
// 说明：ISO 本身必须在 Linux 上构建（os/build/build.sh），这里只准备"配套文件"
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OsImage } from '../server/os-image.js';
import { AGENT_VERSION } from '../shared/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'os', 'dist');
fs.mkdirSync(DIST, { recursive: true });

const argValue = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const serverUrl = argValue('--server', 'http://127.0.0.1:8787').replace(/\/+$/, '');
const rigName = argValue('--rig', 'A-01');
const version = '1.0.0';

const osImage = new OsImage({ projectRoot: ROOT, dataDir: path.join(ROOT, 'data'), log: console });

// 采集端离线包
const tarball = osImage.agentTarball();
const tarPath = path.join(DIST, 'mineros-agent.tar.gz');
fs.writeFileSync(tarPath, tarball);
const sha = crypto.createHash('sha256').update(tarball).digest('hex');
console.log(`✓ ${path.relative(ROOT, tarPath)}  ${(tarball.length / 1024).toFixed(1)} KB  sha256=${sha.slice(0, 16)}…`);

// 示例 rig.conf
const conf = osImage.rigConf({
  serverUrl,
  rig: { id: '示例ID（在控制台矿机详情页查看）', name: rigName, coin: 'XMR' },
  token: null,
});
const confPath = path.join(DIST, `rig-${rigName}.conf`);
fs.writeFileSync(confPath, conf);
console.log(`✓ ${path.relative(ROOT, confPath)}（未含密钥，首启自动注册）`);

// 元数据：保留已有 ISO 的 sha256/构建信息，只补齐缺的字段
const existing = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DIST, 'os-image.json'), 'utf8')); } catch { return {}; }
})();
const isoFile = fs.readdirSync(DIST).find((f) => f.endsWith('.iso'));
const meta = {
  version,
  agentVersion: AGENT_VERSION,
  base: 'Debian 12 bookworm amd64',
  ...existing,
  version: existing.version || version,
  agentVersion: AGENT_VERSION,
  ...(isoFile ? {
    file: isoFile,
    size: fs.statSync(path.join(DIST, isoFile)).size,
    builtAt: fs.statSync(path.join(DIST, isoFile)).mtime.toISOString(),
    sha256: (() => {
      try { return fs.readFileSync(path.join(DIST, `${isoFile}.sha256`), 'utf8').trim().split(/\s+/)[0]; } catch { return existing.sha256 || null; }
    })(),
  } : {}),
  notes: `agent v${AGENT_VERSION}; ISO built by os/build/build.sh + postprocess-iso.sh`,
};
fs.writeFileSync(path.join(DIST, 'os-image.json'), JSON.stringify(meta, null, 2));
console.log(`✓ os/dist/os-image.json（agent ${AGENT_VERSION}）`);

// 检查是否已有 ISO
const isos = fs.readdirSync(DIST).filter((f) => f.endsWith('.iso'));
if (isos.length) {
  const iso = path.join(DIST, isos[isos.length - 1]);
  const st = fs.statSync(iso);
  console.log(`✓ 已存在镜像 ${isos[isos.length - 1]}  ${(st.size / 1024 / 1024).toFixed(1)} MB`);
} else {
  console.log('· 尚未构建 ISO。在 Linux/WSL2/Docker 中运行：sudo bash os/build/build.sh');
}

console.log('\n完成。把 os/dist/ 下的文件与服务端一起分发即可。');
