// 采集端：GPU 遥测（Windows）
// NVIDIA: nvidia-smi 单次批量查询；AMD: PowerShell 性能计数器（尽力而为）
import { num, round } from '../shared/util.js';
import { runCmd } from './proc.js';

const NVSMI_ARGS = [
  '--query-gpu=index,uuid,name,temperature.gpu,fan.speed,utilization.gpu,memory.used,memory.total,power.draw,power.limit,clocks.sm,clocks.mem,pstate',
  '--format=csv,noheader,nounits',
];

export function runFile(file, args, { timeout = 8000 } = {}) {
  return runCmd(file, args, { timeout });
}

export function runPowerShell(script, { timeout = 12000 } = {}) {
  return runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout });
}

/** 查询 NVIDIA GPU 与进程映射 */
export async function collectNvidia() {
  const res = await runFile('nvidia-smi', NVSMI_ARGS);
  if (!res.ok) {
    // 常见原因：未安装驱动 / nvidia-smi 不在 PATH
    if (/not recognized|not found|ENOENT/i.test(res.stderr + res.error)) return { available: false, gpus: [] };
    return { available: false, gpus: [], error: res.stderr.slice(0, 300) };
  }
  const gpus = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split(',').map((s) => s.trim());
    if (f.length < 13) continue;
    gpus.push({
      index: num(f[0]) ?? gpus.length,
      uuid: f[1],
      name: f[2],
      temp: num(f[3]),
      fan: num(f[4]),
      util: num(f[5]),
      memUsed: num(f[6]),
      memTotal: num(f[7]),
      power: num(f[8]),
      powerLimit: num(f[9]),
      clockCore: num(f[10]),
      clockMem: num(f[11]),
      pstate: num(f[12]),
      vendor: 'nvidia',
    });
  }
  // GPU 上的计算进程
  const proc = await runFile('nvidia-smi', ['--query-compute-apps=pid,gpu_uuid,process_name,used_memory', '--format=csv,noheader,nounits']);
  const procs = [];
  if (proc.ok) {
    for (const line of proc.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const f = line.split(',').map((s) => s.trim());
      if (f.length < 2) continue;
      procs.push({ pid: num(f[0]), gpuUuid: f[1], name: f[2] || '', mem: num(f[3]) });
    }
  }
  return { available: gpus.length > 0, gpus, procs };
}

/** AMD（Linux：读取 amdgpu sysfs；Windows：性能计数器尽力而为） */
export async function collectAmd() {
  if (process.platform === 'linux') {
    const mod = await import('./platform/linux.js');
    const cards = mod.readAmdSysfs();
    return { available: cards.length > 0, gpus: cards, note: cards.length ? null : '未检测到 AMD 显卡（amdgpu）' };
  }
  return collectAmdWindows();
}

async function collectAmdWindows() {
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$out = @()
$vc = Get-CimInstance Win32_VideoController
$vc | Where-Object { $_.Name -notmatch 'NVIDIA' } | ForEach-Object {
  $out += [pscustomobject]@{
    name = $_.Name
    memTotal = [double]($_.AdapterRAM / 1MB)
    driver = $_.DriverVersion
    pnp = $_.PNPDeviceID
  }
}
$counters = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue
$util = @{}
if ($counters) {
  foreach ($s in $counters.CounterSamples) {
    if ($s.Path -match 'luid_(.+?)_phys_(\\d+)_eng_(\\d+)') {
      $key = $Matches[1] + '|' + $Matches[2]
      if (-not $util.ContainsKey($key)) { $util[$key] = 0.0 }
      $util[$key] += [double]$s.CookedValue
    }
  }
}
$temp = Get-Counter '\\Thermal Zone Information(*)\\Temperature' -ErrorAction SilentlyContinue
@{
  adapters = $out
  util = $util
  hasTemp = [bool]$temp
} | ConvertTo-Json -Depth 5 -Compress
`;
  const res = await runPowerShell(ps, { timeout: 15000 });
  if (!res.ok || !res.stdout.trim()) return { available: false, gpus: [] };
  let json;
  try { json = JSON.parse(res.stdout.trim().split(/\r?\n/).pop()); } catch { return { available: false, gpus: [] }; }
  const adapters = Array.isArray(json.adapters) ? json.adapters : [];
  if (!adapters.length) return { available: false, gpus: [] };
  const utils = json.util || {};
  const utilValues = Object.values(utils).map(Number).filter((v) => Number.isFinite(v));
  const gpus = adapters.map((a, i) => ({
    index: i,
    vendor: 'amd',
    name: a.name || `AMD GPU ${i}`,
    temp: null,
    fan: null,
    util: utilValues.length ? round(Math.min(100, utilValues.reduce((x, y) => x + y, 0)), 1) : null,
    memUsed: null,
    memTotal: a.memTotal ? round(a.memTotal, 0) : null,
    power: null,
    clockCore: null,
    clockMem: null,
  }));
  return { available: true, gpus, note: 'AMD 仅能获取部分指标（温度/功耗需厂商工具）' };
}

/** 枚举正在运行的矿工进程（含命令行） */
export async function listMinerProcesses() {
  const ps = `
$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match 'xmrig|lolMiner|SRBMiner|teamredminer|gminer|bzminer|phoenixminer|trex|miner' -and
  $_.CommandLine -notmatch 'agent.js'
} | Select-Object ProcessId, Name, ExecutablePath, CommandLine, CreationDate |
  ConvertTo-Json -Depth 4 -Compress
`;
  const res = await runPowerShell(ps, { timeout: 12000 });
  if (!res.ok || !res.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.filter(Boolean).map((p) => ({
      pid: Number(p.ProcessId),
      name: String(p.Name || ''),
      path: String(p.ExecutablePath || ''),
      cmd: String(p.CommandLine || ''),
      startedAt: p.CreationDate ? Date.parse(String(p.CreationDate).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6')) : null,
    }));
  } catch {
    return [];
  }
}

/** 探测 GPU：优先 NVIDIA，失败则尝试 AMD */
export async function probeGpus() {
  const nv = await collectNvidia();
  if (nv.available) return { vendor: 'nvidia', gpus: nv.gpus, procs: nv.procs || [] };
  const amd = await collectAmd();
  return { vendor: amd.available ? 'amd' : 'none', gpus: amd.gpus || [], procs: [], note: nv.error || amd.note || '未检测到可用的 GPU 监控接口' };
}

/** CPU 温度（Linux 从 hwmon 读，Windows 返回 null） */
export async function readCpuTemperature() {
  if (process.platform !== 'linux') return null;
  try {
    const mod = await import('./platform/linux.js');
    return mod.readCpuTemp();
  } catch {
    return null;
  }
}

/** 读取某张卡的当前核心/显存频率（用于把"偏移"换算成锁频目标） */
async function currentClocks(idx) {
  const r = await runFile('nvidia-smi', ['-i', String(idx), '--query-gpu=clocks.sm,clocks.mem', '--format=csv,noheader,nounits']);
  if (!r.ok) return { core: null, mem: null };
  const [core, mem] = r.stdout.trim().split(',').map((x) => num(x));
  return { core, mem };
}

/** 应用 NVIDIA 功耗/频率设置（需要管理员权限；Windows / Linux 通用） */
export async function applyOc({ gpuIndex = 0, powerLimitW, coreClockOffset, memClockOffset, fanSpeed }) {
  const results = [];
  const idx = String(gpuIndex);
  const clocks = await currentClocks(idx);

  if (powerLimitW !== null && powerLimitW !== undefined && powerLimitW !== '') {
    results.push(await runFile('nvidia-smi', ['-i', idx, '-pl', String(Math.round(Number(powerLimitW)))]));
  }
  // 核心：值 >= 1000 视为绝对频率，否则视为相对当前频率的偏移
  if (coreClockOffset !== null && coreClockOffset !== undefined && coreClockOffset !== '') {
    const v = Math.round(Number(coreClockOffset));
    const target = v >= 1000 ? v : (clocks.core ? Math.round(clocks.core + v) : null);
    if (target) results.push(await runFile('nvidia-smi', ['-i', idx, '-lgc', String(target)]));
  }
  if (memClockOffset !== null && memClockOffset !== undefined && memClockOffset !== '') {
    const v = Math.round(Number(memClockOffset));
    const target = v >= 1000 ? v : (clocks.mem ? Math.round(clocks.mem + v) : null);
    if (target) {
      if (process.platform === 'linux') {
        // Linux 下用 nvidia-settings 锁显存（需要 X；无 X 时跳过）
        results.push(await runFile('nvidia-settings', ['-a', `[gpu:${idx}]/GPUMemoryTransferRateOffset[3]=${v}`]));
      } else {
        results.push(await runFile('nvidia-smi', ['-i', idx, '-lmc', String(target)]));
      }
    }
  }
  if (fanSpeed !== null && fanSpeed !== undefined && fanSpeed !== '') {
    const fan = Math.min(100, Math.max(20, Math.round(Number(fanSpeed))));
    if (process.platform === 'linux') {
      // nvidia-settings 需要 X display；无显示器时由 GPU 固件自动控速
      results.push(await runFile('nvidia-settings', ['-a', `[gpu:${idx}]/GPUFanControlState=1`, '-a', `[fan:${idx}]/GPUTargetFanSpeed=${fan}`]));
    } else {
      results.push(await runFile('nvidia-smi', ['-i', idx, '-fs', String(fan)]));
    }
  }
  return {
    ok: results.every((r) => r.ok),
    detail: results.map((r) => (r.ok ? (r.stdout.trim() || 'ok') : (r.stderr.trim() || r.error || 'unsupported'))).join(' | '),
  };
}
