// 服务端入口：HTTP + WebSocket + 定时任务
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { openDb } from './db.js';
import { Auth } from './auth.js';
import { EventBus } from './events.js';
import { Collector } from './collector.js';
import { History } from './history.js';
import { AlertEngine } from './alerts.js';
import { NetworkStats } from './network.js';
import { createApi } from './api.js';
import { serveStatic, sendJson, sendError } from './http.js';
import { now, hashPassword } from '../shared/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '1.0.0';

// ───────── 日志 ─────────
const LOG_DIR = process.env.MM_LOG_DIR || path.join(ROOT, 'data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, 'server.log');
function logLine(level, msg) {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
  const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
  console.log(`${color}${line}\x1b[0m`);
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
}
const log = {
  info: (m) => logLine('info', m),
  warn: (m) => logLine('warn', m),
  error: (m) => logLine('error', m),
};

// ───────── 配置 ─────────
function loadConfig() {
  const file = process.env.MM_CONFIG || path.join(ROOT, 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { log.warn(`config.json 解析失败: ${e.message}`); }
  }
  const env = process.env;
  const pick = (envKey, cfgKey, fallback) => env[envKey] ?? cfg[cfgKey] ?? fallback;
  return {
    host: pick('MM_HOST', 'host', '0.0.0.0'),
    port: Number(pick('MM_PORT', 'port', 8787)),
    dataDir: path.resolve(ROOT, pick('MM_DATA_DIR', 'dataDir', 'data')),
    adminUser: pick('MM_ADMIN_USER', 'adminUser', 'admin'),
    adminPassword: pick('MM_ADMIN_PASSWORD', 'adminPassword', ''),
    https: String(pick('MM_HTTPS', 'https', 'false')) === 'true',
    publicUrl: pick('MM_PUBLIC_URL', 'publicUrl', ''),
    agentAutoRegister: String(pick('MM_AGENT_AUTO_REGISTER', 'agentAutoRegister', 'true')) === 'true',
  };
}

const cfg = loadConfig();
const startedAt = now();

// ───────── 初始化 ─────────
const db = openDb(cfg.dataDir);
const bus = new EventBus();
const collector = new Collector(db, bus, log);
const history = new History(db);
const network = new NetworkStats(log);
const alerts = new AlertEngine(db, bus, collector, log);
const auth = new Auth(db, { https: cfg.https });

// 首次启动创建管理员（未显式配置密码时生成随机密码并写入文件）
const initialPassword = cfg.adminPassword || crypto.randomBytes(9).toString('base64url');
const admin = db.ensureAdmin(cfg.adminUser, initialPassword);
if (admin.created) {
  const file = path.join(cfg.dataDir, '初始管理员密码.txt');
  fs.writeFileSync(file, `用户名: ${cfg.adminUser}\n密码: ${initialPassword}\n\n请登录后立即在「设置」中修改密码，并删除本文件。\n`, 'utf8');
  logLine('info', '════════════════════════════════════════════');
  logLine('info', ' 首次启动，已创建管理员账号');
  logLine('info', `   用户名: ${cfg.adminUser}`);
  logLine('info', `   密  码: ${initialPassword}`);
  logLine('info', `   已写入: ${file}`);
  logLine('info', '════════════════════════════════════════════');
}

// 内置默认飞行表（首次使用模板）
function seedDefaults() {
  if (db.listFlightSheets().length > 0) return;
  db.saveFlightSheet({
    name: '门罗 XMRig · 示例',
    coin: 'XMR',
    isDefault: 1,
    config: {
      miner: 'xmrig',
      poolUrl: 'pool.supportxmr.com:3333',
      poolUser: '4YOUR_MONERO_WALLET_ADDRESS_HERE_REPLACE_ME_0000000000000000000000000000000000000000000000',
      poolPass: 'x',
      workerName: '{rig}',
      algo: 'rx/0',
      tls: false,
      apiPort: 3333,
      extraArgs: '',
      oc: { powerLimitW: null, coreClockOffset: null, memClockOffset: null, fanSpeed: null },
      watchdog: { enabled: true, maxTempC: 85, minHashratePercent: 60, crashRestart: true, restartDelaySec: 10 },
      autoStart: true,
    },
  });
  db.saveFlightSheet({
    name: 'Pearl PeakMiner · 示例',
    coin: 'PRL',
    isDefault: 0,
    config: {
      miner: 'peakminer',
      poolUrl: 'prl.kryptex.network:8048',
      poolUser: 'prl1YOUR_PEARL_WALLET_ADDRESS',
      poolPass: 'x',
      workerName: '{rig}',
      algo: 'pearlhash',
      tls: true,
      apiPort: 4068,
      extraArgs: '--keepalive',
      oc: { powerLimitW: null, coreClockOffset: null, memClockOffset: null, fanSpeed: null },
      watchdog: { enabled: true, maxTempC: 82, minHashratePercent: 60, crashRestart: true, restartDelaySec: 10 },
      autoStart: true,
    },
  });
}
seedDefaults();

const api = createApi({ db, bus, collector, alerts, history, network, auth, log, appRoot: ROOT, dataDir: cfg.dataDir, startedAt });

// ───────── HTTP 服务 ─────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // 通用安全头
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('referrer-policy', 'same-origin');

  if (p === '/api/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, uptimeSec: Math.round((now() - startedAt) / 1000) });
  }

  if (p.startsWith('/api/')) {
    const handled = await api.dispatch(req, res, url);
    if (!handled && !res.headersSent) sendError(res, 404, '接口不存在');
    return;
  }

  if (p === '/favicon.ico') {
    const ico = path.join(ROOT, 'web', 'favicon.ico');
    if (fs.existsSync(ico)) return serveStatic(path.join(ROOT, 'web'), '/favicon.ico', req, res);
    res.writeHead(204); return res.end();
  }

  // 静态资源 + SPA 回退
  if (serveStatic(path.join(ROOT, 'web'), p, req, res)) return;
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
    if (serveStatic(path.join(ROOT, 'web'), '/index.html', req, res)) return;
  }
  sendError(res, 404, '资源不存在');
});

// WebSocket：浏览器控制台（会话 Cookie 校验）
bus.attach(server, { path: '/ws', verify: (req) => auth.verifyWs(req) });
// WebSocket：采集端
collector.attach(server, auth);

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' && url.pathname !== '/agent/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ }
});

// ───────── 定时任务 ─────────
const timers = [];
function every(ms, fn, label) {
  const t = setInterval(() => {
    try { fn(); } catch (e) { log.error(`定时任务 ${label} 异常: ${e.stack || e.message}`); }
  }, ms);
  t.unref?.();
  timers.push(t);
  return t;
}

every(5_000, () => {
  collector.tick();
  db.expireStaleCommands(90_000);
}, 'collector-tick');

// 每 5 分钟：机器/币种聚合 + 清理
every(5 * 60_000, () => {
  history.rollup();
  history.rollupCoins(Math.floor(now() / 300_000) * 300_000);
}, 'rollup');

// 每小时：保留策略
every(3600_000, () => history.purge(), 'purge');

// 行情：启动即拉取，之后 5 分钟
network.refresh(true).catch(() => {});
every(5 * 60_000, () => network.refresh().then((n) => bus.broadcast({ type: 'network', price: n.price, net: n.net })).catch(() => {}), 'network');

// 告警检查
alerts.start();

// ───────── 启动 ─────────
function printBanner(port) {
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  const urls = [`http://127.0.0.1:${port}`, ...lan.map((ip) => `http://${ip}:${port}`)];
  logLine('info', '');
  logLine('info', '  ⛏  矿机监控中心 / Miner Monitor  v' + VERSION);
  logLine('info', '  ─────────────────────────────────────────────');
  for (const u of urls) logLine('info', `  控制台: ${u}`);
  logLine('info', `  数据目录: ${cfg.dataDir}`);
  logLine('info', `  自动注册采集端: ${cfg.agentAutoRegister ? '已开启' : '已关闭'}`);
  logLine('info', '  ─────────────────────────────────────────────');
  logLine('info', '');
}

let listenPort = cfg.port;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listenPort - cfg.port < 10 && !process.env.MM_PORT) {
    log.warn(`端口 ${listenPort} 被占用，尝试 ${listenPort + 1} ...`);
    listenPort += 1;
    setTimeout(() => server.listen(listenPort, cfg.host), 120);
  } else {
    log.error(`启动失败: ${err.message}`);
    process.exit(1);
  }
});
server.on('listening', () => {
  printBanner(listenPort);
  try { fs.writeFileSync(path.join(cfg.dataDir, 'server-port.txt'), String(listenPort)); } catch { /* ignore */ }
});
server.listen(listenPort, cfg.host);

// ───────── 优雅退出 ─────────
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  log.info(`收到 ${signal}，正在停止...`);
  for (const t of timers) clearInterval(t);
  alerts.stop();
  bus.close();
  try { server.close(); } catch { /* ignore */ }
  db.close();
  setTimeout(() => process.exit(0), 300).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => log.error(`未捕获异常: ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => log.error(`未处理的 Promise 拒绝: ${e?.stack || e}`));

export { server, db, collector, bus };
