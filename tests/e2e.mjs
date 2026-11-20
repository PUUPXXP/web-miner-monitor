// 端到端联调脚本：创建/复用测试矿机 -> 配置假矿工飞行表 -> 运行采集端一次 -> 校验服务端数据
// 用法: node tests/e2e.mjs [serverUrl]
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const ADMIN = process.env.MM_ADMIN_USER || 'admin';
const PASS = process.env.MM_ADMIN_PASSWORD || 'admin12345';
const NODE = process.execPath;

let cookie = '';
async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 200)}`);
  return json;
}

function runNode(args, { env = {}, timeoutMs = 120_000 } = {}) {
  // 注意：不使用 pipe stdio（部分受限环境禁止），把输出写入文件后读取
  const logFile = path.join(ROOT, 'tests', '.work', `agent-${Date.now()}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'w');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(NODE, args, {
        cwd: ROOT,
        windowsHide: true,
        env: { ...process.env, ...env },
        stdio: ['ignore', fd, fd],
      });
    } catch (e) {
      fs.closeSync(fd);
      return resolve({ code: -1, out: '', err: e.message, timeout: false });
    }
    fs.closeSync(fd);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve({ code: -1, out: readLog(logFile), err: '', timeout: true }); }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out: readLog(logFile), err: '', timeout: false });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: '', err: e.message, timeout: false }); });
  });
}

function readLog(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

const log = (...a) => console.log('•', ...a);

async function main() {
  log('连接服务器', BASE);
  const health = await api('GET', '/api/health');
  assert(health.ok, '服务器健康检查');

  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN, password: PASS }),
  });
  assert(login.ok, '管理员登录');
  cookie = login.headers.get('set-cookie').split(';')[0];
  log('登录成功');

  // 清理上一次的测试矿机，保证幂等
  const existing = await api('GET', '/api/rigs');
  for (const r of existing.rigs) {
    if (r.name === 'E2E-TEST-RIG') await api('DELETE', `/api/rigs/${r.id}`);
  }
  const sheets = await api('GET', '/api/flight-sheets');
  for (const s of sheets.flightSheets) {
    if (s.name === 'E2E 假矿工') await api('DELETE', `/api/flight-sheets/${s.id}`);
  }

  // 飞行表：自定义矿工 -> 假 XMRig
  const fakePath = path.join(ROOT, 'tests', 'fake-xmrig.js').replace(/\\/g, '\\\\');
  const sheet = await api('POST', '/api/flight-sheets', {
    name: 'E2E 假矿工',
    coin: 'XMR',
    config: {
      miner: 'custom',
      binPath: NODE,
      command: `"${path.join(ROOT, 'tests', 'fake-xmrig.js').replace(/\\/g, '/')}" {algo} {pool} {wallet} --http-port 3333`,
      poolUrl: 'pool.supportxmr.com:3333',
      poolUser: '4E2EtestWallet0000000000000000000000000000000000000000000000000000000000',
      poolPass: 'x',
      workerName: '{rig}',
      algo: 'rx/0',
      apiPort: 3333,
      oc: {},
      watchdog: { enabled: true, maxTempC: 85, minHashratePercent: 60, crashRestart: true, restartDelaySec: 5 },
      autoStart: true,
    },
  });
  log('飞行表已创建:', sheet.flightSheet.id);

  const rigs = await api('GET', '/api/rigs');
  let rig = rigs.rigs.find((r) => r.name === 'E2E-TEST-RIG');
  if (!rig) {
    const created = await api('POST', '/api/rigs', { name: 'E2E-TEST-RIG', group: '测试', coin: 'XMR' });
    rig = created.rig;
    log('矿机已创建:', rig.id);
  } else if (!rig.id) {
    throw new Error('无法获取测试矿机');
  }
  await api('PATCH', `/api/rigs/${rig.id}`, { flightSheetId: sheet.flightSheet.id, enabled: true, maintenance: false });
  log('飞行表已分配给矿机');

  // 预绑定指纹 + 写入采集端配置（固定令牌，避免自动注册到别的机器）
  const fp = 'mm-e2e-test-fixed';
  await api('PATCH', `/api/rigs/${rig.id}`, { fingerprint: fp });
  const tokenRes = await api('POST', `/api/rigs/${rig.id}/rotate-token`, {});
  const workDir = path.join(ROOT, 'tests', '.work');
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'config.json'), JSON.stringify({
    serverUrl: BASE, token: tokenRes.token, rigId: rig.id, name: 'E2E-TEST-RIG', workDir, intervalSec: 2,
  }, null, 2));
  fs.writeFileSync(path.join(workDir, 'agent-state.json'), JSON.stringify({ fingerprint: fp, token: tokenRes.token, rigId: rig.id }));
  log('已写入采集端配置与密钥');

  // 运行采集端：模拟 2 张 GPU + 真实假矿工
  log('启动采集端（--simulate --once）...');
  const run = await runNode(['agent/agent.js', '--simulate', '--gpus', '2', '--once'], {
    env: {
      MM_SERVER: BASE,
      MM_WORK_DIR: path.join(ROOT, 'tests', '.work'),
      MM_INTERVAL: '2',
    },
    timeoutMs: 90_000,
  });
  if (run.code !== 0) {
    console.log('--- agent stdout ---\n' + run.out);
    console.log('--- agent stderr ---\n' + run.err);
    throw new Error(`采集端退出码 ${run.code}`);
  }
  log('采集端上报完成');

  const detail = await api('GET', `/api/rigs/${rig.id}`);
  const r = detail.rig;
  console.log('\n服务器侧矿机数据:');
  console.log(JSON.stringify({
    name: r.name, online: r.online, gpuCount: r.gpu_count, gpus: r.gpu_summary,
    hashrate: r.total_hashrate, power: r.power_w, tempMax: r.temp_max,
    miner: r.miner_name, minerState: r.miner_state, pool: r.pool_url,
    accepted: r.accepted, rejected: r.rejected, watchdog: r.watchdog_restarts,
    liveGpus: r.live?.gpus?.map((g) => ({ name: g.name, hashrate: g.hashrate, temp: g.temp })),
  }, null, 2));

  assert(r.online === true, '矿机在线');
  assert(r.gpu_count === 2, '采集到 2 张 GPU');
  assert(r.total_hashrate > 1000, '总算力已上报');
  assert(r.miner_state === 'running' || r.miner_state === 'starting', '矿工处于运行状态');
  assert(r.accepted >= 0, '份额字段存在');
  assert(r.live?.gpus?.length === 2, '实时 GPU 数据存在');

  // 命令：重启矿工 -> 心跳领取 -> 回执
  log('测试远程命令（重启矿工）...');
  const cmd = await api('POST', `/api/rigs/${rig.id}/command`, { type: 'restart' });
  assert(cmd.id, '命令已创建');
  // 等命令投递窗口刷新，确保下一次心跳能领取
  await new Promise((res) => setTimeout(res, 2000));
  // 第一次运行：领取命令并执行（矿机已在线，采集端需约 1 个心跳周期）
  const run2 = await runNode(['agent/agent.js', '--simulate', '--gpus', '2', '--once'], {
    env: { MM_SERVER: BASE, MM_WORK_DIR: path.join(ROOT, 'tests', '.work') },
    timeoutMs: 90_000,
  });
  assert(run2.code === 0, '采集端第二次运行成功');
  let done = null;
  for (let i = 0; i < 40; i++) {
    const cmds = await api('GET', '/api/commands');
    done = cmds.commands.find((c) => c.id === cmd.id);
    if (done && (done.status === 'ok' || done.status === 'error')) break;
    await new Promise((res) => setTimeout(res, 800));
  }
  if (done && (done.status === 'ok' || done.status === 'error')) {
    console.log('命令状态:', done.status, done.result);
    assert(true, '命令已回执');
  } else {
    // 重投递路径：再次运行采集端，验证命令不会丢失
    log('命令未在第一次心跳执行，重投递后再运行一次采集端...');
    const run3 = await runNode(['agent/agent.js', '--simulate', '--gpus', '2', '--once'], {
      env: { MM_SERVER: BASE, MM_WORK_DIR: path.join(ROOT, 'tests', '.work') },
      timeoutMs: 90_000,
    });
    assert(run3.code === 0, '采集端第三次运行成功');
    for (let i = 0; i < 20; i++) {
      const cmds = await api('GET', '/api/commands');
      done = cmds.commands.find((c) => c.id === cmd.id);
      if (done && (done.status === 'ok' || done.status === 'error')) break;
      await new Promise((res) => setTimeout(res, 800));
    }
    console.log('命令状态(重投递):', done?.status, done?.result);
    assert(done && (done.status === 'ok' || done.status === 'error'), '命令已回执');
  }

  // 历史
  const hist = await api('GET', `/api/history/rig/${rig.id}?hours=1`);
  console.log('历史采样点:', hist.gpus?.reduce((n, g) => n + g.points.length, 0) || 0);

  console.log('\n✅ 端到端测试全部通过');
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e.message);
  process.exit(1);
});
