// 采集端：主机系统信息（CPU/内存/磁盘/网络/运行时长）
import os from 'node:os';
import { num, round, now } from '../shared/util.js';
import { runCmd } from './proc.js';

let diskCache = { at: 0, value: null };
let cpuNameCache = null;

export function cpuName() {
  if (cpuNameCache) return cpuNameCache;
  const cpus = os.cpus();
  cpuNameCache = cpus?.[0]?.model || '未知 CPU';
  return cpuNameCache;
}

export function primaryIp() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) candidates.push({ name, address: i.address });
    }
  }
  // 优先常见内网网段
  const pref = candidates.find((c) => /^192\.168\./.test(c.address))
    || candidates.find((c) => /^10\./.test(c.address))
    || candidates.find((c) => /^172\.(1[6-9]|2\d|3[01])\./.test(c.address))
    || candidates[0];
  return pref?.address || '127.0.0.1';
}

export async function diskInfo() {
  if (now() - diskCache.at < 60_000 && diskCache.value) return diskCache.value;
  const ps = "$d = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\"; if ($d) { \"{0}|{1}\" -f $d.Size, $d.FreeSpace }";
  const r = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000 });
  let value = null;
  if (r.ok && r.stdout.includes('|')) {
    const [total, free] = r.stdout.trim().split('|').map(Number);
    if (Number.isFinite(total) && total > 0) {
      value = { totalGb: round(total / 1073741824, 1), freeGb: round(free / 1073741824, 1) };
    }
  }
  diskCache = { at: now(), value };
  return value;
}

export function memInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    totalMb: round(total / 1048576, 0),
    usedMb: round((total - free) / 1048576, 0),
    usedPercent: round(((total - free) / total) * 100, 1),
  };
}

export function cpuLoadPercent() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  const used = total - idle;
  return total > 0 ? round((used / total) * 100, 1) : null;
}

export async function collectSystem() {
  const disk = await diskInfo();
  return {
    hostname: os.hostname(),
    os: `Windows ${os.release()} (${process.arch})`,
    cpu: cpuName(),
    cpuCores: os.cpus().length,
    cpuLoad: cpuLoadPercent(),
    memTotalMb: round(os.totalmem() / 1048576, 0),
    memUsedMb: round((os.totalmem() - os.freemem()) / 1048576, 0),
    memPercent: round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100, 1),
    diskTotalGb: disk?.totalGb ?? null,
    diskFreeGb: disk?.freeGb ?? null,
    uptimeSec: Math.round(os.uptime()),
    ip: primaryIp(),
    platform: process.platform,
    arch: process.arch,
    agentPid: process.pid,
  };
}
