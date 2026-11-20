// Linux 平台实现（MinerOS 使用）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCmd } from '../proc.js';

function readFile(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

function readDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

// 根目录可覆盖（测试/调试：MM_PROC_ROOT、MM_SYS_ROOT）
const PROC_ROOT = () => process.env.MM_PROC_ROOT || '/proc';
const SYS_ROOT = () => process.env.MM_SYS_ROOT || '/sys';

export function createPlatform() {
  return {
    osName: 'linux',

    async killTree(pid) {
      if (!pid) return false;
      // 先尝试优雅退出（SIGTERM），1.5 秒后强杀
      await runCmd('kill', ['-TERM', String(pid)], { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 1200));
      if (await this.isPidAlive(pid)) {
        await runCmd('kill', ['-KILL', `-${pid}`], { timeout: 3000 });
        await runCmd('kill', ['-KILL', String(pid)], { timeout: 3000 });
      }
      return true;
    },

    async isPidAlive(pid) {
      if (!pid) return false;
      try {
        // 进程存在：/proc/<pid> 可读；僵尸进程另用 stat 判断
        fs.statSync(`${PROC_ROOT()}/${pid}`);
      } catch {
        return false;
      }
      const stat = readFile(`${PROC_ROOT()}/${pid}/stat`, '');
      const state = stat.split(') ')[1]?.split(' ')[0];
      return state !== 'Z';
    },

    async findProcessByExe(exePath) {
      if (!exePath) return null;
      const base = path.basename(exePath);
      for (const pidDir of readDir(PROC_ROOT())) {
        if (!/^\d+$/.test(pidDir)) continue;
        const cmd = readFile(`${PROC_ROOT()}/${pidDir}/cmdline`, '').split('\0').filter(Boolean);
        if (!cmd.length) continue;
        if (path.basename(cmd[0]) === base || cmd.some((c) => path.basename(c) === base)) {
          const stat = readFile(`${PROC_ROOT()}/${pidDir}/stat`, '');
          const startTicks = Number(stat.split(') ')[1]?.split(' ')[19]);
          const startedAt = Number.isFinite(startTicks) ? Math.round(startTicks / 100) * 10 : null;
          return { pid: Number(pidDir), startedAt };
        }
      }
      return null;
    },

    async detectMiners() {
      const out = [];
      for (const pidDir of readDir(PROC_ROOT())) {
        if (!/^\d+$/.test(pidDir)) continue;
        const cmd = readFile(`${PROC_ROOT()}/${pidDir}/cmdline`, '').split('\0').filter(Boolean);
        if (!cmd.length) continue;
        const joined = cmd.join(' ');
        // 跳过采集端/本地控制台自身
        if (/\bagent\.js\b|\blan-console\.js\b|\bstatus-panel\.js\b|\bmineros-update\b/i.test(joined)) continue;
        if (!/(xmrig|lolminer|srbminer|teamredminer|gminer|bzminer|onezerominer|wildrig|phoenixminer|t-rex|trex|miner)/i.test(joined)) continue;
        const comm = readFile(`${PROC_ROOT()}/${pidDir}/comm`, '').trim();
        out.push({ pid: Number(pidDir), name: comm || path.basename(cmd[0]), cmd: joined });
      }
      return out;
    },

    async reboot() {
      await runCmd('systemctl', ['reboot'], { timeout: 5000 });
      return { ok: true, message: '矿机将在 5 秒后重启' };
    },

    async shutdown() {
      await runCmd('systemctl', ['poweroff'], { timeout: 5000 });
      return { ok: true, message: '矿机将在 5 秒后关机' };
    },

    serviceHint() {
      return '已启用 systemd 服务 mineros-agent（开机自启）';
    },
  };
}

// ───────── Linux GPU 采集 ─────────
/** 读 AMD amdgpu 的 hwmon 数据 */
export function readAmdSysfs() {
  const cards = [];
  const drmDir = SYS_ROOT() + "/class/drm";
  for (const entry of readDir(drmDir)) {
    const m = /^card(\d+)$/.exec(entry);
    if (!m) continue;
    const device = path.join(drmDir, entry, 'device');
    const vendor = readFile(path.join(device, 'vendor'), '').trim();
    if (vendor !== '0x1002') continue; // AMD
    const index = Number(m[1]);
    const hwmons = readDir(path.join(device, 'hwmon')).filter((x) => x.startsWith('hwmon'));
    let temp = null;
    let fan = null;
    let power = null;
    for (const h of hwmons) {
      const base = path.join(device, 'hwmon', h);
      for (const f of readDir(base)) {
        if (/^temp\d+_input$/.test(f)) {
          const v = Number(readFile(path.join(base, f), '').trim());
          if (Number.isFinite(v) && v > 0 && v < 150000) temp = Math.round(v / 1000);
        }
        if (/^fan\d+_input$/.test(f)) {
          const v = Number(readFile(path.join(base, f), '').trim());
          if (Number.isFinite(v) && v > 0) fan = Math.min(100, Math.round(v / 30));
        }
        if (/^power\d+_average$/.test(f)) {
          const v = Number(readFile(path.join(base, f), '').trim());
          if (Number.isFinite(v) && v > 0) power = Math.round(v / 1e6);
        }
      }
    }
    const name = readFile(path.join(device, 'product_name'), '').trim();
    const memTotalKb = Number(readFile(path.join(device, 'mem_info_vram_total'), '0').trim());
    const memUsedKb = Number(readFile(path.join(device, 'mem_info_vram_used'), '0').trim());
    const clocks = readFile(path.join(device, 'pp_dpm_sclk'), '');
    const clockCore = Number((clocks.match(/(\d+)Mhz\s*\*/i) || [])[1]) || null;
    cards.push({
      index,
      vendor: 'amd',
      name: name || `AMD GPU ${index}`,
      temp,
      fan,
      power,
      util: null,
      memUsed: memUsedKb ? Math.round(memUsedKb / 1024) : null,
      memTotal: memTotalKb ? Math.round(memTotalKb / 1024) : null,
      clockCore,
      clockMem: null,
    });
  }
  return cards;
}

/** CPU 温度（k10temp / coretemp） */
export function readCpuTemp() {
  for (const h of readDir(SYS_ROOT() + "/class/hwmon")) {
    const name = readFile(`${SYS_ROOT()}/class/hwmon/${h}/name`, '').trim();
    if (!/k10temp|coretemp|zenpower|cpu_thermal/i.test(name)) continue;
    for (const f of readDir(`${SYS_ROOT()}/class/hwmon/${h}`)) {
      if (!/^temp\d+_input$/.test(f)) continue;
      const v = Number(readFile(`${SYS_ROOT()}/class/hwmon/${h}/${f}`, '').trim());
      if (Number.isFinite(v) && v > 0) return Math.round(v / 1000);
    }
  }
  return null;
}
