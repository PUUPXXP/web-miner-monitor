// MinerOS 镜像管理：扫描 os/dist、读取构建元数据、生成 rig.conf、打包离线采集端
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import os from 'node:os';

const AGENT_VERSION = '1.1.0';

export class OsImage {
  constructor({ projectRoot, dataDir, log }) {
    this.projectRoot = projectRoot;
    this.dataDir = dataDir;
    this.log = log;
    this.distDir = path.join(projectRoot, 'os', 'dist');
    this.metaFile = path.join(dataDir, 'os-image.json');
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
      let meta = {};
      if (fs.existsSync(this.metaFile)) meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
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
