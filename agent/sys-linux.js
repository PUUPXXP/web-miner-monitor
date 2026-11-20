// 采集端：Linux 系统信息（/proc + /sys + df）
import fs from 'node:fs';
import os from 'node:os';
import { runCmd } from './proc.js';
import { num, round, now } from '../shared/util.js';

function readFile(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}
function readDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

const PROC_ROOT = () => process.env.MM_PROC_ROOT || '/proc';
const SYS_ROOT = () => process.env.MM_SYS_ROOT || '/sys';

let diskCache = { at: 0, value: null };
let cpuNameCache = null;
let cpuPrev = null;

export function cpuName() {
  if (cpuNameCache) return cpuNameCache;
  const text = readFile(`${PROC_ROOT()}/cpuinfo`, '');
  const m = text.match(/^model name\s*:\s*(.+)$/m);
  cpuNameCache = m ? m[1].trim() : 'Unknown CPU';
  return cpuNameCache;
}

/** 用 /proc/stat 两次采样计算 CPU 使用率 */
export function cpuLoadPercent() {
  const line = readFile(`${PROC_ROOT()}/stat`, '').split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = v[3] + (v[4] || 0);
  const total = v.reduce((a, b) => a + b, 0);
  if (!cpuPrev) { cpuPrev = { idle, total }; return 0; }
  const dIdle = idle - cpuPrev.idle;
  const dTotal = total - cpuPrev.total;
  cpuPrev = { idle, total };
  return dTotal > 0 ? round(((dTotal - dIdle) / dTotal) * 100, 1) : 0;
}

export function memInfo() {
  const text = readFile(`${PROC_ROOT()}/meminfo`, '');
  const get = (k) => Number((text.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1]) || 0;
  const totalKb = get('MemTotal');
  const availKb = get('MemAvailable') || get('MemFree');
  return {
    totalMb: round(totalKb / 1024, 0),
    usedMb: round((totalKb - availKb) / 1024, 0),
    usedPercent: totalKb ? round(((totalKb - availKb) / totalKb) * 100, 1) : null,
  };
}

/** 根分区 + 数据盘（MinerOS 上 /data 是可写的持久分区） */
export async function diskInfo() {
  if (now() - diskCache.at < 60_000 && diskCache.value) return diskCache.value;
  let value = null;
  const r = await runCmd('df', ['-Pk', '/'], { timeout: 5000 });
  if (r.ok) {
    const line = r.stdout.split('\n').find((l, i) => i > 0 && l.trim());
    if (line) {
      const f = line.trim().split(/\s+/);
      const totalGb = round(Number(f[1]) / 1048576, 1);
      const freeGb = round(Number(f[3]) / 1048576, 1);
      if (Number.isFinite(totalGb)) value = { totalGb, freeGb };
    }
  }
  diskCache = { at: now(), value };
  return value;
}

/** 主机名/版本：优先 /etc/mineros-release，其次 /etc/os-release */
export function osDescription() {
  const mm = readFile("/etc/mineros-release", '').trim();
  if (mm) return mm;
  const rel = readFile('/etc/os-release', '');
  const name = (rel.match(/^PRETTY_NAME="?([^"\n]+)/m) || [])[1];
  return `Linux${name ? ' · ' + name : ''} (${process.arch})`;
}

export function primaryIp() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) candidates.push({ name, address: i.address });
    }
  }
  const pref = candidates.find((c) => /^192\.168\./.test(c.address))
    || candidates.find((c) => /^10\./.test(c.address))
    || candidates.find((c) => /^172\.(1[6-9]|2\d|3[01])\./.test(c.address))
    || candidates[0];
  return pref?.address || '127.0.0.1';
}

export function uptimeSec() {
  const up = Number((readFile(`${PROC_ROOT()}/uptime`, '0').split(' ')[0]) || 0);
  return Math.round(up);
}

/** 采集端主机信息（字段与 Windows 版保持一致） */
export async function collectSystem() {
  const [disk] = await Promise.all([diskInfo()]);
  const mem = memInfo();
  return {
    hostname: os.hostname(),
    os: osDescription(),
    kernel: os.release(),
    cpu: cpuName(),
    cpuCores: os.cpus().length,
    cpuLoad: cpuLoadPercent(),
    memTotalMb: mem.totalMb,
    memUsedMb: mem.usedMb,
    memPercent: mem.usedPercent,
    diskTotalGb: disk?.totalGb ?? null,
    diskFreeGb: disk?.freeGb ?? null,
    uptimeSec: uptimeSec(),
    ip: primaryIp(),
    platform: process.platform,
    arch: process.arch,
    agentPid: process.pid,
  };
}
