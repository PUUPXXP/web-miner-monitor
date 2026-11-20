// 跨平台能力抽象：采集端逻辑共用，Windows / Linux 各自实现
// 进程管理、开机自启、关机重启、探测进程列表
import os from 'node:os';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_LINUX = process.platform === 'linux';
export const OS_NAME = IS_WINDOWS ? 'windows' : IS_LINUX ? 'linux' : process.platform;

/**
 * 平台实现接口：
 *   osName                                  'windows' | 'linux'
 *   killTree(pid)                           结束进程（含子进程）
 *   isPidAlive(pid)                         进程是否存活
 *   findProcessByExe(exePath)               { pid, startedAt } | null
 *   detectMiners()                          [{ pid, name, cmd }]
 *   reboot()/shutdown()                     返回 { ok, message }
 *   serviceHint()                           安装为服务/开机的提示
 *   sysInfo()                               平台系统信息
 */
export async function loadPlatform() {
  if (IS_WINDOWS) {
    const mod = await import('./platform/windows.js');
    return mod.createPlatform();
  }
  const mod = await import('./platform/linux.js');
  return mod.createPlatform();
}
