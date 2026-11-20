#!/usr/bin/env node
// 生成演示数据：飞行表、矿机、历史遥测（含每卡数据），用于查看界面效果。
// 用法: node scripts/demo-rigs.js [serverUrl] [adminPassword]
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PASS = process.argv[3] || process.env.MM_ADMIN_PASSWORD || 'admin12345';

async function api(method, p, body, cookie = '') {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!r.ok) throw new Error(`${method} ${p}: ${json?.error || r.status}`);
  return json;
}

const gpuBank = [
  { name: 'NVIDIA GeForce RTX 4090', mem: 24564, base: 3400, power: 320 },
  { name: 'NVIDIA GeForce RTX 4080', mem: 16376, base: 2400, power: 260 },
  { name: 'NVIDIA GeForce RTX 3090', mem: 24576, base: 2100, power: 290 },
  { name: 'NVIDIA GeForce RTX 3080', mem: 10240, base: 1700, power: 230 },
  { name: 'NVIDIA GeForce RTX 4070 Ti', mem: 12282, base: 1900, power: 200 },
  { name: 'AMD Radeon RX 6800 XT', mem: 16384, base: 1500, power: 250, vendor: 'amd' },
];

const RIGS = [
  { name: '机房A-01', group: '机房A', coin: 'XMR', gpus: [0, 1, 2] },
  { name: '机房A-02', group: '机房A', coin: 'XMR', gpus: [3, 4] },
  { name: '机房A-03', group: '机房A', coin: 'XMR', gpus: [0, 0, 1, 1] },
  { name: '机房B-01', group: '机房B', coin: 'PRL', gpus: [0, 0] },
  { name: '机房B-02', group: '机房B', coin: 'PRL', gpus: [1, 1, 2] },
  { name: '测试机', group: '机房B', coin: 'PRL', gpus: [4], offline: true },
];

async function main() {
  console.log('→ 登录', BASE);
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS }),
  });
  if (!login.ok) throw new Error('登录失败，请检查密码');
  const cookie = login.headers.get('set-cookie').split(';')[0];

  // 清理旧的演示矿机
  const existing = await api('GET', '/api/rigs', undefined, cookie);
  for (const r of existing.rigs) {
    if (RIGS.some((x) => x.name === r.name)) await api('DELETE', `/api/rigs/${r.id}`, undefined, cookie);
  }

  const sheets = (await api('GET', '/api/flight-sheets', undefined, cookie)).flightSheets;
  let xmrSheet = sheets.find((s) => s.coin === 'XMR');
  let prlSheet = sheets.find((s) => s.coin === 'PRL');
  if (!xmrSheet) {
    xmrSheet = (await api('POST', '/api/flight-sheets', {
      name: '门罗 XMRig · 演示', coin: 'XMR',
      config: {
        miner: 'xmrig', poolUrl: 'pool.supportxmr.com:3333',
        poolUser: '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge',
        poolPass: 'x', workerName: '{rig}', algo: 'rx/0', tls: false, apiPort: 3333,
        watchdog: { enabled: true, maxTempC: 85, minHashratePercent: 60, crashRestart: true, restartDelaySec: 10 }, autoStart: true,
      },
    }, cookie)).flightSheet;
  }
  if (!prlSheet) {
    prlSheet = (await api('POST', '/api/flight-sheets', {
      name: 'Pearl PeakMiner · 演示', coin: 'PRL',
      config: {
        miner: 'peakminer', poolUrl: 'prl.kryptex.network:8048',
        poolUser: 'prl1p0demo0000000000000000000000000000000000000000000000',
        poolPass: 'x', workerName: '{rig}', algo: 'pearlhash', tls: true, apiPort: 4068,
        extraArgs: '--keepalive',
        watchdog: { enabled: true, maxTempC: 82, minHashratePercent: 60, crashRestart: true, restartDelaySec: 10 }, autoStart: true,
      },
    }, cookie)).flightSheet;
  }

  const created = [];
  for (const spec of RIGS) {
    const r = await api('POST', '/api/rigs', { name: spec.name, group: spec.group, coin: spec.coin }, cookie);
    const sheet = spec.coin === 'PRL' ? prlSheet : xmrSheet;
    await api('PATCH', `/api/rigs/${r.rig.id}`, { flightSheetId: sheet.id }, cookie);
    created.push({ ...spec, rig: r.rig, token: r.token });
  }
  console.log(`→ 已创建 ${created.length} 台演示矿机`);

  // 直接写历史采样（模拟过去 6 小时，每 30 秒一条）
  const db = new DatabaseSync(path.join(ROOT, 'data', 'monitor.sqlite'));
  const stmt = db.prepare(`INSERT OR REPLACE INTO gpu_samples
    (rig_id, ts, gpu_index, name, hashrate, temp, fan, power, util, mem_used, mem_total, clock_core, clock_mem)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const nowMs = Date.now();
  const start = Math.floor((nowMs - 6 * 3600_000) / 1000) * 1000;
  let rows = 0;
  db.exec('BEGIN');
  for (const c of created) {
    if (c.offline) continue;
    c.gpus.forEach((gi, idx) => {
      const g = gpuBank[gi];
      for (let t = start; t < nowMs; t += 30_000) {
        const wave = 1 + 0.04 * Math.sin((t / 60_000) + idx * 1.7) + 0.02 * Math.sin(t / 9000);
        const hour = new Date(t).getHours();
        const temp = (c.coin === 'PRL' ? 62 : 55) + (hour > 10 && hour < 22 ? 6 : 0) + Math.sin(t / 120_000 + idx) * 2.5;
        stmt.run(
          c.rig.id, t, idx, g.name,
          Math.round(g.base * 0.55 * wave * 100) / 100,
          Math.round(temp * 10) / 10,
          Math.round(55 + Math.sin(t / 200_000) * 12),
          Math.round(g.power * 0.7 * wave * 10) / 10,
          Math.round(92 + Math.random() * 8),
          Math.round(g.mem * 0.42), g.mem, 2100, 10500,
        );
        rows++;
      }
    });
  }
  db.exec('COMMIT');
  console.log(`→ 写入 ${rows} 条历史采样`);

  // 每 5 分钟聚合桶
  const rigsNow = db.prepare('SELECT id, coin FROM rigs').all();
  const bucketStmt = db.prepare(`INSERT OR REPLACE INTO rig_buckets(rig_id, ts, hashrate, power, temp_max, fan_max, accepted, rejected, samples)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const r of rigsNow) {
    for (let t = start; t < nowMs; t += 300_000) {
      const row = db.prepare(`SELECT COUNT(*) n, AVG(hashrate) hr, AVG(power) pw, MAX(temp) tm, MAX(fan) fm FROM gpu_samples WHERE rig_id=? AND ts>=? AND ts<?`).get(r.id, t, t + 300_000);
      if (!row?.n) continue;
      bucketStmt.run(r.id, t, row.hr, row.pw, row.tm, row.fm, 0, 0, row.n);
    }
  }
  // 币种桶
  const coinStmt = db.prepare('INSERT OR REPLACE INTO buckets(coin, ts, hashrate, rigs, power, accepted, rejected) VALUES(?,?,?,?,?,?,?)');
  for (const coin of ['XMR', 'PRL']) {
    const rigsOfCoin = rigsNow.filter((r) => r.coin === coin);
    for (let t = start; t < nowMs; t += 300_000) {
      let hr = 0; let pw = 0; let n = 0;
      for (const r of rigsOfCoin) {
        const row = db.prepare('SELECT AVG(hashrate) hr, AVG(power) pw FROM rig_buckets WHERE rig_id=? AND ts=?').get(r.id, t);
        if (row?.hr) { hr += row.hr; pw += row.pw || 0; n++; }
      }
      if (n) coinStmt.run(coin, t, Math.round(hr * 100) / 100, n, Math.round(pw * 10) / 10, 0, 0);
    }
  }
  db.close();

  // 触发一次实时上报（通过采集端模拟）
  console.log('→ 生成实时遥测');
  for (const c of created) {
    if (c.offline) continue;
    await sendHeartbeat(c, created.indexOf(c));
  }
  console.log('\n✅ 演示数据已生成，打开 ' + BASE + ' 查看。\n   登录: admin / ' + PASS);

  if (process.argv.includes('--loop')) {
    console.log('→ 持续发送心跳（保持矿机在线），Ctrl+C 退出');
    setInterval(() => {
      for (const c of created) {
        if (!c.offline) sendHeartbeat(c, created.indexOf(c)).catch(() => {});
      }
    }, 20_000);
  }
}

async function sendHeartbeat(c, idx) {
  const gpus = c.gpus.map((gi, ti) => {
    const g = gpuBank[gi];
    const hashrate = c.coin === 'PRL' ? Math.round(g.base * 0.55 * 1e6) : Math.round(g.base * 0.55);
    return {
      index: ti, name: g.name, vendor: g.vendor || 'nvidia',
      hashrate,
      temp: 58 + Math.random() * 14,
      fan: 55 + Math.random() * 20,
      power: g.power * 0.7 + Math.random() * 10,
      util: 96 + Math.random() * 4,
      memUsed: Math.round(g.mem * 0.42), memTotal: g.mem,
      clockCore: 2100, clockMem: 10500, pstate: 2,
    };
  });
  const total = gpus.reduce((s, g) => s + g.hashrate, 0);
  const body = {
    agent: { version: '1.0.0', hostname: c.name },
    system: {
      os: 'Windows 11 Pro 24H2 (x64)', cpu: '13th Gen Intel(R) Core(TM) i9-13900HX',
      cpuCores: 24, cpuLoad: 12 + Math.random() * 10, memTotalMb: 32768, memUsedMb: 14000,
      diskTotalGb: 1000, diskFreeGb: 420, uptimeSec: 3600 * 29 + 1800, ip: `192.168.1.${20 + idx}`,
    },
    gpus,
    miner: {
      minerId: c.coin === 'PRL' ? 'peakminer' : 'xmrig',
      name: c.coin === 'PRL' ? 'PeakMiner' : 'XMRig',
      state: 'running', algo: c.coin === 'PRL' ? 'pearlhash' : 'rx/0',
      pool: c.coin === 'PRL' ? 'prl.kryptex.network:8048' : 'pool.supportxmr.com:3333',
      hashrate: total, hashrate10s: total, hashrate1m: total * 0.99, hashrate15m: total * 0.98,
      accepted: 120 + idx * 37 + Math.floor(Date.now() / 60000) % 50,
      rejected: idx % 3,
      uptimeSec: 7200 + idx * 600, pid: 4200 + idx,
      gpus: gpus.map((g) => g.hashrate),
    },
    watchdog: { restarts: idx % 2, lastRestartAt: null, reason: null, state: 'ok' },
    logs: [
      '[00:00:00] starting miner ...',
      `[00:00:02] use pool ${c.coin === 'PRL' ? 'prl.kryptex.network:8048' : 'pool.supportxmr.com:3333'}`,
      '[00:00:03] new job from pool diff 2.09M',
      '[00:01:12] accepted (1/1) diff 2097152',
      `[00:02:40] speed 10s/60s/15m ${Math.round(total)} ${Math.round(total * 0.99)} ${Math.round(total * 0.98)} H/s`,
    ],
  };
  const res = await fetch(BASE + '/api/agent/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rig-token': c.token },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.log('  ! 上报失败', c.name, res.status);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
