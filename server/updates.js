// 在线升级中心：升级包目录扫描、manifest、下载与任务进度
//
// 目录结构（updates/，可由控制台上传或直接拷入）：
//   updates/
//   ├── agent/<version>/          agent.tar.gz + manifest.json（采集端，按平台分）
//   ├── miner/<minerId>/<version>/  <miner>-<version>-<platform>.tar.gz + manifest.json
//   └── system/<component>/<version>/ files.tar.gz + install.sh + manifest.json
//
// manifest.json 字段（均可选，缺省用目录推断）：
//   { "version": "1.0.0", "platform": "win32|linux|any", "notes": "...",
//     "sha256": "...", "archive": "xxx.tar.gz", "minAgent": "1.1.0" }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { now } from '../shared/util.js';

const PLATFORMS = ['win32', 'linux', 'any'];
const KINDS = ['agent', 'miner', 'system'];

function cmpVersion(a, b) {
  const pa = String(a || '0').split(/[.\-+]/).map((x) => Number(x) || 0);
  const pb = String(b || '0').split(/[.\-+]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

export class UpdateCenter {
  constructor({ projectRoot, dataDir, log }) {
    this.root = path.join(projectRoot, 'updates');
    this.dataDir = dataDir;
    this.log = log;
    this.cache = null;
    this.cacheAt = 0;
    fs.mkdirSync(path.join(this.root, 'agent'), { recursive: true });
    fs.mkdirSync(path.join(this.root, 'miner'), { recursive: true });
    fs.mkdirSync(path.join(this.root, 'system'), { recursive: true });
  }

  /** 扫描磁盘上的所有升级包 */
  scan({ refresh = false } = {}) {
    if (!refresh && this.cache && now() - this.cacheAt < 15_000) return this.cache;
    const items = [];
    for (const kind of KINDS) {
      const kindDir = path.join(this.root, kind);
      if (!fs.existsSync(kindDir)) continue;
      for (const id of fs.readdirSync(kindDir)) {
        if (id.startsWith('.') || id === 'README.md') continue;
        const idDir = path.join(kindDir, id);
        if (!fs.statSync(idDir).isDirectory()) continue;
        for (const version of fs.readdirSync(idDir)) {
          if (version.startsWith('.')) continue;
          const vDir = path.join(idDir, version);
          if (!fs.statSync(vDir).isDirectory()) continue;
          let meta = {};
          const metaFile = path.join(vDir, 'manifest.json');
          if (fs.existsSync(metaFile)) {
            try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { meta = {}; }
          }
          const archiveName = meta.archive || fs.readdirSync(vDir).find((f) => /\.(tar\.gz|tgz|zip)$/i.test(f));
          if (!archiveName) continue;
          const archive = path.join(vDir, archiveName);
          if (!fs.existsSync(archive)) continue;
          const st = fs.statSync(archive);
          items.push({
            kind,
            id,
            version: meta.version || version,
            platform: PLATFORMS.includes(meta.platform) ? meta.platform : 'any',
            archive: path.relative(this.root, archive).replace(/\\/g, '/'),
            size: st.size,
            mtime: st.mtimeMs,
            sha256: meta.sha256 || null,
            notes: meta.notes || '',
            minAgent: meta.minAgent || null,
            entry: meta.entry || null,
            install: meta.install || null,
            files: Array.isArray(meta.files) ? meta.files : null,
            dir: vDir,
          });
        }
      }
    }
    this.cache = items;
    this.cacheAt = now();
    return items;
  }

  /** 每个 kind/id/platform 的最新版本 */
  latest({ platform = null } = {}) {
    const items = this.scan();
    const best = new Map();
    for (const it of items) {
      if (platform && it.platform !== 'any' && it.platform !== platform) continue;
      const key = `${it.kind}|${it.id}|${it.platform}`;
      const cur = best.get(key);
      if (!cur || cmpVersion(it.version, cur.version) > 0) best.set(key, it);
    }
    return [...best.values()];
  }

  /** 采集端可用的升级清单 */
  feedFor({ platform, installed = {} }) {
    const latest = this.latest({ platform });
    const out = [];
    for (const it of latest) {
      const current = installed[it.kind === 'miner' ? `miner:${it.id}` : `${it.kind}`] || null;
      if (current && cmpVersion(it.version, current) <= 0) continue;
      out.push(this.publicItem(it, current));
    }
    return out;
  }

  publicItem(it, current = null) {
    return {
      kind: it.kind,
      id: it.id,
      version: it.version,
      platform: it.platform,
      size: it.size,
      notes: it.notes,
      minAgent: it.minAgent,
      entry: it.entry,
      current,
      download: `/api/updates/download/${it.kind}/${encodeURIComponent(it.id)}/${encodeURIComponent(it.version)}`,
    };
  }

  find(kind, id, version, platform = null) {
    return this.scan().find((it) => it.kind === kind && it.id === id && it.version === version
      && (!platform || it.platform === platform || it.platform === 'any'));
  }

  /** 计算（并写回）sha256 */
  async ensureSha(it) {
    if (it.sha256) return it.sha256;
    const file = path.join(this.root, it.archive);
    const sha = await sha256File(file);
    try {
      const metaFile = path.join(it.dir, 'manifest.json');
      const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
      meta.sha256 = sha;
      meta.version = meta.version || it.version;
      meta.archive = meta.archive || path.basename(file);
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    } catch { /* ignore */ }
    it.sha256 = sha;
    return sha;
  }

  /** 保存上传的升级包 */
  async saveUpload({ kind, id, version, platform = 'any', notes = '', file, originalName, minAgent = null }) {
    if (!KINDS.includes(kind)) throw new Error('未知升级类型');
    if (!/^[a-zA-Z0-9._-]{1,60}$/.test(id)) throw new Error('非法 id');
    if (!/^[a-zA-Z0-9._+-]{1,40}$/.test(version)) throw new Error('非法版本号');
    if (!PLATFORMS.includes(platform)) throw new Error('非法平台');
    const dir = path.join(this.root, kind, id, version);
    fs.mkdirSync(dir, { recursive: true });
    const archiveName = path.basename(originalName || file).replace(/[^\w.-]/g, '_');
    const target = path.join(dir, archiveName);
    fs.copyFileSync(file, target);
    const sha = await sha256File(target);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      version, platform, notes, minAgent, sha256: sha, archive: archiveName,
      uploadedAt: new Date().toISOString(),
    }, null, 2));
    this.scan({ refresh: true });
    return { kind, id, version, platform, sha256: sha, size: fs.statSync(target).size };
  }

  /** 读取文件流（支持 Range） */
  streamArtifact(it) {
    const file = path.join(this.root, it.archive);
    return { file, size: fs.statSync(file).size };
  }

  /** 概览：各类升级包与已安装版本矩阵 */
  status({ rigs = [], agentVersion = null }) {
    const latest = this.latest();
    const byKind = { agent: [], miner: [], system: [] };
    for (const it of latest) byKind[it.kind].push(this.publicItem(it));
    return {
      agentVersion,
      packages: byKind,
      counts: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length])),
      rigs: rigs.map((r) => ({
        id: r.id,
        name: r.name,
        online: !!r.online,
        os: r.os_image_version || r.os_info || null,
        agent: r.agent_version || null,
        miners: parseJson(r.miner_versions, {}),
        pending: parseJson(r.update_state, {}),
      })),
    };
  }
}

function parseJson(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
function platformOrAny(p) { return p || 'any'; }

export { cmpVersion };
