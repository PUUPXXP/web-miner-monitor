// 采集端在线升级：下载、校验、原子替换、回滚
//
// 目录约定（跨 Windows/Linux）：
//   <workDir>/miners/<minerId>/<version>/<exe>    版本化安装
//   <workDir>/miners/<minerId>/current            指向当前版本的链接
//   <workDir>/miners/<minerId>/current.txt        链接不可用时的回退
//   <workDir>/backup/                             回滚备份
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { runCmd } from './proc.js';

const IS_WIN = process.platform === 'win32';

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  try {
    const st = fs.statSync(src);
    fs.chmodSync(dst, st.mode & 0o777);
  } catch { /* ignore */ }
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

export class Updater {
  constructor({ config, log, serverUrl, token, platform }) {
    this.config = config;
    this.log = log;
    this.serverUrl = String(serverUrl || '').replace(/\/+$/, '');
    this.token = token;
    this.platform = platform || (IS_WIN ? 'win32' : 'linux');
    this.workDir = config.workDir;
    this.minerRoot = config.minerPath || path.join(this.workDir, 'miners');
    this.backupDir = path.join(this.workDir, 'backup');
    fs.mkdirSync(this.minerRoot, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  // ───────── 版本布局 ─────────
  minerDir(id) { return path.join(this.minerRoot, id); }

  /** 当前版本（current 链接 / current.txt / 目录内最高版本） */
  currentVersion(id) {
    const dir = this.minerDir(id);
    if (!fs.existsSync(dir)) return null;
    const cur = path.join(dir, 'current');
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) {
        const target = path.basename(fs.readlinkSync(cur));
        if (/^\d/.test(target)) return target;
      } else if (st.isDirectory()) {
        return fs.readFileSync(path.join(dir, 'current.txt'), 'utf8').trim() || null;
      }
    } catch { /* ignore */ }
    try {
      const txt = fs.readFileSync(path.join(dir, 'current.txt'), 'utf8').trim();
      if (txt) return txt;
    } catch { /* ignore */ }
    const versions = fs.readdirSync(dir).filter((v) => /^\d/.test(v) && fs.statSync(path.join(dir, v)).isDirectory());
    versions.sort((a, b) => cmpVersion(b, a));
    return versions[0] || null;
  }

  /** 已安装的矿工版本表 { id: version } */
  installedVersions() {
    const out = {};
    try {
      for (const id of fs.readdirSync(this.minerRoot)) {
        if (!fs.statSync(path.join(this.minerRoot, id)).isDirectory()) continue;
        const v = this.currentVersion(id);
        if (v) out[id] = v;
      }
    } catch { /* ignore */ }
    return out;
  }

  /** 解析某矿工的可执行文件路径：当前版本优先，回退旧布局 */
  resolveExe(id, binName) {
    const dir = this.minerDir(id);
    const ver = this.currentVersion(id);
    if (ver) {
      const p = path.join(dir, ver, binName);
      if (fs.existsSync(p)) return p;
    }
    const legacy = path.join(dir, binName);
    if (fs.existsSync(legacy)) return legacy;
    return null;
  }

  // ───────── 下载与校验 ─────────
  async download(url, dest, { sha256 = null, onProgress = null } = {}) {
    const full = /^https?:/i.test(url) ? url : this.serverUrl + url;
    const headers = {};
    if (this.token) headers['x-rig-token'] = this.token;
    const res = await fetch(full, { headers, signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') || 0);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(dest);
    let got = 0;
    let lastPct = -1;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.write(Buffer.from(value));
        got += value.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct >= lastPct + 10) { lastPct = pct; onProgress?.(pct); }
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (sha256) {
      const actual = await sha256File(dest);
      if (actual.toLowerCase() !== String(sha256).toLowerCase()) {
        throw new Error(`校验失败：期望 ${sha256.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…`);
      }
    }
    return dest;
  }

  // ───────── 解包 ─────────
  async extract(archive, destDir) {
    rmrf(destDir);
    fs.mkdirSync(destDir, { recursive: true });
    if (IS_WIN) {
      if (/\.zip$/i.test(archive)) {
        const r = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`], { timeout: 300000 });
        if (!r.ok) throw new Error(`解压失败: ${r.stderr || r.error}`);
      } else {
        const r = await runCmd('tar', ['-xzf', archive, '-C', destDir], { timeout: 300000 });
        if (!r.ok) throw new Error(`解压失败: ${r.stderr || r.error}`);
      }
    } else {
      const r = await runCmd('tar', ['-xzf', archive, '-C', destDir], { timeout: 300000 });
      if (!r.ok) throw new Error(`解压失败: ${r.stderr || r.error}`);
    }
    // 去掉可能存在的单层根目录
    const entries = fs.readdirSync(destDir);
    if (entries.length === 1) {
      const single = path.join(destDir, entries[0]);
      if (fs.statSync(single).isDirectory()) {
        for (const e of fs.readdirSync(single)) fs.renameSync(path.join(single, e), path.join(destDir, e));
        fs.rmdirSync(single);
      }
    }
    return destDir;
  }

  // ───────── 安装矿工 ─────────
  /**
   * @param {{id:string, version:string, url:string, sha256?:string, entry?:string, notes?:string}} pkg
   * @param {(pct:number, msg?:string)=>void} progress
   */
  async installMiner(pkg, progress = () => {}) {
    const id = String(pkg.id);
    const version = String(pkg.version);
    if (!/^[a-zA-Z0-9._-]+$/.test(id) || !/^[a-zA-Z0-9._+-]+$/.test(version)) throw new Error('非法矿工 id/版本');

    const dir = this.minerDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const staging = path.join(this.workDir, 'staging', `${id}-${version}-${Date.now()}`);
    const archive = path.join(staging, 'pkg.tar.gz');
    fs.mkdirSync(staging, { recursive: true });

    progress(5, '下载升级包');
    await this.download(pkg.url, archive, { sha256: pkg.sha256, onProgress: (p) => progress(5 + Math.round(p * 0.5), '下载升级包') });

    progress(60, '校验并解压');
    const unpack = path.join(staging, 'unpack');
    await this.extract(archive, unpack);

    // 找到入口可执行文件
    const entryName = pkg.entry || findExe(unpack, id);
    if (!entryName) throw new Error('升级包中未找到可执行文件（可用 manifest.entry 指定）');

    progress(70, '切换版本');
    const target = path.join(dir, version);
    rmrf(target);
    fs.mkdirSync(target, { recursive: true });
    copyDir(unpack, target);

    // 记录旧版本用于回滚
    const prev = this.currentVersion(id);
    if (prev) {
      const prevDir = path.join(dir, prev);
      if (fs.existsSync(prevDir)) {
        const backup = path.join(this.backupDir, `${id}-${prev}-${Date.now()}`);
        try { copyDir(prevDir, backup); } catch { /* ignore */ }
      }
    }

    // 切换 current（Linux 用符号链接，Windows 用 current.txt + 可执行位检查）
    if (!IS_WIN) {
      const link = path.join(dir, 'current');
      const tmpLink = path.join(dir, '.current.tmp');
      rmrf(tmpLink);
      try {
        fs.symlinkSync(version, tmpLink, 'dir');
        fs.renameSync(tmpLink, link);
      } catch {
        fs.writeFileSync(path.join(dir, 'current.txt'), version);
      }
      // 确保可执行
      try {
        const exe = path.join(target, entryName);
        fs.chmodSync(exe, 0o755);
      } catch { /* ignore */ }
    } else {
      fs.writeFileSync(path.join(dir, 'current.txt'), version);
    }

    progress(90, '清理');
    rmrf(staging);
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({
      id, version, entry: entryName, installedAt: Date.now(), notes: pkg.notes || '',
    }, null, 2));
    this.log?.info?.(`矿工 ${id} 已升级到 ${version}`);
    progress(100, '完成');
    return { id, version, entry: entryName, path: target, previous: prev };
  }

  /** 回滚到上一个已安装版本 */
  async rollbackMiner(id) {
    const dir = this.minerDir(id);
    const cur = this.currentVersion(id);
    const versions = fs.readdirSync(dir)
      .filter((v) => /^\d/.test(v) && fs.statSync(path.join(dir, v)).isDirectory())
      .sort((a, b) => cmpVersion(b, a));
    const prev = versions.find((v) => v !== cur);
    if (!prev) throw new Error('没有可回滚的版本');
    if (!IS_WIN) {
      const link = path.join(dir, 'current');
      rmrf(link);
      fs.symlinkSync(prev, link, 'dir');
    }
    fs.writeFileSync(path.join(dir, 'current.txt'), prev);
    this.log?.warn?.(`矿工 ${id} 回滚到 ${prev}`);
    return { id, version: prev };
  }

  // ───────── 采集端自更新 ─────────
  /** 下载采集端包到 staging，并返回替换脚本命令（由调用方执行） */
  async stageAgentUpdate(pkg, progress = () => {}) {
    const staging = path.join(this.workDir, 'staging', `agent-${Date.now()}`);
    const archive = path.join(staging, 'agent.tar.gz');
    fs.mkdirSync(staging, { recursive: true });
    progress(10, '下载采集端');
    await this.download(pkg.url, archive, { sha256: pkg.sha256, onProgress: (p) => progress(10 + Math.round(p * 0.4), '下载采集端') });
    progress(60, '解压采集端');
    const unpack = path.join(staging, 'unpack');
    await this.extract(archive, unpack);
    const src = fs.existsSync(path.join(unpack, 'agent', 'agent.js')) ? unpack : path.join(unpack, '..');
    if (!fs.existsSync(path.join(src, 'agent', 'agent.js'))) throw new Error('采集端包结构不正确');

    // 备份当前安装（目录不存在时跳过，不阻断升级）
    const backup = path.join(this.backupDir, `agent-${Date.now()}`);
    const liveAgent = path.join(this.workDir, 'agent');
    const liveShared = path.join(this.workDir, 'shared');
    try {
      if (fs.existsSync(liveAgent)) copyDir(liveAgent, path.join(backup, 'agent'));
      if (fs.existsSync(liveShared)) copyDir(liveShared, path.join(backup, 'shared'));
    } catch { /* 备份失败不阻断 */ }
    progress(80, '准备替换');
    return { staging, src, backup, version: pkg.version, hasLiveInstall: fs.existsSync(liveAgent) };
  }

  // ───────── 系统组件 ─────────
  async installSystem(pkg, progress = () => {}) {
    const staging = path.join(this.workDir, 'staging', `system-${pkg.id}-${Date.now()}`);
    const archive = path.join(staging, 'pkg.tar.gz');
    fs.mkdirSync(staging, { recursive: true });
    progress(10, '下载组件包');
    await this.download(pkg.url, archive, { sha256: pkg.sha256, onProgress: (p) => progress(10 + Math.round(p * 0.5), '下载组件包') });
    progress(65, '解压');
    const unpack = path.join(staging, 'unpack');
    await this.extract(archive, unpack);
    const backup = path.join(this.backupDir, `system-${pkg.id}-${Date.now()}`);
    fs.mkdirSync(backup, { recursive: true });
    let script = null;
    for (const cand of [pkg.install, path.join(unpack, 'install.sh'), path.join(unpack, 'install.ps1')]) {
      if (!cand) continue;
      const p = path.isAbsolute(cand) ? cand : path.join(unpack, cand);
      if (fs.existsSync(p)) { script = p; break; }
    }
    progress(80, '执行安装脚本');
    if (!script) { rmrf(staging); return { id: pkg.id, version: pkg.version, skipped: true, message: '包内没有 install 脚本，已解压但未安装' }; }
    const env = {
      ...process.env,
      MM_BACKUP_DIR: backup,
      MM_PACKAGE_DIR: unpack,
      MM_VERSION: String(pkg.version),
      MM_COMPONENT: String(pkg.id),
    };
    let r;
    if (/\.ps1$/i.test(script)) {
      if (!IS_WIN) throw new Error('该组件包是 Windows 安装脚本（.ps1），不能用于 Linux 矿机');
      // 通过 -Command 注入环境变量（execFile 不方便传 env）
      const psEnv = Object.entries({
        MM_BACKUP_DIR: backup,
        MM_PACKAGE_DIR: unpack,
        MM_VERSION: String(pkg.version),
        MM_COMPONENT: String(pkg.id),
      }).map(([k, v]) => `$env:${k}='${String(v).replace(/'/g, "''")}';`).join('');
      const scriptPath = script.replace(/'/g, "''");
      r = await runCmd('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `${psEnv} & '${scriptPath}'`], { timeout: 600000 });
    } else {
      if (IS_WIN) {
        throw new Error('该组件包是 Linux 安装脚本（.sh），不能用于 Windows 矿机；请改用 install.ps1 的包');
      }
      r = await new Promise((resolve) => {
        execFile('bash', [script], { timeout: 600000, env }, (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || err?.message || '', error: err?.message }));
      });
    }
    rmrf(staging);
    if (!r.ok) throw new Error(`安装脚本失败: ${(r.stderr || r.error || '').slice(0, 800)}`);
    progress(100, '完成');
    return { id: pkg.id, version: pkg.version, output: (r.stdout || '').slice(0, 2000) };
  }
}

/** Windows 路径 → bash 可识别的路径（C:\a\b → /c/a/b），非 Windows 原样返回 */
function toBashPath(p) {
  if (!IS_WIN) return p;
  const norm = path.resolve(p).replace(/\\/g, '/');
  const m = norm.match(/^([A-Za-z]):\/(.*)$/);
  return m ? `/${m[1].toLowerCase()}/${m[2]}` : norm;
}

function cmpVersion(a, b) {
  const pa = String(a || '0').split(/[.\-+]/).map((x) => Number(x) || 0);
  const pb = String(b || '0').split(/[.\-+]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function findExe(dir, id) {
  const preferred = IS_WIN ? ['.exe', '.bat', '.cmd'] : ['', '.bin'];
  const walk = (d, depth) => {
    if (depth > 3) return null;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const r = walk(p, depth + 1);
        if (r) return r;
      } else {
        const lower = e.name.toLowerCase();
        if (IS_WIN && lower.endsWith('.exe')) return path.relative(dir, p);
        if (!IS_WIN && !lower.includes('.') && (e.name === id || /miner|xmrig|srb|peak|bz|onezero|wildrig|gminer|teamred/i.test(e.name))) {
          return path.relative(dir, p);
        }
        if (!IS_WIN && preferred.includes('') && !lower.includes('.')) return path.relative(dir, p);
      }
    }
    return null;
  };
  return walk(dir, 0);
}

export { cmpVersion, sha256File };
