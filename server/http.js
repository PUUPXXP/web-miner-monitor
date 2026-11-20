// HTTP 基础工具：JSON 响应、请求体解析、静态文件、路由分发
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export function sendError(res, status, message, code = null) {
  sendJson(res, status, { error: message, code });
}

export function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      const buf = Buffer.concat(chunks);
      const type = String(req.headers['content-type'] || '');
      const text = buf.toString('utf8');
      if (type.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
        try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, 'JSON 格式错误')); }
      } else {
        resolve(text);
      }
    });
    req.on('error', reject);
  });
}

export function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

export function prefersJson(req) {
  return String(req.headers.accept || '').includes('application/json');
}

/** 简单静态文件服务（带缓存头 + 防目录穿越） */
export function serveStatic(rootDir, urlPath, req, res) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(rootDir, rel));
  if (!filePath.startsWith(path.normalize(rootDir + path.sep))) {
    return sendError(res, 403, '禁止访问');
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    etag,
    'x-content-type-options': 'nosniff',
  });
  createReadStream(filePath).pipe(res);
  return true;
}

/** 轻量路由匹配：'GET /api/rigs/:id' */
export function makeRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => {
      keys.push(k);
      return '/([^/]+)';
    }).replace(/\*/g, '.*') + '$');
    routes.push({ method, re, keys, handler });
  };
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
      return null;
    },
  };
}
