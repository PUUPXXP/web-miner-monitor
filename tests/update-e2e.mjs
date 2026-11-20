// 在线升级端到端测试：上传升级包 -> 下发 -> 采集端拉取并安装 -> 上报进度
// 用法: node tests/update-e2e.mjs [serverUrl]
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const ADMIN = process.env.MM_ADMIN_USER || 'admin';
const PASS = process.env.MM_ADMIN_PASSWORD || 'admin12345';
const NODE = process.execPath;
const RIG_NAME = 'UPDATE-E2E-RIG';
const WORK = path.join(ROOT, 'tests', '.work-update');
const TGZ = path.join(WORK, 'xmrig-9.9.9-win64.tar.gz');

let cookie = '';
const log = (...a) => console.log('·', ...a);
let failed = 0;

function assert(cond, msg) {
  if (cond) { console.log('  ✓', msg); } else { failed++; console.log('  ✗', msg); }
}

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 300)}`);
  return json;
}

function makePackage() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, 'pkg', 'xmrig-9.9.9'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'pkg', 'xmrig-9.9.9', 'xmrig.exe'), 'FAKE XMRIG 9.9.9 FOR E2E');
  fs.writeFileSync(path.join(WORK, 'pkg', 'xmrig-9.9.9', 'VERSION'), '9.9.9');
  // Windows 自带 tar（bsdtar）
  const { execFileSync } = require('node:child_process');
  return path.join(WORK, 'pkg');
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  const health = await api('GET', '/api/health');
  assert(health.ok, '服务器健康');

  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN, password: PASS }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
  log('管理员已登录');

  // 清理旧测试矿机
  for (const r of (await api('GET', '/api/rigs')).rigs) {
    if (r.name === RIG_NAME) await api('DELETE', `/api/rigs/${r.id}`);
  }

  // ── 1. 造包 ──
  const packDir = path.join(WORK, 'pkg');
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(packDir, 'xmrig-9.9.9'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'xmrig-9.9.9', 'xmrig.exe'), 'FAKE XMRIG 9.9.9 FOR E2E');
  const tar = spawn('tar', ['-czf', TGZ, '-C', packDir, 'xmrig-9.9.9'], { stdio: 'ignore' });
  await new Promise((res) => tar.on('exit', res));
  assert(fs.existsSync(TGZ), '测试升级包已生成');

  // ── 2. 上传 ──
  const fd = new FormData();
  fd.append('kind', 'miner');
  fd.append('id', 'xmrig');
  fd.append('version', '9.9.9');
  fd.append('platform', 'win32');
  fd.append('notes', 'E2E 测试包');
  fd.append('file', new Blob([fs.readFileSync(TGZ)]), 'xmrig-9.9.9-win64.tar.gz');
  const up = await fetch(BASE + '/api/updates/upload', { method: 'POST', headers: { cookie }, body: fd });
  const upBody = await up.json();
  assert(up.ok, `上传升级包（${up.status}）`);
  assert(upBody.package?.sha256?.length === 64, '服务器计算了 sha256');

  const list = await api('GET', '/api/updates?refresh=1');
  const pkg = list.all.find((p) => p.kind === 'miner' && p.id === 'xmrig' && p.version === '9.9.9');
  assert(!!pkg, '升级包出现在列表');

  // ── 3. 建矿机 ──
  const rig = (await api('POST', '/api/rigs', { name: RIG_NAME, group: '测试', coin: 'XMR' })).rig;
  assert(!!rig?.id, '测试矿机已创建');
  const token = (await api('POST', `/api/rigs/${rig.id}/rotate-token`, {})).token;
  const minerRoot = path.join(WORK, 'miners');
  fs.mkdirSync(minerRoot, { recursive: true });

  // ── 4. 下发升级 ──
  const push = await api('POST', '/api/updates/push', {
    kind: 'miner', targetId: 'xmrig', version: '9.9.9', rigIds: [rig.id],
  });
  assert(push.queued === 1, '升级任务已下发（1 台）');
  const jobId = push.jobs[0].jobId;
  assert(!!jobId, `升级任务 id: ${jobId}`);

  // ── 5. 采集端执行（--once 会领取并执行命令）──
  const cfgFile = path.join(WORK, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    serverUrl: BASE, token, rigId: rig.id, name: RIG_NAME,
    workDir: WORK, minerPath: minerRoot, intervalSec: 2,
  }, null, 2));
  fs.writeFileSync(path.join(WORK, 'agent-state.json'), JSON.stringify({ fingerprint: 'mm-update-e2e', token, rigId: rig.id }));

  const agentLog = path.join(WORK, 'agent.log');
  const fdLog = fs.openSync(agentLog, 'w');
  const run = await new Promise((resolve) => {
    const child = spawn(NODE, ['agent/agent.js', '--once', '--config', cfgFile], {
      cwd: ROOT, windowsHide: true, env: { ...process.env, MM_CONFIG: cfgFile, MM_WORK_DIR: WORK },
      stdio: ['ignore', fdLog, fdLog],
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(-1); }, 90_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  fs.closeSync(fdLog);
  const out = fs.readFileSync(agentLog, 'utf8');
  assert(run === 0, `采集端退出码 0（实际 ${run}）`);

  // ── 6. 校验安装结果 ──
  const cur = path.join(minerRoot, 'xmrig', 'current.txt');
  const installed = fs.existsSync(cur) ? fs.readFileSync(cur, 'utf8').trim() : null;
  const exe = path.join(minerRoot, 'xmrig', '9.9.9', 'xmrig.exe');
  assert(installed === '9.9.9', `current.txt = ${installed}`);
  assert(fs.existsSync(exe), '可执行文件已落盘');
  assert(fs.existsSync(path.join(minerRoot, 'xmrig', 'version.json')), 'version.json 已写入');

  // ── 7. 校验任务状态 ──
  let job = null;
  for (let i = 0; i < 40; i++) {
    const data = await api('GET', '/api/updates');
    job = data.jobs.find((j) => j.id === jobId);
    if (job && ['ok', 'error'].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(job?.status === 'ok', `升级任务状态 ${job?.status}（进度 ${job?.progress}%）`);

  // ── 8. 客户端 feed 应不再提示该版本 ──
  const feed = await (await fetch(`${BASE}/api/updates/feed?platform=win32&agent=1.1.0&miners=${encodeURIComponent(JSON.stringify({ xmrig: '9.9.9' }))}`, {
    headers: { 'x-rig-token': token },
  })).json();
  const still = (feed.available || []).some((a) => a.kind === 'miner' && a.id === 'xmrig' && a.version === '9.9.9');
  assert(!still, '已安装版本不再出现在升级清单');

  // 清理
  await api('DELETE', `/api/rigs/${rig.id}`);
  await api('DELETE', '/api/updates/miner/xmrig/9.9.9');

  console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 升级链路全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
