#!/usr/bin/env node
// 矿机采集端：Windows / Linux 通用。采集 GPU/矿工状态并上报；执行远程命令；看门狗。
// Linux（MinerOS）下由 systemd 启动，配置在 /etc/mineros/agent.json。
// 使用方法见 docs/采集端使用说明.md 或运行 node agent/agent.js --check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { num, now, sleep, sha256 } from '../shared/util.js';
import { probeGpus, applyOc, readCpuTemperature } from './gpu.js';
import { collectSystem as collectSystemWin } from './sys.js';
import { collectSystem as collectSystemLinux } from './sys-linux.js';
import { MinerRunner, detectProcesses } from './miner.js';
import { Watchdog } from './watchdog.js';
import { Updater } from './updater.js';
import { loadPlatform, IS_LINUX, IS_WINDOWS } from './platform.js';
import { AGENT_VERSION } from '../shared/version.js';
import { MINERS } from '../shared/miners.js';

const VERSION = AGENT_VERSION;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const collectSystem = IS_LINUX ? collectSystemLinux : collectSystemWin;
const platform = await loadPlatform();

// ───────── 配置 ─────────
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const hasFlag = (name) => args.includes(name);

const configPath = path.resolve(
  argValue('--config') ||
  process.env.MM_CONFIG ||
  (IS_LINUX ? '/etc/mineros/agent.json' : path.join(HERE, 'config.json')),
);
let config = {};
if (fs.existsSync(configPath)) {
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {
    console.error(`配置文件解析失败: ${e.message}`);
    process.exit(1);
  }
}
config = {
  serverUrl: process.env.MM_SERVER || config.serverUrl || 'http://127.0.0.1:8787',
  token: process.env.MM_TOKEN || config.token || '',
  rigId: process.env.MM_RIG_ID || config.rigId || '',
  name: process.env.MM_RIG_NAME || config.name || os.hostname(),
  workDir: process.env.MM_WORK_DIR || config.workDir || (IS_LINUX ? '/var/lib/mineros' : path.join(HERE)),
  intervalSec: num(process.env.MM_INTERVAL || config.intervalSec) || 5,
  allowUpdate: config.allowUpdate === true,
  allowReboot: config.allowReboot !== false,
  allowRun: config.allowRun !== false,
  minerPath: config.minerPath || (IS_LINUX ? '/opt/mineros/miners' : ''),
  ...config,
};
config.serverUrl = String(config.serverUrl).replace(/\/+$/, '');

const LOG_DIR = path.join(config.workDir, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, 'agent.log');
function log(level, msg) {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
  if (!hasFlag('--quiet')) console.log(line);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, logFile + '.1');
    fs.appendFileSync(logFile, line + '\n');
  } catch { /* ignore */ }
}
const logger = {
  info: (m) => log('info', m),
  warn: (m) => log('warn', m),
  error: (m) => log('error', m),
};

// ───────── 身份（机器指纹 / 本地状态）─────────
const stateFile = path.join(config.workDir, 'agent-state.json');
let state = {};
try { if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
function saveState() {
  try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8'); } catch { /* ignore */ }
}
function fingerprint() {
  if (!state.fingerprint) {
    const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${crypto.randomBytes(8).toString('hex')}`;
    state.fingerprint = 'mm-' + sha256(seed).slice(0, 24);
    saveState();
  }
  return state.fingerprint;
}
if (config.token) state.token = config.token;
if (config.rigId) state.rigId = config.rigId;

// ───────── HTTP 客户端 ─────────
async function api(method, apiPath, body, timeout = 20_000) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers['x-rig-token'] = state.token;
  const r = await fetch(config.serverUrl + apiPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 300) }; }
  if (!r.ok) {
    const err = new Error(json?.error || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return json;
}

async function register() {
  const info = await api('POST', '/api/agent/register', {
    fingerprint: fingerprint(),
    hostname: os.hostname(),
    version: VERSION,
    platform: os.platform(),
  });
  state.token = info.token;
  state.rigId = info.rigId;
  state.registeredName = info.name;
  saveState();
  logger.info(`自动注册成功：${info.name} (${info.rigId})`);
  return info;
}

// ───────── 采集端状态 ─────────
const ctx = {
  config: null,          // 服务器下发的配置
  profile: null,         // 解析后的矿工启动参数
  profileHash: null,
  gpuVendor: 'none',
  gpuError: null,
  seq: 0,
  lastHeartbeatAt: 0,
  lastCommandIds: new Set(),
  fakeGpu: null,
};

const runner = new MinerRunner({ workDir: config.workDir, log: logger, platform });
const watchdog = new Watchdog({ log: logger, runner });
const updater = new Updater({
  config,
  log: logger,
  serverUrl: config.serverUrl,
  token: state.token,
  platform: IS_LINUX ? 'linux' : 'win32',
});

// 模拟 GPU（无显卡时用于测试完整链路）
if (hasFlag('--simulate')) {
  const n = Number(argValue('--gpus') || 2);
  ctx.fakeGpu = Array.from({ length: n }, (_, i) => ({
    index: i,
    name: `SIMULATED GPU ${i} (RTX 4080)`,
    vendor: 'nvidia',
    temp: 62 + i,
    fan: 55,
    util: 99,
    memUsed: 5200,
    memTotal: 12282,
    power: 180,
    clockCore: 2100,
    clockMem: 10500,
    pstate: 2,
    hashrate: null,
  }));
}

async function readGpus() {
  if (ctx.fakeGpu) {
    return { vendor: 'nvidia', gpus: ctx.fakeGpu.map((g) => ({ ...g, temp: 60 + Math.round(Math.random() * 6) })), procs: [] };
  }
  try {
    const r = await probeGpus();
    ctx.gpuVendor = r.vendor;
    ctx.gpuError = r.note || (r.vendor === 'none' ? '未检测到 GPU 监控接口（Linux 需安装 nvidia-smi / amdgpu）' : null);
    return r;
  } catch (e) {
    ctx.gpuError = `GPU 采集异常: ${e.message}`;
    logger.warn(ctx.gpuError);
    return { vendor: ctx.gpuVendor, gpus: [], procs: [] };
  }
}

/** 执行 shell（Windows: PowerShell；Linux: sh） */
async function runShell(command) {
  const { runCmd } = await import('./proc.js');
  if (IS_WINDOWS) return runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { timeout: 120_000 });
  return runCmd('sh', ['-c', command], { timeout: 120_000 });
}

/** 恢复某张卡的默认频率 */
async function resetOcForGpu(i) {
  const { runCmd } = await import('./proc.js');
  if (IS_WINDOWS) {
    await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `nvidia-smi -i ${i} -rgc; nvidia-smi -i ${i} -rmc`], { timeout: 8000 });
  } else {
    await runCmd('nvidia-smi', ['-i', String(i), '-rgc'], { timeout: 8000 });
    await runCmd('nvidia-smi', ['-i', String(i), '-rmc'], { timeout: 8000 });
  }
}

function resolveProfile(serverCfg) {
  const sheet = serverCfg?.flightSheet;
  if (!sheet?.config) return null;
  const rigName = serverCfg.name || config.name || os.hostname();
  const p = runner.resolveProfile(sheet, rigName);
  if (!p) return null;

  // 1) 版本化布局优先：<minerPath>/<minerId>/current/<exe>
  const binName = path.basename(p.exe);
  if (!sheet.config.binPath) {
    const versioned = updater.resolveExe(p.miner, binName);
    if (versioned) {
      p.exe = versioned;
      p.version = updater.currentVersion(p.miner);
    }
  }
  // 2) 全局 minerPath 覆盖
  if (!sheet.config.binPath && config.minerPath && !p.version) {
    const candidate = path.join(config.minerPath, binName);
    if (fs.existsSync(candidate)) p.exe = candidate;
  }
  p.rigName = rigName;
  return p;
}

/** 应用服务器下发的配置；配置变化时按需重启矿工 */
async function applyServerConfig(serverCfg, { force = false } = {}) {
  if (!serverCfg) return;
  ctx.config = serverCfg;
  const nextProfile = resolveProfile(serverCfg);
  const nextHash = nextProfile ? sha256(JSON.stringify({ ...nextProfile, exe: nextProfile.exe })) : null;
  const changed = nextHash !== ctx.profileHash;
  ctx.profile = nextProfile;
  if (changed) {
    ctx.profileHash = nextHash;
    logger.info(`飞行表配置已更新：${nextProfile ? `${nextProfile.miner} @ ${nextProfile.poolUrl ?? ''}` : '（无）'}`);
  }
  if (!nextProfile) {
    if (runner.state === 'running' || runner.state === 'starting') {
      logger.warn('未分配飞行表，停止矿工');
      await runner.stop();
    }
    return;
  }
  const shouldRun = !!serverCfg.enabled && !serverCfg.maintenance;
  if (!shouldRun) {
    if (runner.state === 'running' || runner.state === 'starting') {
      logger.info(serverCfg.maintenance ? '矿机进入维护模式，停止矿工' : '矿机已禁用，停止矿工');
      await runner.stop();
    }
    return;
  }
  if (changed && nextProfile.autoStart !== false) {
    if (runner.state === 'running' || runner.state === 'starting' || force) {
      logger.info('配置变化，重启矿工以生效');
      try {
        await runner.stop();
        await sleep(1000);
        await runner.start(nextProfile);
        await applyOverclock(nextProfile);
      } catch (e) {
        logger.error(`应用新配置失败: ${e.message}`);
        try { await api('POST', '/api/agent/event', { level: 'error', message: `应用飞行表失败: ${e.message}` }); } catch { /* ignore */ }
      }
    } else if (nextProfile.autoStart !== false) {
      try {
        await runner.start(nextProfile);
        await applyOverclock(nextProfile);
      } catch (e) {
        logger.error(`启动矿工失败: ${e.message}`);
        try { await api('POST', '/api/agent/event', { level: 'error', message: `启动矿工失败: ${e.message}` }); } catch { /* ignore */ }
      }
    }
  }
}

async function applyOverclock(profile) {
  const oc = profile?.oc;
  if (!oc || oc.enabled === false) return;
  const has = ['powerLimitW', 'coreClockOffset', 'memClockOffset', 'fanSpeed'].some((k) => oc[k] !== null && oc[k] !== undefined && oc[k] !== '');
  if (!has) return;
  if (ctx.gpuVendor === 'amd') {
    logger.warn('AMD 显卡不支持通过 nvidia-smi 设置超频，已跳过');
    return;
  }
  const count = ctx.fakeGpu?.length || 1;
  for (let i = 0; i < Math.max(count, 1); i++) {
    const r = await applyOc({
      gpuIndex: i,
      powerLimitW: oc.powerLimitW,
      coreClockOffset: oc.coreClockOffset,
      memClockOffset: oc.memClockOffset,
      fanSpeed: oc.fanSpeed,
    });
    if (!r.ok) logger.warn(`GPU${i} 超频设置未完全成功: ${r.detail}`);
  }
}

// ───────── 命令执行 ─────────
async function execCommand(cmd) {
  const out = { id: cmd.id, type: cmd.type, ok: true, output: '' };
  try {
    switch (cmd.type) {
      case 'start': {
        if (!ctx.profile) throw new Error('尚未分配飞行表');
        const r = await runner.start(ctx.profile);
        out.output = r.already ? '矿工已在运行' : `已启动 PID ${r.pid}`;
        await applyOverclock(ctx.profile);
        break;
      }
      case 'stop': {
        const r = await runner.stop();
        out.output = `已停止（结束 ${r.killed} 个进程）`;
        break;
      }
      case 'restart': {
        if (!ctx.profile) throw new Error('尚未分配飞行表');
        const r = await runner.restart(ctx.profile);
        out.output = `已重启 PID ${r.pid}`;
        await applyOverclock(ctx.profile);
        break;
      }
      case 'sync_config': {
        const hb = await api('POST', '/api/agent/heartbeat', { hello: true, version: VERSION });
        await applyServerConfig(hb.config, { force: true });
        out.output = '配置已同步';
        break;
      }
      case 'apply_oc': {
        if (!ctx.profile) throw new Error('尚未分配飞行表');
        await applyOverclock(ctx.profile);
        out.output = '超频/功耗设置已应用（NVIDIA 需要管理员权限）';
        break;
      }
      case 'reset_oc': {
        for (let i = 0; i < 8; i++) {
          await probeGpus().catch(() => {});
          await resetOcForGpu(i);
        }
        out.output = '已尝试恢复默认频率';
        break;
      }
      case 'reboot': {
        if (!config.allowReboot) throw new Error('本机配置禁止远程重启');
        const r = await platform.reboot();
        out.output = r.message;
        break;
      }
      case 'shutdown': {
        if (!config.allowReboot) throw new Error('本机配置禁止远程关机');
        const r = await platform.shutdown();
        out.output = r.message;
        break;
      }
      case 'run': {
        if (!config.allowRun) throw new Error('本机配置禁止自定义命令');
        const command = String(cmd.payload?.command || '').slice(0, 2000);
        if (!command) throw new Error('命令为空');
        const r = await runShell(command);
        out.ok = r.ok;
        out.output = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).slice(0, 3500);
        break;
      }
      case 'update_agent': {
        out.output = await selfUpdate(cmd.payload || null);
        break;
      }
      // ───────── 在线升级 ─────────
      case 'update_miner': {
        const pkg = cmd.payload || {};
        if (!pkg.url || !pkg.version) throw new Error('缺少升级包信息');
        const progress = makeProgress(pkg.jobId);
        const wasRunning = runner.state === 'running' || runner.state === 'starting';
        const r = await updater.installMiner(pkg, progress);
        out.output = `矿工 ${r.id} 已升级到 ${r.version}${r.previous ? `（原 ${r.previous}）` : ''}`;
        // 升级后按当前飞行表重启矿工
        const profile = ctx.profile;
        if (profile) {
          const nextExe = updater.resolveExe(profile.miner, path.basename(profile.exe));
          if (nextExe) ctx.profile = { ...profile, exe: nextExe, version: updater.currentVersion(profile.miner) };
        }
        if (wasRunning && ctx.profile) {
          await runner.restart(ctx.profile);
          await applyOverclock(ctx.profile);
          out.output += '，已重启矿工';
        }
        break;
      }
      case 'rollback_miner': {
        const id = String(cmd.payload?.id || ctx.profile?.miner || '');
        if (!id) throw new Error('缺少矿工 id');
        const r = await updater.rollbackMiner(id);
        out.output = `矿工 ${id} 已回滚到 ${r.version}`;
        if (ctx.profile) {
          const exe = updater.resolveExe(id, path.basename(ctx.profile.exe));
          if (exe) ctx.profile = { ...ctx.profile, exe, version: r.version };
          if (runner.state === 'running') await runner.restart(ctx.profile);
        }
        break;
      }
      case 'update_system': {
        const pkg = cmd.payload || {};
        if (!pkg.url) throw new Error('缺少组件包信息');
        const progress = makeProgress(pkg.jobId);
        const r = await updater.installSystem(pkg, progress);
        out.output = r.skipped ? (r.message || '组件包已下载') : `组件 ${r.id} 已升级到 ${r.version}`;
        break;
      }
      default:
        throw new Error(`未知命令: ${cmd.type}`);
    }
  } catch (e) {
    out.ok = false;
    out.output = e.message;
    logger.error(`命令 ${cmd.type} 执行失败: ${e.message}`);
  }
  logger.info(`命令 ${cmd.type} -> ${out.ok ? 'OK' : 'FAIL'}: ${out.output.split('\n')[0].slice(0, 200)}`);
  // 升级类命令：上报最终状态，让控制台的升级记录闭环。
  // update_agent 例外：进程马上会被替换重启，由服务器在重连时判定成功。
  if (cmd.payload?.jobId) {
    if (cmd.type === 'update_agent') {
      api('POST', '/api/updates/progress', {
        jobId: cmd.payload.jobId,
        status: out.ok ? 'running' : 'error',
        progress: out.ok ? 90 : 0,
        message: out.ok ? '包已就绪，正在替换并重启采集端' : out.output.slice(0, 400),
      }).catch(() => { /* ignore */ });
    } else if (['update_miner', 'update_system'].includes(cmd.type)) {
      api('POST', '/api/updates/progress', {
        jobId: cmd.payload.jobId,
        status: out.ok ? 'ok' : 'error',
        progress: out.ok ? 100 : 0,
        message: out.output.slice(0, 400),
      }).catch(() => { /* ignore */ });
    }
  }
  return out;
}

/** 自更新：下载采集端包，替换后由 systemd / 计划任务拉起 */
async function selfUpdate(pkg = null) {
  const progress = makeProgress(pkg?.jobId);
  const staged = await updater.stageAgentUpdate(
    pkg || { url: '/api/agent/bundle', sha256: null, version: VERSION },
    progress,
  );
  const dir = config.workDir;

  if (IS_WINDOWS) {
    const zipPath = path.join(staged.staging, '..', 'update.zip');
    // 复用已下载的包：把 staging 里的 agent 直接拷过去
    const script = path.join(dir, 'apply-update.ps1');
    const ps = `
param()
$ErrorActionPreference='Stop'
Start-Sleep -Seconds 2
$dir = '${dir.replace(/'/g, "''")}'
$src = '${staged.src.replace(/'/g, "''")}'
Copy-Item -Recurse -Force (Join-Path $src 'agent\\*') (Join-Path $dir 'agent')
Copy-Item -Recurse -Force (Join-Path $src 'shared\\*') (Join-Path $dir 'shared')
Remove-Item -Recurse -Force '${staged.staging.replace(/'/g, "''")}'
$node = (Get-Command node).Source
Start-Process -FilePath $node -ArgumentList "\\"$dir\\agent\\agent.js\\" --config \\"$dir\\config.json\\"" -WorkingDirectory $dir -WindowStyle Hidden
`;
    fs.writeFileSync(script, ps, 'utf8');
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true }, () => {
      setTimeout(() => process.exit(0), 1500);
    });
    return '采集端已下载，正在替换并重启';
  }

  // Linux（MinerOS）：用独立脚本在 agent 退出后替换文件，再由 systemd 拉起
  const script = path.join(dir, 'apply-update.sh');
  const sh = `#!/bin/sh
set -eu
sleep 2
DIR='${dir.replace(/'/g, "'\\''")}'
SRC='${staged.src.replace(/'/g, "'\\''")}'
cp -a "$SRC/agent/." "$DIR/agent/"
cp -a "$SRC/shared/." "$DIR/shared/"
[ -f "$SRC/VERSION" ] && cp "$SRC/VERSION" "$DIR/VERSION"
rm -rf '${staged.staging.replace(/'/g, "'\\''")}'
systemctl restart mineros-agent.service || true
`;
  fs.writeFileSync(script, sh, { mode: 0o755 });
  const child = spawn('sh', [script], { detached: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => process.exit(0), 500);
  return '采集端已下载，正在替换并重启';
}

/** 升级进度上报（有 jobId 时） */
function makeProgress(jobId) {
  let last = -1;
  return (pct, msg) => {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    if (p === last) return;
    last = p;
    logger.info(`升级进度 ${p}%${msg ? ' · ' + msg : ''}`);
    if (!jobId) return;
    api('POST', '/api/updates/progress', { jobId, status: 'running', progress: p, message: msg || '' })
      .catch(() => { /* 进度上报失败不影响升级 */ });
  };
}

/** 向服务器查询可用升级（5 分钟缓存） */
let updateCache = { at: 0, list: [] };
async function refreshAvailableUpdates(minerVersions) {
  if (now() - updateCache.at < 5 * 60_000) return updateCache.list;
  try {
    const q = new URLSearchParams({
      platform: IS_LINUX ? 'linux' : 'win32',
      agent: VERSION,
      miners: JSON.stringify(minerVersions || {}),
    });
    const r = await api('GET', `/api/updates/feed?${q}`, undefined, 15_000);
    updateCache = { at: now(), list: Array.isArray(r?.available) ? r.available : [] };
  } catch {
    updateCache = { at: now(), list: [] };
  }
  return updateCache.list;
}

/** 操作系统描述（MinerOS 版本号） */
function osDescription() {
  try {
    const t = fs.readFileSync('/etc/mineros-release', 'utf8');
    const m = t.match(/MinerOS ([\d.]+)/);
    if (m) return `MinerOS ${m[1]}`;
  } catch { /* ignore */ }
  return IS_WINDOWS ? `Windows ${os.release()}` : `Linux ${os.release()}`;
}

// ───────── 心跳 ─────────
async function buildStats() {
  const [sys, gpu] = await Promise.all([collectSystem(), readGpus()]);
  let refresh = await runner.refresh();
  // 首次启动时给矿工一点时间初始化（API 就绪），避免第一次上报算力为空
  if (runner.state === 'starting' && !runner.statsReady) {
    const wait = hasFlag('--once') ? 1_500 : 6_000;
    refresh = (await runner.waitReady(wait)) || refresh;
    if (num(refresh.stats?.hashrate) !== null) runner.statsReady = true;
  }
  const profile = ctx.profile;
  const stats = refresh.stats || {};
  const minerState = refresh.state;
  const hash = num(stats.hashrate) ?? null;

  const tempMax = gpu.gpus.map((g) => num(g.temp)).filter((v) => v !== null);
  const highestTemp = tempMax.length ? Math.max(...tempMax) : null;

  // 看门狗
  const wdResult = await watchdog.check({
    profile,
    minerState,
    stats: { hashrate: hash },
    tempMax: highestTemp,
    enabled: !!(ctx.config?.enabled && !ctx.config?.maintenance && profile),
  });
  if (wdResult.action === 'stopped-hot') {
    try { await api('POST', '/api/agent/event', { level: 'warn', message: `过热保护：${wdResult.detail}` }); } catch { /* ignore */ }
  }

  const shouldRun = !!(ctx.config?.enabled && !ctx.config?.maintenance && profile);
  let miner = {
    minerId: profile?.miner || '',
    name: profile ? (MINERS[profile.miner]?.name || profile.miner) : '',
    state: !shouldRun ? (ctx.config?.maintenance ? 'stopped' : 'stopped') : minerState,
    algo: profile?.algo || '',
    pool: profile?.poolUrl || '',
    walletHint: profile?.poolUser ? String(profile.poolUser).slice(0, 8) + '…' : '',
    hashrate: hash,
    hashrate10s: num(stats.hashrate10s),
    hashrate1m: num(stats.hashrate1m),
    hashrate15m: num(stats.hashrate15m),
    accepted: num(stats.accepted),
    rejected: num(stats.rejected),
    uptimeSec: num(stats.uptimeSec) ?? (runner.startedAt ? Math.round((now() - runner.startedAt) / 1000) : null),
    pid: refresh.pid,
    lastError: runner.lastError || stats.lastError || null,
    version: profile?.version || runner.profile?.version || null,
    minerVersions: updater.installedVersions(),
    gpus: stats.gpus || null,
    perGpuDetail: stats.perGpuDetail || null,
  };
  if (!shouldRun) miner = { ...miner, hashrate: 0, hashrate10s: 0, hashrate1m: 0, hashrate15m: 0 };

  // 可用升级（带 5 分钟缓存，避免每次心跳都请求）
  const available = await refreshAvailableUpdates(miner.minerVersions);

  return {
    type: 'stats',
    seq: ++ctx.seq,
    agent: { version: VERSION, hostname: os.hostname(), osImage: osDescription() },
    system: { ...sys, cpuTemp: await readCpuTemperature().catch(() => null), osImage: osDescription() },
    gpus: gpu.gpus,
    gpuError: ctx.gpuError,
    miner,
    availableUpdates: available,
    watchdog: {
      restarts: watchdog.restarts,
      lastRestartAt: watchdog.lastRestartAt,
      reason: watchdog.reason,
      state: watchdog.state,
    },
    logs: runner.logs || [],
  };
}

async function heartbeat() {
  // 1) 先领命令并执行（独立通道，避免被遥测采集耗时阻塞）
  let pulled = [];
  try {
    logger.info(`[pull] 拉取命令 token=***${String(state.token || '').slice(-4)} rig=${state.rigId || '-'}`);
    const r = await api('POST', '/api/agent/commands', {});
    pulled = r?.commands || [];
    logger.info(`[pull] 返回 ${pulled.length} 条`);
  } catch (e) {
    logger.warn(`[pull] 失败: ${e.message} ${e.status || ''}`);
  }
  if (pulled.length) logger.info(`收到 ${pulled.length} 条命令: ${pulled.map((c) => c.type).join(', ')}`);
  const pendingResults = [];
  for (const cmd of pulled) {
    if (!cmd?.id || ctx.lastCommandIds.has(cmd.id)) continue;
    ctx.lastCommandIds.add(cmd.id);
    if (ctx.lastCommandIds.size > 500) ctx.lastCommandIds = new Set([...ctx.lastCommandIds].slice(-200));
    const out = await execCommand(cmd);
    pendingResults.push(out);
    try {
      await api('POST', '/api/agent/command-result', out);
      logger.info(`命令 ${cmd.type} 结果已回传`);
    } catch (e) {
      logger.warn(`回传命令结果失败: ${e.message}`);
    }
  }

  // 2) 上报遥测
  const stats = await buildStats();
  let res;
  try {
    res = await api('POST', '/api/agent/heartbeat', stats);
  } catch (e) {
    if (e.status === 401) {
      logger.warn('矿机密钥失效，尝试重新注册...');
      try { await register(); } catch (e2) {
        logger.error(`重新注册失败: ${e2.message}`);
        throw e2;
      }
      res = await api('POST', '/api/agent/heartbeat', stats);
    } else {
      throw e;
    }
  }
  ctx.lastHeartbeatAt = now();
  if (res?.config) await applyServerConfig(res.config);
  // 兼容 WS 通道：命令可能随心跳返回
  for (const cmd of res?.commands || []) {
    if (!cmd?.id || ctx.lastCommandIds.has(cmd.id)) continue;
    ctx.lastCommandIds.add(cmd.id);
    const out = await execCommand(cmd);
    pendingResults.push(out);
    try { await api('POST', '/api/agent/command-result', out); } catch { /* ignore */ }
  }
  return { ...res, executed: pendingResults };
}

// ───────── 主循环 ─────────
let running = true;
let backoff = 1000;

async function mainLoop() {
  while (running) {
    const t0 = now();
    try {
      await heartbeat();
      backoff = 1000;
    } catch (e) {
      logger.error(`心跳失败: ${e.message}` + (e.status ? ` (HTTP ${e.status})` : ''));
      if (e.status === 403) logger.error('服务器未开启自动注册，请检查控制台设置或手动部署密钥');
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    const interval = Math.max(2, Math.min(60, num(ctx.config?.heartbeatSec) || config.intervalSec)) * 1000;
    const elapsed = now() - t0;
    await sleep(Math.max(300, interval - elapsed));
  }
}

process.on('SIGINT', () => { running = false; runner.stop().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { running = false; runner.stop().finally(() => process.exit(0)); });
process.on('uncaughtException', (e) => logger.error(`未捕获异常: ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => logger.error(`未处理 Promise 拒绝: ${e?.stack || e}`));

// ───────── `--check` 诊断模式 ─────────
async function checkMode() {
  console.log('');
  console.log(`采集端 v${VERSION}  诊断模式`);
  console.log(`服务器: ${config.serverUrl}`);
  console.log(`指纹  : ${fingerprint()}`);
  console.log(`密钥  : ${state.token ? state.token.slice(0, 10) + '…' : '（未注册）'}`);
  console.log('');
  const gpu = await probeGpus().catch((e) => ({ vendor: 'none', gpus: [], note: e.message }));
  console.log(`GPU 接口: ${gpu.vendor}${gpu.note ? `（${gpu.note}）` : ''}`);
  for (const g of gpu.gpus) {
    console.log(`  [${g.index}] ${g.name}  ${g.temp ?? '?'}°C  ${g.fan ?? '?'}%  ${g.util ?? '?'}%  ${g.power ?? '?'}W  ${((g.memUsed || 0) / 1024).toFixed(1)}/${((g.memTotal || 0) / 1024).toFixed(1)}GB`);
  }
  const sys = await collectSystem();
  console.log(`系统   : ${sys.os} / ${sys.cpu} / ${sys.cpuCores} 核 / 内存 ${sys.memUsedMb}/${sys.memTotalMb} MB / IP ${sys.ip}`);
  const procs = await detectProcesses(platform).catch(() => []);
  console.log(`矿工进程: ${procs.length ? procs.map((p) => `${p.name}(PID ${p.pid})`).join(', ') : '未发现'}`);
  if (!state.token) {
    try {
      const info = await register();
      console.log(`注册    : 成功 → ${info.name}`);
    } catch (e) {
      console.log(`注册    : 失败 — ${e.message}`);
    }
  }
  try {
    const hb = await api('POST', '/api/agent/heartbeat', { hello: true, version: VERSION, fingerprint: fingerprint() });
    console.log(`服务器  : 连接成功，配置 ${hb.config?.flightSheet ? hb.config.flightSheet.name : '未分配飞行表'}`);
  } catch (e) {
    console.log(`服务器  : 连接失败 — ${e.message}`);
    if (e.status === 401) console.log('          密钥无效。请在控制台「矿机详情 → 安装」重新获取，或开启自动注册。');
  }
  console.log('');
  console.log('如有问题请把以上输出和 logs/agent.log 一起提供给维护者。');
}

// ───────── 启动 ─────────
(async () => {
  if (hasFlag('--check')) {
    await checkMode();
    return;
  }
  logger.info(`采集端启动 v${VERSION}  服务器=${config.serverUrl}  工作目录=${config.workDir}`);
  if (!state.token) {
    try { await register(); } catch (e) {
      logger.error(`注册失败: ${e.message}。请确认服务器地址可访问，且控制台已开启「自动注册」。`);
      if (!hasFlag('--keep-trying')) process.exit(2);
    }
  }
  // 先拉一次配置
  try {
    const hb = await api('POST', '/api/agent/heartbeat', { hello: true, version: VERSION, fingerprint: fingerprint() });
    await applyServerConfig(hb.config);
  } catch (e) {
    logger.warn(`首次拉取配置失败（将继续重试）: ${e.message}`);
  }
  if (hasFlag('--once')) {
    logger.info('单次运行模式：上报一次后退出');
    try {
      await heartbeat();
      logger.info('单次上报完成');
    } catch (e) {
      logger.error(`单次上报失败: ${e.message}`);
      process.exitCode = 1;
    }
    await runner.stop().catch(() => {});
    setTimeout(() => process.exit(process.exitCode || 0), 200);
    return;
  }
  await mainLoop();
})();
