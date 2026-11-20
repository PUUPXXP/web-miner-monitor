// 共享工具函数：无第三方依赖，服务端与采集端共用
import crypto from 'node:crypto';

export const now = () => Date.now();

/** 数值裁剪 */
export function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** 安全转数字，失败返回 null（避免 0 混淆"未知"） */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/%$/, '').replace(/,/g, '');
  if (s === '' || /^(n\/a|na|not supported|unknown|-+)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function round(n, digits = 2) {
  const v = num(n);
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function slugify(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并（数组整体替换） */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 按点路径取/设值，如 get(obj, 'a.b.c') */
export function getPath(obj, path, fallback) {
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}

// ───────────────────────── 哈希 / 口令 ─────────────────────────
export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

export function hmacKey(secret, s) {
  return crypto.createHmac('sha256', secret).update(String(s)).digest();
}

/** scrypt 口令哈希，格式 scrypt$N$r$p$salt$hash */
export function hashPassword(password, opts = {}) {
  const N = opts.N ?? 16384;
  const r = opts.r ?? 8;
  const p = opts.p ?? 1;
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const key = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** 常量时间字符串比较 */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 生成矿机接入密钥：prl_ + 32 位随机 */
export function newRigKey() {
  return 'rig_' + crypto.randomBytes(24).toString('base64url');
}

// ───────────────────────── 时间 / 格式化 ─────────────────────────
export function fmtHash(h, unit = 'H/s') {
  const v = num(h);
  if (v === null || v <= 0) return '0 ' + unit;
  const steps = [['TH', 1e12], ['GH', 1e9], ['MH', 1e6], ['kH', 1e3]];
  for (const [prefix, base] of steps) {
    if (v >= base) return `${(v / base).toFixed(v / base >= 100 ? 1 : 2)} ${prefix}${unit}`;
  }
  return `${v.toFixed(1)} ${unit}`;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(num(ms) ?? 0) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  if (m > 0) return `${m}分 ${Math.floor(s % 60)}秒`;
  return `${Math.floor(s)}秒`;
}

export function fmtAgo(ts, ref = Date.now()) {
  const t = num(ts);
  if (!t) return '从未';
  const diff = Math.max(0, ref - t);
  if (diff < 1500) return '刚刚';
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

/** 本地时区 YYYY-MM-DD HH:mm:ss */
export function fmtTime(ts, { date = true, seconds = true } = {}) {
  const t = num(ts);
  if (!t) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const hms = `${p(d.getHours())}:${p(d.getMinutes())}${seconds ? ':' + p(d.getSeconds()) : ''}`;
  return date ? `${ymd} ${hms}` : hms;
}

export function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ───────────────────────── 其它 ─────────────────────────
export function uid(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

/** 异步重试 */
export async function retry(fn, { tries = 3, delay = 1000, label = '' } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i < tries) await sleep(delay * i);
    }
  }
  throw new Error(`${label || '操作'}失败: ${lastErr?.message ?? lastErr}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function truncate(s, n = 200) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/** 逐行读取文本尾部（用于矿工日志），避免整文件载入 */
export function tailLines(text, n = 40) {
  return String(text ?? '').split(/\r?\n/).filter(Boolean).slice(-n);
}
