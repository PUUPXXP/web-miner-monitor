#!/usr/bin/env node
// MinerOS 控制台状态面板（tty1）
// 直接读 /proc、nvidia-smi、配置与日志，无第三方依赖
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

const TTY = (() => {
  const i = process.argv.indexOf('--tty');
  return i >= 0 ? process.argv[i + 1] : '/dev/tty1';
})();

const CONFIG_PATH = '/etc/mineros/agent.json';
const LOG_PATH = '/var/log/mineros/agent.log';
const STATE_PATH = '/var/lib/mineros/agent-state.json';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m', white: '\x1b[37m',
  bg: '\x1b[48;5;236m',
};

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readFile(p, d = '') {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return d; }
}
function sh(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

function ip() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

function uptime() {
  const s = Math.round(Number(readFile('/proc/uptime', '0').split(' ')[0]) || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}天${h}小时` : `${h}小时${m}分`;
}

function mem() {
  const t = readFile('/proc/meminfo');
  const total = Number((t.match(/MemTotal:\s+(\d+)/) || [])[1] || 0);
  const avail = Number((t.match(/MemAvailable:\s+(\d+)/) || [])[1] || 0);
  return `${((total - avail) / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} GB`;
}

function cpuTemp() {
  for (const h of fs.existsSync('/sys/class/hwmon') ? fs.readdirSync('/sys/class/hwmon') : []) {
    const name = readFile(`/sys/class/hwmon/${h}/name`);
    if (!/k10temp|coretemp|zenpower|cpu_thermal/i.test(name)) continue;
    for (const f of fs.readdirSync(`/sys/class/hwmon/${h}`)) {
      if (!/^temp\d+_input$/.test(f)) continue;
      const v = Number(readFile(`/sys/class/hwmon/${h}/${f}`));
      if (v > 0) return Math.round(v / 1000);
    }
  }
  return null;
}

async function gpus() {
  const out = await sh('nvidia-smi', [
    '--query-gpu=index,name,temperature.gpu,fan.speed,utilization.gpu,power.draw,power.limit,memory.used,memory.total',
    '--format=csv,noheader,nounits',
  ], 3000);
  if (!out.trim()) return [];
  return out.trim().split(/\r?\n/).map((l) => {
    const f = l.split(',').map((x) => x.trim());
    return { index: f[0], name: f[1], temp: f[2], fan: f[3], util: f[4], power: f[5], limit: f[6], memUsed: f[7], memTotal: f[8] };
  });
}

async function miner() {
  const pids = fs.existsSync('/proc') ? fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)) : [];
  for (const pid of pids) {
    let cmd = '';
    try { cmd = readFile(`/proc/${pid}/cmdline`).split('\0').join(' '); } catch { continue; }
    if (/(xmrig|peakminer|srbminer|bzminer|onezerominer|wildrig|teamredminer|gminer)/i.test(cmd) && !/agent\.js/.test(cmd)) {
      return { pid, cmd };
    }
  }
  return null;
}

function tailLog(n = 6) {
  try {
    const txt = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
    return txt.slice(-n);
  } catch {
    return [];
  }
}

async function render() {
  const cfg = readJson(CONFIG_PATH) || {};
  const state = readJson(STATE_PATH) || {};
  const g = await gpus();
  const m = await miner();
  const t = cpuTemp();
  const lines = [];
  const W = 78;
  const line = (s = '') => lines.push(s);
  const bar = (ch = '─') => line(`${C.dim}${ch.repeat(W)}${C.reset}`);

  line(`${C.magenta}${C.bold}  ⛏  MinerOS${C.reset}  ${C.dim}v${readFile('/opt/mineros/VERSION', '1.1.0')}${C.reset}   ${C.dim}矿机控制台${C.reset}`);
  bar('═');
  line(`  ${C.dim}矿机名称${C.reset}  ${C.bold}${cfg.name || state.registeredName || os.hostname()}${C.reset}`);
  line(`  ${C.dim}服务器  ${C.reset}  ${cfg.serverUrl || '—'}   ${state.token ? C.green + '已注册' + C.reset : C.yellow + '未注册' + C.reset}`);
  line(`  ${C.dim}IP 地址 ${C.reset}  ${C.cyan}${ip()}${C.reset}   ${C.dim}本地控制台 http://${ip()}:4000${C.reset}`);
  line(`  ${C.dim}运行时间${C.reset}  ${uptime()}   ${C.dim}内存${C.reset} ${mem()}   ${C.dim}CPU${C.reset} ${t !== null ? t + '°C' : '—'}`);
  bar();

  line(`  ${C.bold}GPU${C.reset}  ${g.length ? '' : C.yellow + '未检测到 NVIDIA 显卡（检查驱动）' + C.reset}`);
  for (const x of g) {
    const temp = Number(x.temp);
    const tempColor = temp >= 80 ? C.red : temp >= 70 ? C.yellow : C.green;
    line(`  ${C.dim}#${x.index}${C.reset} ${x.name.padEnd(30).slice(0, 30)} ${tempColor}${String(x.temp).padStart(3)}°C${C.reset}  ${String(x.util).padStart(3)}%  ${String(x.power).padStart(4)}/${String(x.limit).padStart(4)}W  ${x.memUsed}/${x.memTotal} MB`);
  }
  bar();

  line(`  ${C.bold}矿工${C.reset}`);
  if (m) {
    line(`  ${C.green}● 运行中${C.reset}  PID ${m.pid}  ${C.dim}${m.cmd.slice(0, 90)}${C.reset}`);
  } else {
    line(`  ${C.red}○ 未运行${C.reset}  ${C.dim}（等待控制台分配飞行表，或检查矿工路径）${C.reset}`);
  }
  bar();

  line(`  ${C.bold}最近日志${C.reset}`);
  for (const l of tailLog(6)) line(`  ${C.dim}${l.slice(0, 110)}${C.reset}`);
  bar();

  line(`  ${C.dim}控制台 IP:4000 · SSH 端口 22 · 重启: reboot · 关机: poweroff${C.reset}`);
  line('');

  const text = `\x1b[2J\x1b[H${lines.join('\n')}`;
  try {
    fs.writeFileSync(TTY, text);
  } catch {
    // 非 tty 环境（如 --check）时输出到 stdout
    process.stdout.write(text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
  }
}

async function main() {
  if (process.argv.includes('--once')) {
    await render();
    return;
  }
  process.stdout.write('\x1b[?25l'); // 隐藏光标
  process.on('SIGTERM', () => { process.stdout.write('\x1b[?25h'); process.exit(0); });
  await render();
  setInterval(() => render().catch(() => {}), 5000);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
