// 采集端命令执行封装：所有外部命令统一入口，避免 spawn 异常导致进程崩溃
import { execFile } from 'node:child_process';

/**
 * 执行外部程序。
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, error:string|null, code:number|null}>}
 */
export function runCmd(file, args = [], { timeout = 10_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    const finish = (r) => resolve({ ok: false, stdout: '', stderr: '', error: null, code: null, ...r });
    try {
      child = execFile(file, args, { timeout, windowsHide: true, maxBuffer }, (err, stdout, stderr) => {
        const out = String(stdout || '');
        const errOut = String(stderr || '');
        if (err) {
          const code = typeof err.code === 'number' ? err.code : null;
          finish({ ok: false, stdout: out, stderr: errOut, error: err.message, code });
        } else {
          resolve({ ok: true, stdout: out, stderr: errOut, error: null, code: 0 });
        }
      });
      child?.on?.('error', (err) => finish({ error: err.message }));
    } catch (e) {
      // 极端情况下（沙箱/权限）execFile 同步抛出 EPERM
      finish({ error: e.message });
    }
  });
}

export function runPowerShell(script, { timeout = 15_000 } = {}) {
  return runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout });
}

export function runPowerShellFile(file, { timeout = 60_000 } = {}) {
  return runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { timeout });
}
