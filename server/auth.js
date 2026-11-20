// 认证与会话：管理员口令登录（scrypt）、HttpOnly Cookie 会话、采集端 Token
import crypto from 'node:crypto';
import { safeEqual, verifyPassword, now } from '../shared/util.js';

const COOKIE_NAME = 'mm_session';
const SESSION_TTL = 7 * 24 * 3600 * 1000;

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export function parseAuth(req) {
  const cookieToken = parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
  const auth = String(req.headers.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  return { cookieToken, bearer, token: bearer || cookieToken || String(req.headers['x-auth-token'] || '') || null };
}

export function rigTokenFrom(req, url) {
  const h = String(req.headers['x-rig-token'] || req.headers['x-api-key'] || '');
  if (h) return h.trim();
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(url?.searchParams?.get('token') || '');
}

export class Auth {
  constructor(db, { https = false } = {}) {
    this.db = db;
    this.https = https;
    this.failures = new Map(); // ip -> { count, until }
  }

  /** 登录限流：5 分钟内 10 次失败则锁定 5 分钟 */
  checkRate(ip) {
    const f = this.failures.get(ip);
    if (!f) return { ok: true };
    if (f.until && f.until > now()) {
      return { ok: false, retryAfter: Math.ceil((f.until - now()) / 1000) };
    }
    return { ok: true };
  }
  recordFailure(ip) {
    const f = this.failures.get(ip) || { count: 0, first: now(), until: 0 };
    f.count += 1;
    if (f.count >= 10) {
      f.until = now() + 5 * 60_000;
      f.count = 0;
    }
    this.failures.set(ip, f);
  }
  clearFailures(ip) { this.failures.delete(ip); }

  login(username, password, ip, userAgent = '') {
    const rate = this.checkRate(ip);
    if (!rate.ok) return { error: `尝试过于频繁，请 ${rate.retryAfter} 秒后再试`, status: 429 };
    const user = this.db.verifyUser(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      this.recordFailure(ip);
      return { error: '用户名或密码错误', status: 401 };
    }
    this.clearFailures(ip);
    this.db.q.touchLogin.run(now(), user.id);
    const token = this.db.createSession(user.id, SESSION_TTL, userAgent);
    return { token, user: { id: user.id, username: user.username, role: user.role } };
  }

  userFor(req) {
    const { token } = parseAuth(req);
    if (!token) return null;
    const s = this.db.sessionUser(token);
    if (!s) return null;
    return { id: s.user_id, username: s.username, role: s.role, sessionToken: token };
  }

  sessionCookie(token) {
    const attrs = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL / 1000)}`];
    if (this.https) attrs.push('Secure');
    return attrs.join('; ');
  }
  clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  /** WebSocket 升级时校验浏览器会话 */
  verifyWs(req) {
    const { token } = parseAuth(req);
    return !!this.db.sessionUser(token);
  }

  /** 采集端校验：返回 rig 行或 null */
  rigFor(req, url) {
    const token = rigTokenFrom(req, url);
    if (!token) return null;
    const rig = this.db.rigByToken(token);
    if (!rig) return null;
    // 常量时间比较（防止时序侧信道）
    return safeEqual(rig.token, token) ? rig : null;
  }
}

export { COOKIE_NAME, SESSION_TTL };
