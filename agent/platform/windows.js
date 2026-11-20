// Windows 平台实现
import path from 'node:path';
import { runCmd } from '../proc.js';

export function createPlatform() {
  return {
    osName: 'windows',

    async killTree(pid) {
      const r = await runCmd('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000 });
      return r.ok;
    },

    async isPidAlive(pid) {
      if (!pid) return false;
      const r = await runCmd('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { timeout: 6000 });
      if (!r.ok) return false;
      return new RegExp(`"${pid}"`).test(r.stdout);
    },

    async findProcessByExe(exePath) {
      if (!exePath) return null;
      const name = path.basename(exePath).toLowerCase().replace(/\.exe$/i, '');
      const r = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Select-Object -First 1 Id,StartTime | ConvertTo-Json -Compress`], { timeout: 8000 });
      if (!r.ok || !r.stdout.trim()) return null;
      try {
        const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
        if (!j?.Id) return null;
        return { pid: j.Id, startedAt: j.StartTime ? Date.parse(j.StartTime) : null };
      } catch {
        return null;
      }
    },

    async detectMiners() {
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'xmrig|lolminer|srbminer|teamredminer|gminer|bzminer|phoenixminer|t-rex|trex|miner' -and $_.CommandLine -notmatch 'agent.js' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
      const r = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 10000 });
      if (!r.ok || !r.stdout.trim()) return [];
      try {
        const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
        const arr = Array.isArray(j) ? j : [j];
        return arr.filter(Boolean).map((p) => ({ pid: p.ProcessId, name: p.Name, cmd: p.CommandLine }));
      } catch {
        return [];
      }
    },

    async reboot() {
      await runCmd('shutdown', ['/r', '/t', '5', '/f'], { timeout: 5000 });
      return { ok: true, message: '矿机将在 5 秒后重启' };
    },

    async shutdown() {
      await runCmd('shutdown', ['/s', '/t', '5', '/f'], { timeout: 5000 });
      return { ok: true, message: '矿机将在 5 秒后关机' };
    },

    serviceHint() {
      return '已注册计划任务 MinerMonitorAgent（SYSTEM，开机自启）';
    },
  };
}
