// MinerOS 镜像管理：扫描 os/dist、读取构建元数据、生成 rig.conf、打包离线采集端
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import os from 'node:os';
import { AGENT_VERSION } from '../shared/version.js';

export class OsImage {
  constructor({ projectRoot, dataDir, log }) {
    this.projectRoot = projectRoot;
    this.dataDir = dataDir;
    this.log = log;
    this.distDir = path.join(projectRoot, 'os', 'dist');
    this.metaFile = path.join(dataDir, 'os-image.json');
    this.distMetaFile = path.join(this.distDir, 'os-image.json');
    this.buildRoot = process.env.MM_BUILD_ROOT || '/var/lib/mineros-build';
    this.buildStatusFile = path.join(this.buildRoot, 'status.json');
    this.cache = null;
    this.cacheAt = 0;
  }

  /** 扫描镜像文件与 .sha256，返回元数据 */
  info({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.cacheAt < 30_000) return this.cache;
    const out = {
      available: false,
      version: '1.0.0',
      agentVersion: AGENT_VERSION,
      file: null,
      size: null,
      sha256: null,
      builtAt: null,
      base: 'Debian 12 bookworm amd64',
      requirements: { usbMinGb: 8, usbRecommendedGb: 16, bios: true, uefi: true },
      distDir: this.distDir,
    };
    try {
      // 元数据：优先 data 目录，其次 os/dist（服务器自动构建写这里）
      let meta = {};
      for (const f of [this.metaFile, this.distMetaFile]) {
        if (!fs.existsSync(f)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(f, 'utf8'));
          meta = { ...m, ...meta }; // 前者优先
        } catch { /* ignore */ }
      }
      const files = fs.existsSync(this.distDir)
        ? fs.readdirSync(this.distDir).filter((f) => f.endsWith('.iso')).sort()
        : [];
      if (files.length) {
        const file = path.join(this.distDir, files[files.length - 1]);
        const st = fs.statSync(file);
        out.available = true;
        out.file = path.basename(file);
        out.size = st.size;
        out.builtAt = meta.builtAt || st.mtimeMs;
        const shaPath = `${file}.sha256`;
        if (fs.existsSync(shaPath)) {
          out.sha256 = fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
        } else {
          out.sha256 = null; // 按需计算（较慢，不在这里做）
        }
        out.version = meta.version || (out.file.match(/mineros-([\d.]+)-/)?.[1] ?? '1.0.0');
      }
    } catch (e) {
      this.log?.warn?.(`读取镜像信息失败: ${e.message}`);
    }
    this.cache = out;
    this.cacheAt = Date.now();
    return out;
  }

  filePath() {
    const info = this.info({ refresh: true });
    return info.available ? path.join(this.distDir, info.file) : null;
  }

  /** 服务器自动构建的进度（读 /var/lib/mineros-build/status.json） */
  buildStatus() {
    const out = {
      supported: fs.existsSync(this.buildRoot),
      state: 'idle',
      percent: 0,
      message: '尚未构建',
      startedAt: null,
      updatedAt: null,
      elapsedSec: 0,
      logTail: '',
      stale: false,
    };
    try {
      if (fs.existsSync(this.buildStatusFile)) {
        const s = JSON.parse(fs.readFileSync(this.buildStatusFile, 'utf8'));
        Object.assign(out, s);
        // 用 startedAt 现算，避免 status.json 更新不及时导致耗时显示不动
        if (out.startedAt) out.elapsedSec = Math.max(0, Math.round((Date.now() - out.startedAt) / 1000));
        const ageSec = (Date.now() - (out.updatedAt || 0)) / 1000;
        // 构建中但 20 分钟没更新 → 认为卡死
        if (['preparing', 'building', 'publishing'].includes(out.state) && ageSec > 2700) {
          out.stale = true;
          out.message = `构建可能卡住（${Math.round(ageSec / 60)} 分钟无更新）`;
        }
      }
    } catch { /* ignore */ }
    return out;
  }

  /** 触发一次构建（需要 sudoers 允许 minermon 启停该 unit） */
  async startBuild() {
    const { spawn } = await import('node:child_process');
    const st = this.buildStatus();
    if (['preparing', 'building', 'publishing'].includes(st.state) && !st.stale) {
      return { ok: false, message: '已有构建在进行中' };
    }
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('sudo', ['-n', 'systemctl', 'start', '--no-block', 'mineros-build.service'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        return resolve({ ok: false, message: e.message });
      }
      let err = '';
      child.stderr?.on('data', (c) => { err += c; });
      child.on('error', (e) => resolve({ ok: false, message: `无法触发构建: ${e.message}` }));
      child.on('exit', (code) => {
        if (code === 0) resolve({ ok: true, message: '构建已启动' });
        else resolve({ ok: false, message: (err || `退出码 ${code}`).slice(0, 300) });
      });
    });
  }

  /** 计算 sha256（流式，避免大文件占用内存） */
  async sha256() {
    const file = this.filePath();
    if (!file) return null;
    const info = this.info({ refresh: true });
    if (info.sha256) return info.sha256;
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const s = fs.createReadStream(file);
      s.on('data', (c) => hash.update(c));
      s.on('end', resolve);
      s.on('error', reject);
    });
    const hex = hash.digest('hex');
    try { fs.writeFileSync(`${file}.sha256`, `${hex}  ${path.basename(file)}\n`); } catch { /* ignore */ }
    this.cache = { ...info, sha256: hex };
    return hex;
  }

  /** 生成 U 盘根目录的 rig.conf */
  rigConf({ serverUrl, rig, token = null }) {
    const lines = [
      '# MinerOS rig.conf — 首次启动自动读取',
      `# 生成时间: ${new Date().toISOString()}`,
      `# 矿机: ${rig.name} (${rig.id})`,
      `SERVER_URL=${String(serverUrl).replace(/\/+$/, '')}`,
      `RIG_NAME=${rig.name}`,
      'ALLOW_REBOOT=true',
      'ALLOW_RUN=true',
    ];
    if (rig.coin) lines.push(`# 币种: ${rig.coin}`);
    if (token) {
      lines.push(`RIG_PASSWD=${token}`);
      lines.push(`RIG_ID=${rig.id}`);
    } else {
      lines.push('# 未包含密钥：首次启动将自动注册（需在设置中开启自动注册）');
    }
    return lines.join('\n') + '\n';
  }

  /** 打包采集端（tar.gz，供 MinerOS 首启离线安装）
   *  内容为 agent/* 与 shared/*（不带顶层目录），首启解压到 /opt/mineros 即可
   */
  agentTarball() {
    const agentDir = path.join(this.projectRoot, 'agent');
    const sharedDir = path.join(this.projectRoot, 'shared');
    const files = {};
    const skip = /(^|\/)(agent-state\.json|config\.json|logs\/|node_modules\/|\.log$)/;
    const add = (dir, prefix) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = `${prefix}${f.name}`;
        if (skip.test(rel)) continue;
        const full = path.join(dir, f.name);
        if (f.isDirectory()) add(full, `${rel}/`);
        else files[rel] = fs.readFileSync(full);
      }
    };
    add(agentDir, 'agent/');
    add(sharedDir, 'shared/');
    return makeTarGz(files);
  }
}

/** 生成 tar.gz（USTAR + gzip），零依赖 */
export function makeTarGz(files, prefix = '') {
  const chunks = [];
  const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const fullName = prefix ? `${prefix}/${name.replace(/^\/+/, '')}` : name;
    const header = Buffer.alloc(512);
    header.write(fullName.slice(0, 100), 0, 'utf8');
    header.write('0000644\0', 100);          // mode
    header.write('0000000\0', 108);          // uid
    header.write('0000000\0', 116);          // gid
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    header.write('        ', 148);           // checksum placeholder
    header.write('0', 156);                  // typeflag: regular
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write('root'.padEnd(32, '\0'), 265);
    header.write('root'.padEnd(32, '\0'), 297);
    // 校验和
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, data, pad(data.length));
  }
  chunks.push(Buffer.alloc(1024)); // 两个 512 字节的零块结束
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

export { AGENT_VERSION };
