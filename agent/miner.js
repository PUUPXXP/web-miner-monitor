// 采集端：矿工进程管理 + 统计接口探测 + 日志解析
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { buildCommand, MINERS } from '../shared/miners.js';
import { num, round, now } from '../shared/util.js';
import { runCmd } from './proc.js';

const tailCache = new Map();

/** 读取文件尾部若干行 */
function tailFile(file, maxBytes = 64 * 1024) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, stat.size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 探测矿工 HTTP 统计接口（使用 node:http，避免依赖全局 fetch）
 * 成功返回解析后的 JSON，失败返回 null，并在 probeHttp.lastError 记录原因。
 */
async function probeHttp(port, apiPath = '/', token = null) {
  try {
    return await new Promise((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: Number(port),
        path: apiPath || '/',
        method: 'GET',
        headers: { accept: 'application/json', ...(token ? { 'x-access-token': token } : {}) },
        timeout: 2500,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { if (body.length < 512 * 1024) body += d; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            probeHttp.lastError = `HTTP ${res.statusCode}`;
            return resolve(null);
          }
          try { resolve(JSON.parse(body)); } catch { resolve({ _raw: body.slice(0, 4000) }); }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', (e) => {
        probeHttp.lastError = `${e.message}${e.code ? ' (' + e.code + ')' : ''}`;
        resolve(null);
      });
      req.end();
    });
  } catch (e) {
    probeHttp.lastError = e.message;
    return null;
  }
}

// ───────── 各矿工统计解析器 ─────────
/** PeakMiner /summary（Pearl 首选，字段文档化） */
function parsePeakMiner(j) {
  if (!j || j.hashrate === undefined) return null;
  const gpus = Array.isArray(j.gpus)
    ? j.gpus.map((g) => ({
      index: g.id,
      name: g.name,
      hashrate: num(g.hashrate),
      temp: num(g.temperature_c),
      fan: num(g.fan_pct),
      util: num(g.utilization_pct),
      power: num(g.power_w),
      clockCore: num(g.core_clock_mhz),
      clockMem: num(g.mem_clock_mhz),
      accepted: num(g.accepted_shares),
      rejected: num(g.invalid_shares),
      pciBus: g.pci_bus_id,
    }))
    : null;
  return {
    hashrate: num(j.hashrate),
    hashrate1m: num(j.hashrate),
    accepted: num(j.accepted_shares),
    rejected: num(j.invalid_shares),
    uptimeSec: num(j.uptime),
    pool: j.pool?.url || null,
    algo: j.algo || 'pearlhash',
    gpus,
    perGpuDetail: gpus,
    powerFromMiner: num(j.power_w),
    efficiency: num(j.hashrate_per_watt),
  };
}

/** bzMiner /api/snapshot */
function parseBzminer(j) {
  if (!j) return null;
  const devs = j.devices || j.gpus || j.workers || [];
  const gpus = Array.isArray(devs) ? devs.map((d, i) => ({
    index: d.index ?? d.id ?? i,
    name: d.name || d.model,
    hashrate: num(d.hashrate ?? d.speed ?? d.khash),
    temp: num(d.temp ?? d.temperature),
    fan: num(d.fan ?? d.fan_speed),
    power: num(d.power ?? d.power_w),
  })) : null;
  const total = gpus?.reduce((s, g) => s + (g.hashrate || 0), 0) || num(j.hashrate);
  return {
    hashrate: total,
    accepted: num(j.shares?.accepted ?? j.accepted),
    rejected: num(j.shares?.rejected ?? j.rejected),
    uptimeSec: num(j.uptime),
    pool: j.pool?.url || j.pool || null,
    gpus: gpus ? gpus.map((g) => g.hashrate) : null,
    perGpuDetail: gpus,
  };
}

/** OneZeroMiner /summary（结构随版本略有差异，尽量宽泛解析） */
function parseOneZero(j) {
  if (!j) return null;
  const devs = j.devices || j.gpus || j.GPUS || [];
  const gpus = Array.isArray(devs) ? devs.map((d, i) => ({
    index: d.id ?? d.index ?? i,
    name: d.name,
    hashrate: num(d.hashrate ?? d.speed),
    temp: num(d.temperature ?? d.temp),
    fan: num(d.fan ?? d.fanSpeed),
    power: num(d.power ?? d.powerDraw),
  })) : null;
  const total = gpus?.reduce((s, g) => s + (g.hashrate || 0), 0) || num(j.hashrate ?? j.total_hashrate);
  return {
    hashrate: total,
    accepted: num(j.accepted ?? j.shares?.accepted),
    rejected: num(j.rejected ?? j.shares?.rejected),
    uptimeSec: num(j.uptime),
    pool: j.pool || j.pool_url || null,
    gpus: gpus ? gpus.map((g) => g.hashrate) : null,
    perGpuDetail: gpus,
  };
}

/** WildRig Multi 的 API（KawPow 风格汇总） */
function parseWildrig(j) {
  if (!j) return null;
  const devs = j.GPUs || j.gpus || [];
  const gpus = Array.isArray(devs) ? devs.map((g, i) => ({
    index: i,
    name: g.Name || g.name,
    hashrate: num(g.Hashrate ?? g.hashrate),
    temp: num(g.Temperature ?? g.temp),
    fan: num(g.Fan ?? g.fan),
    power: num(g.Power ?? g.power),
  })) : null;
  const total = gpus?.reduce((s, g) => s + (g.hashrate || 0), 0) || num(j.Hashrate ?? j.hashrate);
  return {
    hashrate: total,
    accepted: num(j.Accepted ?? j.accepted),
    rejected: num(j.Rejected ?? j.rejected),
    uptimeSec: num(j.Uptime ?? j.uptime),
    pool: j.Pool || j.pool || null,
    gpus: gpus ? gpus.map((g) => g.hashrate) : null,
    perGpuDetail: gpus,
  };
}

function parseXmrig(j) {
  if (!j || !j.hashrate) return null;
  const hr = j.hashrate.total || [];
  const gpu = (j.hashrate.gpus || []).map((v) => num(v)).map((v) => (v && v > 0 ? v : null));
  const shares = j.results?.shares_good ?? null;
  const total = j.results?.shares_total ?? null;
  return {
    hashrate: num(hr[1]) ?? num(hr[0]) ?? num(hr[2]),
    hashrate10s: num(hr[0]),
    hashrate1m: num(hr[1]),
    hashrate15m: num(hr[2]),
    accepted: num(shares),
    rejected: total !== null && shares !== null ? num(total) - num(shares) : null,
    uptimeSec: num(j.uptime),
    pool: j.connection?.pool || null,
    gpus: gpu.length ? gpu : null,
    algo: j.algo || j.algorithms?.[0] || null,
  };
}

function parseSrbminer(j) {
  if (!j) return null;
  const algos = j.algorithms || [];
  for (const a of algos) {
    const pool = a.pool || a.pools?.[0];
    if (pool) {
      const gpus = (pool.gpus || []).map((g) => num(g.hashrate));
      return {
        hashrate: num(pool.hashrate),
        hashrate15m: num(pool.hashrate_15s) ?? num(pool.hashrate),
        accepted: num(pool.accepted),
        rejected: num(pool.rejected),
        uptimeSec: num(a.uptime),
        pool: pool.url || pool.pool || null,
        algo: a.algorithm || a.name || null,
        gpus,
      };
    }
  }
  return null;
}

function parseGminer(j) {
  if (!j) return null;
  const devs = j.devices || [];
  const gpus = devs.map((d) => num(d.speed));
  const total = devs.reduce((s, d) => s + (num(d.speed) || 0), 0);
  return {
    hashrate: total || num(j.total_speed),
    hashrate1m: num(j.total_speed),
    accepted: num(j.total_accepted_shares ?? j.total_accepted),
    rejected: num(j.total_rejected_shares ?? j.total_rejected),
    uptimeSec: num(j.uptime),
    pool: j.pool || null,
    gpus: gpus.length ? gpus : null,
  };
}

function parseTeamredminer(j) {
  if (!j) return null;
  const gp = j.GPUS || [];
  const gpus = gp.map((g) => (num(g.MHS ?? g.mhs) ? num(g.MHS ?? g.mhs) * 1e6 : num(g.hashrate)));
  const total = gpus.filter((v) => v !== null).reduce((s, v) => s + v, 0);
  return {
    hashrate: total || null,
    accepted: num(j.ACCEPTED ?? j.accepted),
    rejected: num(j.REJECTED ?? j.rejected),
    uptimeSec: num(j.UPTIME ?? j.uptime),
    pool: j.POOL || j.pool || null,
    gpus: gpus.length ? gpus : null,
  };
}

const PARSERS = {
  xmrig: parseXmrig,
  peakminer: parsePeakMiner,
  bzminer: parseBzminer,
  onezero: parseOneZero,
  wildrig: parseWildrig,
  srbminer: parseSrbminer,
  gminer: parseGminer,
  teamredminer: parseTeamredminer,
  custom: parseXmrig, // 自定义矿工先按 XMRig 协议尝试
};

/** 从日志里兜底解析（矿工未开 API 时） */
function parseLog(file) {
  const lines = tailFile(file, 32 * 1024);
  const out = { hashrate: null, accepted: null, rejected: null, lastError: null, logs: lines.slice(-25) };
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (out.hashrate === null) {
      const m = l.match(/speed\s+10s\/60s\/15m[:\s]+([\d.]+)\s*([kMGT]?)H\/s/i)
        || l.match(/Total\s*[:=]\s*([\d.]+)\s*([kMGT]?)H\/s/i)
        || l.match(/([\d.]+)\s*([kMGT]?)H\/s/i);
      if (m) {
        const mult = { k: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] || 1;
        out.hashrate = Number(m[1]) * mult;
      }
    }
    if (out.accepted === null) {
      const m = l.match(/accepted[^\d]*(\d+)[^\d]+rejected[^\d]*(\d+)/i);
      if (m) { out.accepted = Number(m[1]); out.rejected = Number(m[2]); }
    }
    if (!out.lastError && /error|fail|cannot|denied|invalid/i.test(l) && /(pool|connect|login|share)/i.test(l)) {
      out.lastError = l.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 300);
    }
  }
  return out;
}

export class MinerRunner {
  constructor({ workDir, log, platform }) {
    this.workDir = workDir;
    this.log = log;
    this.platform = platform; // 平台能力（Windows/Linux）
    this.proc = null;
    this.state = 'stopped';
    this.profile = null;
    this.startedAt = null;
    this.lastError = null;
    this.logFile = null;
    this.restarts = 0;
    this.lastRestartAt = null;
    this.restartReason = null;
    this.external = null;
    this.effective = null;
    this.stats = null;
    this.statsAt = 0;
    this.statsReady = false;
  }

  /** 解析飞行表 -> 实际启动参数 */
  resolveProfile(sheet, rigName) {
    if (!sheet?.config) return null;
    const cfg = sheet.config;
    const minerId = MINERS[cfg.miner] ? cfg.miner : 'custom';
    const profile = {
      ...cfg,
      miner: minerId,
      coin: sheet.coin,
      isCustom: minerId === 'custom',
      workerName: String(cfg.workerName || '{rig}').replaceAll('{rig}', rigName).replaceAll('{worker}', rigName),
    };
    const built = buildCommand(minerId, profile);
    let exe = String(cfg.binPath || '').trim();
    if (!exe) exe = path.join(this.workDir, 'miners', minerId, built.bin || 'miner.exe');
    if (exe && !path.isAbsolute(exe)) exe = path.join(this.workDir, exe);
    return {
      ...profile,
      exe,
      args: built.args,
      family: built.family,
      apiPort: built.api.port,
      apiPath: built.api.path,
    };
  }

  logPath() {
    const dir = path.join(this.workDir, 'logs', 'miner');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'miner.log');
  }

  start(profile) {
    if (!profile) throw new Error('缺少飞行表配置');
    if (this.state === 'running' || this.state === 'starting') {
      return { ok: true, already: true, message: '矿工已在运行' };
    }
    if (!profile.exe) throw new Error('矿工可执行文件路径为空');
    if (!fs.existsSync(profile.exe)) {
      throw new Error(`找不到矿工程序: ${profile.exe}（请把矿工放到该路径，或在飞行表中填写正确的 binPath）`);
    }
    this.profile = profile;
    this.logFile = this.logPath();
    try { fs.writeFileSync(this.logFile, ''); } catch { /* ignore */ }
    const out = fs.openSync(this.logFile, 'a');
    const args = profile.args || [];
    this.log?.info?.(`启动矿工: ${profile.exe} ${args.map(maskSecret).join(' ')}`);
    try {
      this.proc = spawn(profile.exe, args, {
        cwd: path.dirname(profile.exe),
        windowsHide: true,
        detached: false,
        stdio: ['ignore', out, out],
      });
    } catch (e) {
      try { fs.closeSync(out); } catch { /* ignore */ }
      this.state = 'error';
      this.lastError = `启动失败: ${e.message}`;
      throw new Error(this.lastError);
    }
    // 子进程已继承句柄，父进程可立即关闭
    try { fs.closeSync(out); } catch { /* ignore */ }
    this.state = 'starting';
    this.startedAt = now();
    this.lastError = null;
    this.external = null;
    this.statsReady = false;

    this.proc.on('error', (err) => {
      this.state = 'error';
      this.lastError = `启动失败: ${err.message}`;
      this.log?.error?.(this.lastError);
    });
    this.proc.on('exit', (code, signal) => {
      const wasRunning = this.state === 'running' || this.state === 'starting';
      this.proc = null;
      if (this.state !== 'stopped') {
        this.state = 'stopped';
        if (wasRunning) this.log?.warn?.(`矿工进程退出 code=${code} signal=${signal}`);
        if (wasRunning && code !== 0 && code !== null) {
          this.lastError = `矿工异常退出 (code ${code}${signal ? ', ' + signal : ''})`;
        }
      }
    });
    return { ok: true, pid: this.proc.pid };
  }

  async stop({ killExternal = true } = {}) {
    const targets = [];
    if (this.proc?.pid) targets.push(this.proc.pid);
    if (killExternal && this.external?.pid) targets.push(this.external.pid);
    for (const pid of targets) {
      if (this.platform) await this.platform.killTree(pid);
      else await runCmd('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000 });
    }
    this.state = 'stopped';
    this.startedAt = null;
    this.external = null;
    this.statsReady = false;
    return { ok: true, killed: targets.length };
  }

  async restart(profile) {
    await this.stop();
    await sleep(800);
    return this.start(profile || this.profile);
  }

  /** 状态更新 + 统计采集（每次心跳调用） */
  async refresh() {
    // 1) 自己的进程是否存活
    if (this.proc && this.state === 'starting') {
      const alive = this.platform ? await this.platform.isPidAlive(this.proc.pid) : false;
      if (alive || this.statsReady) this.state = 'running';
    }
    // 2) 外部矿工（用户手动启动的）
    if (!this.proc || this.state === 'stopped') {
      const ext = this.external || (await this.findExternal());
      if (ext) {
        this.external = ext;
        this.state = 'running';
        if (!this.startedAt) this.startedAt = ext.startedAt || now();
      } else if (!this.proc) {
        this.state = 'stopped';
      }
    }
    // 3) 统计接口：优先 HTTP API，失败则解析日志
    const profile = this.profile || {};
    const family = profile.family || 'custom';
    let stats = null;
    if (profile.apiPort && this.state !== 'stopped') {
      const j = await probeHttp(profile.apiPort, profile.apiPath || '/', profile.apiToken || null);
      const parsed = j ? (PARSERS[family]?.(j) || null) : null;
      if (parsed) {
        stats = parsed;
        this.statsReady = true;
        this.state = 'running'; // API 有响应，说明矿工已在工作
      }
      if (process.env.MM_DEBUG) {
        this.log?.info?.(`[debug] state=${this.state} proc=${this.proc?.pid || '-'} api=${profile.apiPort}${profile.apiPath} resp=${j ? 'yes' : 'no'} parsed=${parsed ? 'yes' : 'no'}${j ? '' : ' err=' + (probeHttp.lastError || '?')}`);
      }
    }
    if (!stats && this.state !== 'stopped') {
      const logStats = parseLog(this.logFile || this.logPath());
      stats = {
        hashrate: logStats.hashrate,
        accepted: logStats.accepted,
        rejected: logStats.rejected,
        lastError: logStats.lastError,
      };
      this.logs = logStats.logs;
    } else if (this.logFile) {
      this.logs = tailFile(this.logFile, 16 * 1024).slice(-25);
    }
    this.stats = stats || {};
    this.statsAt = now();
    return { state: this.state, stats: this.stats, pid: this.proc?.pid || this.external?.pid || null };
  }

  /** 启动后等待统计接口就绪（最多 waitMs），用于单次上报/命令回执 */
  async waitReady(waitMs = 12_000) {
    const t0 = now();
    let last = null;
    while (now() - t0 < waitMs) {
      last = await this.refresh();
      if (last.state === 'running' && (num(last.stats?.hashrate) ?? 0) > 0) return last;
      await sleep(700);
    }
    return last || this.refresh();
  }

  async findExternal() {
    if (this.platform?.findProcessByExe) return this.platform.findProcessByExe(this.profile?.exe);
    return findMinerProcess(this.profile);
  }
}

async function isAlive(pid) {
  if (!pid) return false;
  const r = await runCmd('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { timeout: 6000 });
  if (!r.ok) return false;
  return new RegExp(`"${pid}"`).test(r.stdout);
}

async function findMinerProcess(profile) {
  if (!profile?.exe) return null;
  const name = path.basename(profile.exe).toLowerCase();
  const res = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-Process -Name '${name.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | Select-Object -First 1 Id,StartTime | ConvertTo-Json -Compress`], { timeout: 8000 });
  if (!res.ok || !res.stdout.trim()) return null;
  try {
    const j = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
    if (!j?.Id) return null;
    return { pid: j.Id, startedAt: j.StartTime ? Date.parse(j.StartTime) : null };
  } catch {
    return null;
  }
}

export async function detectProcesses(platform = null) {
  if (platform?.detectMiners) return platform.detectMiners();
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'xmrig|lolminer|srbminer|teamredminer|gminer|bzminer|phoenixminer|t-rex|trex|miner' -and $_.CommandLine -notmatch 'monitor' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
  const res = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 10000 });
  if (!res.ok || !res.stdout.trim()) return [];
  try {
    const j = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
    const arr = Array.isArray(j) ? j : [j];
    return arr.filter(Boolean).map((p) => ({ pid: p.ProcessId, name: p.Name, cmd: p.CommandLine }));
  } catch {
    return [];
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function maskSecret(arg) {
  const s = String(arg);
  if (s.length > 60 && /^[A-Za-z0-9]{60,}$/.test(s)) return s.slice(0, 6) + '…' + s.slice(-4);
  return s;
}

export { parseLog, probeHttp };
