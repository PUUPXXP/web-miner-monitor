// REST API 路由
import fs from 'node:fs';
import path from 'node:path';
import { makeRouter, sendJson, sendError, sendText, readBody, clientIp, HttpError } from './http.js';
import { buildAgentZip, installScript } from './bundle.js';
import { now, num, round, isPlainObject, hashPassword, verifyPassword, randomId } from '../shared/util.js';
import { COINS, MINERS, POOL_PRESETS, ALGO_PRESETS, pearlSubsidy } from '../shared/miners.js';
import { buildCoinRegistry, normalizeCoin } from '../shared/coins.js';
import { SERVER_VERSION, AGENT_VERSION } from '../shared/version.js';
import { OsImage } from './os-image.js';
import { UpdateCenter } from './updates.js';
import { readMultipart } from './multipart.js';

const VERSION = SERVER_VERSION;
const SECRET_FIELDS = ['botToken', 'webhookUrl', 'url', 'secret'];

export function createApi(ctx) {
  const { db, bus, collector, alerts, history, network, auth, log, appRoot, startedAt } = ctx;
  const router = makeRouter();
  const getSettings = () => db.allSettings();
  const S = () => ({ ...defaultSettings(), ...getSettings() });
  const osImage = new OsImage({ projectRoot: appRoot, dataDir: ctx.dataDir || path.join(appRoot, 'data'), log });
  const updates = new UpdateCenter({ projectRoot: appRoot, dataDir: ctx.dataDir || path.join(appRoot, 'data'), log });
  /** 内置币种 + 自定义币种（settings.customCoins） */
  const coins = () => buildCoinRegistry(getSettings().customCoins || [], MINERS);

  // ───────── 认证 ─────────
  router.post('/api/auth/login', async (req, res) => {
    const body = await readBody(req);
    const username = String(body?.username || '').trim();
    const password = String(body?.password || '');
    if (!username || !password) return sendError(res, 400, '请输入用户名和密码');
    const ip = clientIp(req);
    const r = auth.login(username, password, ip, req.headers['user-agent']);
    if (r.error) return sendError(res, r.status || 401, r.error);
    sendJson(res, 200, { user: r.user }, { 'set-cookie': auth.sessionCookie(r.token) });
  });

  router.post('/api/auth/logout', async (req, res) => {
    const { token } = parseAuthHeader(req);
    if (token) db.deleteSession(token);
    sendJson(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie() });
  });

  router.get('/api/auth/me', async (req, res) => {
    const user = req.user;
    sendJson(res, 200, { user, version: VERSION });
  });

  router.post('/api/auth/password', async (req, res) => {
    const body = await readBody(req);
    const user = db.q.userById.get(req.user.id);
    if (!verifyPassword(String(body?.oldPassword || ''), user.password_hash)) {
      return sendError(res, 400, '原密码不正确');
    }
    const next = String(body?.newPassword || '');
    if (next.length < 8) return sendError(res, 400, '新密码至少 8 位');
    db.q.updateUserPassword.run(hashPassword(next), user.id);
    db.addEvent({ level: 'info', category: 'auth', message: `管理员修改了密码` });
    sendJson(res, 200, { ok: true });
  });

  // ───────── 概览 ─────────
  router.get('/api/overview', async (req, res) => {
    const rigs = collector.allRigs();
    const registry = coins();
    const byCoin = {};
    for (const r of rigs) {
      const c = (byCoin[r.coin] ||= { coin: r.coin, name: registry[r.coin]?.name || r.coin, rigs: 0, online: 0, hashrate: 0, power: 0, accepted: 0, rejected: 0 });
      c.rigs += 1;
      if (r.online) {
        c.online += 1;
        c.hashrate += num(r.total_hashrate) ?? 0;
        c.power += num(r.power_w) ?? 0;
      }
      c.accepted += num(r.accepted) ?? 0;
      c.rejected += num(r.rejected) ?? 0;
    }
    const totals = { rigs: rigs.length, online: rigs.filter((r) => r.online).length, hashrate: 0, power: 0, accepted: 0, rejected: 0 };
    for (const c of Object.values(byCoin)) {
      c.hashrate = round(c.hashrate, 2);
      c.power = round(c.power, 1);
      totals.hashrate += c.hashrate;
      totals.power += c.power;
      totals.accepted += c.accepted;
      totals.rejected += c.rejected;
    }
    totals.power = round(totals.power, 1);
    const net = network.snapshot();
    // 收益估算（按当前全网算力与价格，仅作参考）
    for (const c of Object.values(coins)) {
      c.earnings = estimateEarnings(c, net);
    }
    sendJson(res, 200, {
      serverTime: now(),
      startedAt,
      version: VERSION,
      uptimeSec: Math.round((now() - startedAt) / 1000),
      fleet: totals,
      coins: Object.values(byCoin),
      price: net.price || {},
      net: net.net || {},
      alerts: db.listAlerts({ limit: 20 }),
      events: db.listEvents({ limit: 30 }),
      settings: { siteName: S().siteName },
      groups: db.groups(),
    });
  });

  // ───────── 矿机 ─────────
  router.get('/api/rigs', async (req, res) => {
    sendJson(res, 200, { rigs: collector.allRigs(), groups: db.groups() });
  });

  router.post('/api/rigs', async (req, res) => {
    const body = await readBody(req);
    const name = String(body?.name || '').trim();
    if (!name) return sendError(res, 400, '矿机名称不能为空');
    if (db.listRigs().some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      return sendError(res, 409, '同名矿机已存在');
    }
    const rig = db.createRig({
      name: name.slice(0, 60),
      group: String(body?.group || '默认分组').slice(0, 40),
      coin: coins()[body?.coin] ? body.coin : 'XMR',
      note: String(body?.note || '').slice(0, 500),
    });
    if (body?.flightSheetId) {
      db.updateRig(rig.id, { flight_sheet_id: body.flightSheetId });
    }
    db.addEvent({ level: 'info', category: 'rig', rigId: rig.id, rigName: rig.name, message: '创建矿机' });
    sendJson(res, 201, { rig: collector.publicRig(db.rigById(rig.id)), token: rig.token });
  });

  router.get('/api/rigs/:id', async (req, res) => {
    const rig = collector.rigWithLive(req.params.id);
    if (!rig) return sendError(res, 404, '矿机不存在');
    const raw = db.rigById(req.params.id);
    const sheet = raw.flight_sheet_id ? db.getFlightSheet(raw.flight_sheet_id) : null;
    sendJson(res, 200, {
      rig,
      flightSheet: sheet ? { ...sheet, config: safeJson(sheet.config) } : null,
      commands: db.db.prepare('SELECT * FROM commands WHERE rig_id = ? ORDER BY created_at DESC LIMIT 20').all(req.params.id),
      events: db.listEvents({ rigId: req.params.id, limit: 30 }),
      alerts: db.db.prepare('SELECT * FROM alerts WHERE rig_id = ? ORDER BY created_at DESC LIMIT 20').all(req.params.id),
    });
  });

  router.patch('/api/rigs/:id', async (req, res) => {
    const body = await readBody(req) || {};
    const rig = db.rigById(req.params.id);
    if (!rig) return sendError(res, 404, '矿机不存在');
    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 60);
      if (!name) return sendError(res, 400, '名称不能为空');
      if (db.listRigs().some((r) => r.id !== rig.id && r.name.toLowerCase() === name.toLowerCase())) {
        return sendError(res, 409, '同名矿机已存在');
      }
      patch.name = name;
    }
    if (body.group !== undefined) patch.group_name = String(body.group).slice(0, 40) || '默认分组';
    if (body.coin !== undefined) {
      if (!coins()[body.coin]) return sendError(res, 400, '不支持的币种');
      patch.coin = body.coin;
    }
    if (body.note !== undefined) patch.note = String(body.note).slice(0, 500);
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
    if (body.maintenance !== undefined) patch.maintenance = body.maintenance ? 1 : 0;
    if (body.flightSheetId !== undefined) {
      if (body.flightSheetId && !db.getFlightSheet(body.flightSheetId)) return sendError(res, 400, '飞行表不存在');
      patch.flight_sheet_id = body.flightSheetId || null;
      const sheet = body.flightSheetId ? db.getFlightSheet(body.flightSheetId) : null;
      if (sheet) patch.coin = sheet.coin;
    }
    if (body.fingerprint !== undefined) {
      const fp = body.fingerprint ? String(body.fingerprint).slice(0, 64) : null;
      if (fp) {
        const clash = db.rigByFingerprint(fp);
        if (clash && clash.id !== rig.id) return sendError(res, 409, '该机器指纹已绑定到其他矿机');
        patch.fingerprint = fp;
      } else {
        patch.fingerprint = null;
      }
    }
    db.updateRig(rig.id, patch);
    if (['name', 'enabled', 'maintenance', 'flight_sheet_id', 'coin'].some((k) => patch[k] !== undefined)) {
      collector.pushConfig(rig.id);
    }
    db.addEvent({ level: 'info', category: 'rig', rigId: rig.id, rigName: patch.name || rig.name, message: '更新矿机设置' });
    sendJson(res, 200, { rig: collector.publicRig(db.rigById(rig.id)) });
  });

  router.delete('/api/rigs/:id', async (req, res) => {
    const rig = db.rigById(req.params.id);
    if (!rig) return sendError(res, 404, '矿机不存在');
    collector.sendTo(rig.id, { type: 'bye' });
    db.deleteRig(rig.id);
    db.addEvent({ level: 'warn', category: 'rig', rigName: rig.name, message: '删除矿机' });
    bus.broadcast({ type: 'rig.removed', rigId: rig.id });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/rigs/:id/rotate-token', async (req, res) => {
    const rig = db.rigById(req.params.id);
    if (!rig) return sendError(res, 404, '矿机不存在');
    const token = 'rig_' + randomId(24);
    db.q.rotateToken.run(token, rig.id);
    db.addEvent({ level: 'warn', category: 'rig', rigId: rig.id, rigName: rig.name, message: '重置接入密钥' });
    sendJson(res, 200, { token });
  });

  router.get('/api/rigs/:id/install', async (req, res) => {
    const rig = db.rigById(req.params.id);
    if (!rig) return sendError(res, 404, '矿机不存在');
    const base = req.query.base || S().publicUrl || `http://${req.headers.host}`;
    const fname = `install-${safeFilename(rig.name)}.ps1`;
    sendText(res, 200, installScript({ baseUrl: base, token: rig.token, rigId: rig.id, name: rig.name }),
      'text/plain; charset=utf-8', { 'content-disposition': contentDisposition(fname) });
  });

  // 批量操作
  router.post('/api/rigs/bulk', async (req, res) => {
    const body = await readBody(req);
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    const action = String(body?.action || '');
    if (!ids.length) return sendError(res, 400, '请选择矿机');
    const patched = { group: body?.group, coin: body?.coin, flightSheetId: body?.flightSheetId, enabled: body?.enabled, maintenance: body?.maintenance };
    let n = 0;
    for (const id of ids) {
      const rig = db.rigById(id);
      if (!rig) continue;
      if (action === 'delete') {
        collector.sendTo(id, { type: 'bye' });
        db.deleteRig(id);
        bus.broadcast({ type: 'rig.removed', rigId: id });
        n++;
        continue;
      }
      if (action === 'patch') {
        const patch = {};
        if (patched.group !== undefined && patched.group !== null) patch.group_name = String(patched.group).slice(0, 40);
        if (patched.coin && coins()[patched.coin]) patch.coin = patched.coin;
        if (patched.enabled !== undefined && patched.enabled !== null) patch.enabled = patched.enabled ? 1 : 0;
        if (patched.maintenance !== undefined && patched.maintenance !== null) patch.maintenance = patched.maintenance ? 1 : 0;
        if (patched.flightSheetId && db.getFlightSheet(patched.flightSheetId)) {
          patch.flight_sheet_id = patched.flightSheetId;
          patch.coin = db.getFlightSheet(patched.flightSheetId).coin;
        }
        db.updateRig(id, patch);
        collector.pushConfig(id);
        n++;
      }
    }
    db.addEvent({ level: 'info', category: 'rig', message: `批量操作 ${action}，影响 ${n} 台矿机` });
    sendJson(res, 200, { ok: true, affected: n });
  });

  // 远程命令
  router.post('/api/rigs/:id/command', async (req, res) => {
    const rig = db.rigById(req.params.id);
    if (!rig) return sendError(res, 404, '矿机不存在');
    const body = await readBody(req);
    const type = String(body?.type || '');
    const allowed = ['start', 'stop', 'restart', 'reboot', 'shutdown', 'apply_oc', 'reset_oc', 'update_agent', 'update_miner', 'update_system', 'rollback_miner', 'sync_config', 'run'];
    if (!allowed.includes(type)) return sendError(res, 400, '不支持的命令');
    if (type === 'run' && !body?.command) return sendError(res, 400, '缺少命令内容');
    const connected = collector.isConnected(rig.id);
    const id = db.addCommand(rig.id, type, body?.payload || (type === 'run' ? { command: body.command } : null));
    if (connected) {
      collector.sendTo(rig.id, { type: 'command', id, command: type, payload: body?.payload || (type === 'run' ? { command: body.command } : null) });
      db.addEvent({ level: 'info', category: 'command', rigId: rig.id, rigName: rig.name, message: `下发命令: ${commandLabel(type)}` });
    } else {
      db.addEvent({ level: 'info', category: 'command', rigId: rig.id, rigName: rig.name, message: `命令排队（矿机离线）: ${commandLabel(type)}` });
    }
    bus.broadcast({ type: 'command.sent', command: { id, rigId: rig.id, type, ts: now() } });
    sendJson(res, 200, { id, status: connected ? 'sent' : 'queued', connected });
  });

  router.post('/api/fleet/command', async (req, res) => {
    const body = await readBody(req);
    const type = String(body?.type || '');
    const allowed = ['sync_config', 'restart', 'start', 'stop', 'reboot'];
    if (!allowed.includes(type)) return sendError(res, 400, '不支持的命令');
    const ids = Array.isArray(body?.ids) && body.ids.length ? body.ids : db.listRigs().map((r) => r.id);
    let sent = 0;
    const results = [];
    for (const id of ids) {
      const rig = db.rigById(id);
      if (!rig) continue;
      const cmdId = db.addCommand(id, type, null);
      if (collector.isConnected(id)) {
        collector.sendTo(id, { type: 'command', id: cmdId, command: type, payload: null });
        results.push({ id, ok: true, commandId: cmdId, status: 'sent' });
      } else {
        results.push({ id, ok: true, commandId: cmdId, status: 'queued' });
      }
      sent++;
    }
    db.addEvent({ level: 'info', category: 'command', message: `机群批量命令 ${commandLabel(type)}，已送达 ${sent} 台` });
    sendJson(res, 200, { sent, results });
  });

  router.get('/api/commands', async (req, res) => {
    sendJson(res, 200, { commands: db.recentCommands(Math.min(Number(req.query.limit) || 50, 200)) });
  });

  // ───────── 飞行表 / 钱包 ─────────
  router.get('/api/flight-sheets', async (req, res) => {
    const rows = db.listFlightSheets();
    sendJson(res, 200, {
      flightSheets: rows.map((r) => ({ ...r, config: safeJson(r.config) })),
      presets: { pools: POOL_PRESETS, algos: ALGO_PRESETS, miners: Object.values(MINERS).map((m) => ({ id: m.id, name: m.name, family: m.family, coins: m.coins, hint: m.hint, bin: m.bin, apiPort: m.api?.port || null })) },
      wallets: db.listWallets(),
    });
  });

  router.post('/api/flight-sheets', async (req, res) => {
    const body = await readBody(req);
    const cfg = body?.config || {};
    const err = validateFlightSheet(body, cfg, coins());
    if (err) return sendError(res, 400, err);
    const sheet = db.saveFlightSheet({
      id: body.id || null,
      name: String(body.name).trim().slice(0, 60),
      coin: body.coin,
      config: cfg,
      isDefault: body.isDefault ? 1 : 0,
    });
    db.addEvent({ level: 'info', category: 'config', message: `保存飞行表「${sheet.name}」` });
    // 把更新后的配置推送给使用该飞行表的矿机
    for (const rig of db.listRigs()) if (rig.flight_sheet_id === sheet.id) collector.pushConfig(rig.id);
    sendJson(res, 200, { flightSheet: { ...sheet, config: safeJson(sheet.config) } });
  });

  router.delete('/api/flight-sheets/:id', async (req, res) => {
    const sheet = db.getFlightSheet(req.params.id);
    if (!sheet) return sendError(res, 404, '飞行表不存在');
    db.deleteFlightSheet(sheet.id);
    for (const rig of db.listRigs()) if (rig.flight_sheet_id === sheet.id) db.updateRig(rig.id, { flight_sheet_id: null });
    db.addEvent({ level: 'warn', category: 'config', message: `删除飞行表「${sheet.name}」` });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/wallets', async (req, res) => {
    const body = await readBody(req);
    const coin = String(body?.coin || '');
    const address = String(body?.address || '').trim();
    if (!coins()[coin]) return sendError(res, 400, '不支持的币种');
    if (!/^[A-Za-z0-9]{20,110}$/.test(address)) return sendError(res, 400, '钱包地址格式不正确');
    const w = db.saveWallet({ id: body.id || null, coin, name: String(body.name || '').trim().slice(0, 40) || `${coin} 钱包`, address, note: String(body.note || '').slice(0, 200) });
    sendJson(res, 200, { wallet: w });
  });

  router.delete('/api/wallets/:id', async (req, res) => {
    db.deleteWallet(req.params.id);
    sendJson(res, 200, { ok: true });
  });

  // ───────── 告警 ─────────
  router.get('/api/alerts', async (req, res) => {
    const rules = db.listAlertRules().map((r) => ({ ...r, enabled: !!r.enabled, channels: safeJson(r.channels) || ['inapp'] }));
    sendJson(res, 200, {
      rules,
      alerts: db.listAlerts({ limit: Math.min(Number(req.query.limit) || 100, 300), state: req.query.state || null }),
      metrics: [
        { id: 'offline', label: '离线时长', unit: '秒' },
        { id: 'temp', label: '最高温度', unit: '°C' },
        { id: 'hashrate_drop', label: '算力下降', unit: '%' },
        { id: 'miner_down', label: '矿工未运行', unit: '' },
        { id: 'power', label: '功耗', unit: 'W' },
        { id: 'rejected', label: '拒绝率', unit: '%' },
      ],
    });
  });

  router.post('/api/alerts/rules', async (req, res) => {
    const body = await readBody(req);
    const name = String(body?.name || '').trim();
    const metric = String(body?.metric || '');
    const validMetrics = ['offline', 'temp', 'hashrate_drop', 'miner_down', 'power', 'rejected'];
    if (!name) return sendError(res, 400, '规则名称不能为空');
    if (!validMetrics.includes(metric)) return sendError(res, 400, '不支持的指标');
    const rule = db.saveAlertRule({
      id: body.id || null,
      name: name.slice(0, 60),
      metric,
      target: String(body.target || 'fleet').slice(0, 80),
      comparator: ['>', '>=', '<', '<=', '=='].includes(body.comparator) ? body.comparator : '>',
      threshold: num(body.threshold) ?? 0,
      durationSec: Math.max(0, Math.round(num(body.durationSec) ?? 0)),
      enabled: body.enabled === false ? 0 : 1,
      channels: Array.isArray(body.channels) && body.channels.length ? body.channels : ['inapp'],
    });
    db.addEvent({ level: 'info', category: 'alert', message: `保存告警规则「${rule.name}」` });
    sendJson(res, 200, { rule: { ...rule, enabled: !!rule.enabled, channels: safeJson(rule.channels) } });
  });

  router.delete('/api/alerts/rules/:id', async (req, res) => {
    db.deleteAlertRule(req.params.id);
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/alerts/:id/ack', async (req, res) => {
    db.ackAlert(req.params.id);
    bus.broadcast({ type: 'alert.ack', alertId: req.params.id });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/notifications/test', async (req, res) => {
    const body = await readBody(req);
    try {
      await alerts.test(String(body?.channel || ''));
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendError(res, 400, e.message);
    }
  });

  // ───────── 事件 ─────────
  router.get('/api/events', async (req, res) => {
    const events = db.listEvents({
      limit: Math.min(Number(req.query.limit) || 100, 500),
      before: req.query.before ? Number(req.query.before) : null,
      rigId: req.query.rigId || null,
      level: req.query.level || null,
      category: req.query.category || null,
    });
    sendJson(res, 200, { events });
  });

  // ───────── 历史曲线 ─────────
  router.get('/api/history/fleet', async (req, res) => {
    const range = parseRange(req.query);
    const coin = req.query.coin && coins()[req.query.coin] ? req.query.coin : null;
    sendJson(res, 200, { range, series: history.fleetSeries({ ...range, coin }) });
  });

  router.get('/api/history/rig/:id', async (req, res) => {
    const rig = db.rigById(req.params.id);
    if (!rig) return sendError(res, 404, '矿机不存在');
    const range = parseRange(req.query);
    const gpu = req.query.gpu !== '0';
    sendJson(res, 200, {
      range,
      serie: history.rigSeries(rig.id, range),
      gpus: gpu ? history.gpuSeries(rig.id, range) : [],
    });
  });

  // ───────── 设置 ─────────
  router.get('/api/settings', async (req, res) => {
    sendJson(res, 200, { settings: maskSettings(S()), defaults: defaultSettings() });
  });

  router.put('/api/settings', async (req, res) => {
    const body = await readBody(req) || {};
    const current = S();
    const next = mergeSettings(current, body);
    for (const [k, v] of Object.entries(next)) db.setSetting(k, v);
    db.addEvent({ level: 'info', category: 'system', message: '更新系统设置' });
    sendJson(res, 200, { settings: maskSettings(S()) });
  });
  router.get('/api/server', async (req, res) => {
    const mem = process.memoryUsage();
    let dbSizeMb = null;
    try { dbSizeMb = round(fs.statSync(db.file).size / 1048576, 2); } catch { /* ignore */ }
    sendJson(res, 200, {
      version: VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      startedAt,
      uptimeSec: Math.round((now() - startedAt) / 1000),
      memoryMb: round(mem.rss / 1048576, 1),
      dbSizeMb,
      rigs: db.listRigs().length,
      agents: collector.connections(),
      publicUrl: S().publicUrl,
    });
  });

  // 采集端安装包 / 自动注册
  router.get('/api/agent/bundle', async (req, res) => {
    const ok = auth.rigFor({ headers: req.headers }, new URL(req.url, 'http://x'));
    if (!ok && !req.user) return sendError(res, 401, '需要矿机密钥或管理员登录');
    const zip = buildAgentZip(appRoot);
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': zip.length,
      'content-disposition': 'attachment; filename="miner-monitor-agent.zip"',
    });
    res.end(zip);
  });

  /** 采集端 tar.gz 包（在线自更新用，Windows/Linux 都能直接解开） */
  router.get('/api/agent/bundle.tar.gz', async (req, res) => {
    const ok = auth.rigFor({ headers: req.headers }, new URL(req.url, 'http://x'));
    if (!ok && !req.user) return sendError(res, 401, '需要矿机密钥或管理员登录');
    const tgz = osImage.agentTarball();
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': tgz.length,
      'content-disposition': 'attachment; filename="mineros-agent.tar.gz"',
      'x-agent-version': VERSION,
    });
    res.end(tgz);
  });

  router.post('/api/agent/register', async (req, res) => {
    const settings = S();
    if (!settings.agentAutoRegister) return sendError(res, 403, '未开启自动注册');
    const body = await readBody(req);
    const fingerprint = String(body?.fingerprint || '').trim();
    const hostname = String(body?.hostname || '').trim().slice(0, 60) || '新矿机';
    if (!fingerprint) return sendError(res, 400, '缺少机器指纹');
    let rig = db.rigByFingerprint(fingerprint);
    if (!rig) {
      let name = hostname;
      let i = 2;
      while (db.listRigs().some((r) => r.name.toLowerCase() === name.toLowerCase())) name = `${hostname}-${i++}`;
      rig = db.createRig({ name, group: '待分组', coin: 'XMR' });
      db.bindFingerprint(rig.id, fingerprint);
      db.addEvent({ level: 'info', category: 'rig', rigId: rig.id, rigName: rig.name, message: '矿机自动注册（新机器）' });
      bus.broadcast({ type: 'rig.created', rig: collector.publicRig(rig) });
    } else {
      db.bindFingerprint(rig.id, fingerprint);
    }
    sendJson(res, 200, { rigId: rig.id, token: rig.token, name: rig.name, serverTime: now() });
  });

  // 备份 / 恢复
  router.get('/api/backup', async (req, res) => {
    const payload = {
      version: VERSION,
      exportedAt: now(),
      rigs: db.listRigs().map(({ token, ...r }) => ({ ...r, token })),
      flightSheets: db.listFlightSheets().map((s) => ({ ...s, config: safeJson(s.config) })),
      wallets: db.listWallets(),
      alertRules: db.listAlertRules().map((r) => ({ ...r, channels: safeJson(r.channels) })),
      settings: S(),
    };
    sendJson(res, 200, payload, { 'content-disposition': `attachment; filename="miner-monitor-backup-${new Date().toISOString().slice(0, 10)}.json"` });
  });

  router.post('/api/restore', async (req, res) => {
    const body = await readBody(req, 8 * 1024 * 1024);
    if (!isPlainObject(body) || !Array.isArray(body.rigs)) return sendError(res, 400, '备份文件格式不正确');
    let n = 0;
    for (const r of body.rigs) {
      if (!r?.name) continue;
      const exists = db.listRigs().some((x) => x.name.toLowerCase() === String(r.name).toLowerCase());
      if (exists) continue;
      const rig = db.createRig({ name: String(r.name).slice(0, 60), group: r.group_name || '默认分组', coin: r.coin || 'XMR', note: r.note || '' });
      n++;
    }
    db.addEvent({ level: 'info', category: 'system', message: `从备份恢复 ${n} 台矿机` });
    sendJson(res, 200, { ok: true, restored: n });
  });

  // ───────── MinerOS 系统镜像 ─────────
  router.get('/api/os', async (req, res) => {
    const info = osImage.info();
    sendJson(res, 200, {
      ...info,
      rigs: db.listRigs().map((r) => ({
        id: r.id, name: r.name, coin: r.coin, os: r.os_info || null,
        osImageVersion: r.os_image_version || null,
        agentVersion: r.agent_version || null, online: !!r.online,
      })),
      defaultServerUrl: S().publicUrl || `http://${req.headers.host}`,
    });
  });

  router.get('/api/os/manifest', async (req, res) => {
    // 供 MinerOS 采集端自动更新使用（无需登录）
    const info = osImage.info();
    sendJson(res, 200, {
      name: 'MinerOS',
      version: info.version,
      agentVersion: info.agentVersion,
      image: info.available ? { file: info.file, size: info.size, sha256: info.sha256 } : null,
      downloads: {
        iso: info.available ? '/api/os/download' : null,
        agent: '/api/os/agent.tar.gz',
      },
      base: info.base,
      builtAt: info.builtAt,
    });
  });

  router.get('/api/os/download', async (req, res) => {
    const file = osImage.filePath();
    if (!file) return sendError(res, 404, '系统镜像尚未构建（os/dist 中未找到 .iso）');
    const st = fs.statSync(file);
    const info = osImage.info();
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': st.size,
      'content-disposition': contentDisposition(info.file || path.basename(file)),
      'accept-ranges': 'bytes',
    });
    fs.createReadStream(file).pipe(res);
  });

  router.get('/api/os/sha256', async (req, res) => {
    const sha = await osImage.sha256();
    if (!sha) return sendError(res, 404, '镜像不存在');
    sendText(res, 200, `${sha}  ${osImage.info().file}\n`);
  });

  router.get('/api/os/rig-conf/:id', async (req, res) => {
    const rig = db.rigById(req.params.id);
    if (!rig) return sendError(res, 404, '矿机不存在');
    const base = S().publicUrl || `http://${req.headers.host}`;
    const text = osImage.rigConf({ serverUrl: base, rig, token: rig.token });
    const fname = `rig-${safeFilename(rig.name)}.conf`;
    sendText(res, 200, text, 'text/plain; charset=utf-8', { 'content-disposition': contentDisposition(fname) });
  });

  router.get('/api/os/agent.tar.gz', async (req, res) => {
    const buf = osImage.agentTarball();
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': buf.length,
      'content-disposition': contentDisposition('mineros-agent.tar.gz'),
    });
    res.end(buf);
  });

  // ───────── 币种注册表 ─────────
  router.get('/api/coins', async (req, res) => {
    const reg = coins();
    const rigs = db.listRigs();
    const list = Object.values(reg).map((c) => ({
      ...c,
      rigCount: rigs.filter((r) => r.coin === c.symbol).length,
      onlineCount: rigs.filter((r) => r.coin === c.symbol && r.online).length,
    }));
    sendJson(res, 200, {
      coins: list,
      miners: Object.values(MINERS).map((m) => ({ id: m.id, name: m.name, coins: m.coins, hint: m.hint, bin: m.bin, binLinux: m.binLinux, apiPort: m.api?.port || null })),
      builtinCount: Object.values(reg).filter((c) => c.builtin).length,
      customCount: Object.values(reg).filter((c) => !c.builtin).length,
    });
  });

  router.post('/api/coins', async (req, res) => {
    const body = await readBody(req) || {};
    const current = getSettings().customCoins || [];
    let def;
    try { def = normalizeCoin(body, current.length); } catch (e) { return sendError(res, 400, e.message); }
    if (coins()[def.symbol]) return sendError(res, 409, `币种 ${def.symbol} 已存在（内置币种不可覆盖）`);
    const next = [...current, def];
    db.setSetting('customCoins', next);
    db.addEvent({ level: 'info', category: 'config', message: `新增币种 ${def.symbol}（${def.name}）` });
    sendJson(res, 201, { coin: def, coins: Object.values(coins()) });
  });

  router.delete('/api/coins/:symbol', async (req, res) => {
    const symbol = String(req.params.symbol).toUpperCase();
    const rec = coins()[symbol];
    if (!rec) return sendError(res, 404, '币种不存在');
    if (rec.builtin) return sendError(res, 400, '内置币种不能删除');
    const inUse = db.listRigs().filter((r) => r.coin === symbol);
    if (inUse.length) return sendError(res, 409, `还有 ${inUse.length} 台矿机在使用该币种，请先切换`);
    const next = (getSettings().customCoins || []).filter((c) => c.symbol !== symbol);
    db.setSetting('customCoins', next);
    db.addEvent({ level: 'warn', category: 'config', message: `删除币种 ${symbol}` });
    sendJson(res, 200, { ok: true });
  });

  // ───────── 在线升级中心 ─────────
  router.get('/api/updates', async (req, res) => {
    const platform = req.query.platform || null;
    const items = updates.scan({ refresh: req.query.refresh === '1' });
    sendJson(res, 200, {
      agentVersion: AGENT_VERSION,
      feed: updates.latest({ platform }).map((it) => updates.publicItem(it)),
      all: items.map((it) => ({
        kind: it.kind, id: it.id, version: it.version, platform: it.platform,
        size: it.size, sha256: it.sha256, notes: it.notes, mtime: it.mtime,
      })),
      status: updates.status({ rigs: db.listRigs() }),
      jobs: db.recentUpdateJobs(50),
    });
  });

  /** 采集端拉取可用升级（需矿机密钥；也支持管理员） */
  router.get('/api/updates/feed', async (req, res) => {
    const rig = auth.rigFor(req, new URL(req.url, 'http://x'));
    if (!rig && !req.user) return sendError(res, 401, '需要矿机密钥或管理员登录');
    const platform = req.query.platform || (rig?.os_info?.includes('MinerOS') ? 'linux' : 'win32');
    const installed = {};
    if (req.query.agent) installed.agent = String(req.query.agent);
    if (req.query.miners) {
      try {
        for (const [id, v] of Object.entries(JSON.parse(req.query.miners))) installed[`miner:${id}`] = v;
      } catch { /* ignore */ }
    }
    if (rig?.miner_versions) {
      try { for (const [id, v] of Object.entries(JSON.parse(rig.miner_versions))) installed[`miner:${id}`] = installed[`miner:${id}`] || v; } catch { /* ignore */ }
    }
    if (rig?.agent_version) installed.agent = installed.agent || rig.agent_version;
    sendJson(res, 200, { platform, installed, available: updates.feedFor({ platform, installed }) });
  });

  router.get('/api/updates/download/:kind/:id/:version', async (req, res) => {
    const it = updates.find(req.params.kind, req.params.id, req.params.version);
    if (!it) return sendError(res, 404, '升级包不存在');
    await updates.ensureSha(it);
    const { file, size } = updates.streamArtifact(it);
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': size,
      'content-disposition': contentDisposition(path.basename(file)),
      'x-checksum-sha256': it.sha256,
    });
    fs.createReadStream(file).pipe(res);
  });

  // 控制台上传升级包（multipart 手工解析，零依赖）
  router.post('/api/updates/upload', async (req, res) => {
    const ctype = String(req.headers['content-type'] || '');
    if (!ctype.includes('multipart/form-data')) return sendError(res, 400, '需要 multipart/form-data');
    const parsed = await readMultipart(req, 512 * 1024 * 1024);
    const fields = parsed.fields || {};
    const file = (parsed.files || [])[0];
    if (!file) return sendError(res, 400, '缺少升级包文件');
    try {
      const saved = await updates.saveUpload({
        kind: fields.kind, id: fields.id, version: fields.version,
        platform: fields.platform || 'any', notes: fields.notes || '',
        minAgent: fields.minAgent || null,
        file: file.path, originalName: fields.archive || fields.filename || file.filename || file.name,
      });
      fs.unlinkSync(file.path);
      db.addEvent({ level: 'info', category: 'system', message: `上传升级包 ${saved.kind}/${saved.id}@${saved.version}（${saved.platform}）` });
      sendJson(res, 201, { package: saved });
    } catch (e) {
      sendError(res, 400, e.message);
    }
  });

  router.delete('/api/updates/:kind/:id/:version', async (req, res) => {
    const it = updates.find(req.params.kind, req.params.id, req.params.version);
    if (!it) return sendError(res, 404, '升级包不存在');
    try {
      fs.rmSync(it.dir, { recursive: true, force: true });
      updates.scan({ refresh: true });
      db.addEvent({ level: 'warn', category: 'system', message: `删除升级包 ${it.kind}/${it.id}@${it.version}` });
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendError(res, 400, e.message);
    }
  });

  /** 下发升级：rigs 为空时对全部在线矿机 */
  router.post('/api/updates/push', async (req, res) => {
    const body = await readBody(req) || {};
    const kind = String(body.kind || '');
    const targetId = body.targetId ? String(body.targetId) : null;
    const version = body.version ? String(body.version) : null;
    if (!['agent', 'miner', 'system'].includes(kind)) return sendError(res, 400, '未知升级类型');
    const rigs = (Array.isArray(body.rigIds) && body.rigIds.length ? body.rigIds : db.listRigs().map((r) => r.id))
      .map((id) => db.rigById(id)).filter(Boolean);
    const jobs = [];
    for (const rig of rigs) {
      const isLinux = (rig.os_image_version || '').includes('MinerOS') || (rig.os_info || '').includes('MinerOS');
      const platform = isLinux ? 'linux' : 'win32';
      const candidates = updates.latest({ platform }).filter((it) => it.kind === kind && (!targetId || it.id === targetId));
      if (!candidates.length && kind !== 'agent') continue;
      let pkg = version ? candidates.find((c) => c.version === version) : candidates[0];

      // 采集端升级的特殊情况：没有上传发布包时，直接用服务器内置的 agent bundle
      if (!pkg && kind === 'agent') {
        const bundleVersion = `builtin-${VERSION}`;
        pkg = {
          kind: 'agent',
          id: 'agent',
          version: version && /^\d/.test(version) ? version : bundleVersion,
          platform,
          size: 0,
          notes: '服务器内置采集端包',
          entry: null,
          install: null,
          files: null,
          builtin: true,
          sha256: null,
        };
      }
      if (!pkg) continue;
      const jobId = db.addUpdateJob({
        rigId: rig.id, kind, targetId: pkg.id,
        fromVersion: kind === 'agent' ? rig.agent_version : null, toVersion: pkg.version,
      });
      const payload = {
        kind, id: pkg.id, version: pkg.version, platform: pkg.platform,
        sha256: pkg.builtin ? null : await updates.ensureSha(pkg),
        url: pkg.builtin
          ? '/api/agent/bundle.tar.gz'
          : `/api/updates/download/${pkg.kind}/${encodeURIComponent(pkg.id)}/${encodeURIComponent(pkg.version)}`,
        size: pkg.size, entry: pkg.entry, install: pkg.install, files: pkg.files, notes: pkg.notes,
        jobId,
      };
      const cmdType = kind === 'agent' ? 'update_agent' : kind === 'miner' ? 'update_miner' : 'update_system';
      const cmdId = db.addCommand(rig.id, cmdType, payload);
      if (collector.isConnected(rig.id)) {
        collector.sendTo(rig.id, { type: 'command', id: cmdId, command: cmdType, payload: { ...payload, commandId: cmdId } });
      }
      jobs.push({ jobId, commandId: cmdId, rigId: rig.id, rigName: rig.name, version: pkg.version, kind, targetId: pkg.id });
    }
    db.addEvent({ level: 'info', category: 'system', message: `下发${kind === 'agent' ? '采集端' : kind === 'miner' ? '矿工' : '系统组件'}升级：${jobs.length} 台矿机` });
    sendJson(res, 200, { jobs, queued: jobs.length });
  });

  /** 采集端回传升级进度 */
  router.post('/api/updates/progress', async (req, res) => {
    const rig = auth.rigFor(req, new URL(req.url, 'http://x'));
    if (!rig) return sendError(res, 401, '矿机密钥无效');
    const body = await readBody(req) || {};
    const jobId = String(body.jobId || '');
    if (jobId) {
      db.updateJob(jobId, {
        status: ['running', 'ok', 'error'].includes(body.status) ? body.status : 'running',
        progress: Math.max(0, Math.min(100, Number(body.progress) || 0)),
        message: String(body.message || '').slice(0, 500),
        ...(body.status === 'ok' || body.status === 'error' ? { done_at: now() } : {}),
      });
      bus.broadcast({ type: 'update.progress', job: { id: jobId, rigId: rig.id, ...body } });
    }
    sendJson(res, 200, { ok: true });
  });

  // ───────── 采集端 HTTP 通道 ─────────
  /** 心跳：上报遥测并领取命令。鉴权：x-rig-token */
  async function handleAgent(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/agent/commands') {
      // 独立的命令领取通道：采集端每次循环先拉命令，不受遥测采集耗时影响
      const rig = auth.rigFor(req, url);
      if (!rig) return sendError(res, 401, '矿机密钥无效');
      const commands = db.claimCommands(rig.id).map((c) => ({
        id: c.id, type: c.type, payload: c.payload ? safeJson(c.payload) : null,
      }));
      sendJson(res, 200, { ok: true, commands, serverTime: now() });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/heartbeat') {
      const rig = auth.rigFor(req, url);
      if (!rig) return sendError(res, 401, '矿机密钥无效');
      const body = await readBody(req, 4 * 1024 * 1024);
      const out = collector.handleHeartbeat(rig, body || {}, clientIp(req));
      sendJson(res, 200, { ok: true, ...out });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/command-result') {
      const rig = auth.rigFor(req, url);
      if (!rig) return sendError(res, 401, '矿机密钥无效');
      const body = await readBody(req, 1024 * 1024);
      collector._commandResult(rig.id, body || {});
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/event') {
      const rig = auth.rigFor(req, url);
      if (!rig) return sendError(res, 401, '矿机密钥无效');
      const body = await readBody(req, 512 * 1024);
      db.addEvent({
        level: ['info', 'warn', 'error'].includes(body?.level) ? body.level : 'info',
        category: 'agent', rigId: rig.id, rigName: rig.name,
        message: String(body?.message || '').slice(0, 1000),
      });
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  // ───────── 分发 ─────────
  const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/agent/register', '/api/agent/bundle', '/api/health', '/api/os/manifest']);
  // 允许用矿机密钥访问（采集端拉升级清单/回传进度）
  const RIG_TOKEN_PATHS = new Set(['/api/updates/feed', '/api/updates/progress', '/api/updates/download', '/api/agent/bundle', '/api/agent/bundle.tar.gz']);

  async function dispatch(req, res, url) {
    if (url.pathname.startsWith('/api/agent/') && !PUBLIC_PATHS.has(url.pathname)) {
      if (await handleAgent(req, res, url)) return true;
    }
    const user = auth.userFor(req);
    const route = router.match(req.method, url.pathname);
    if (!route) return false;
    req.params = route.params;
    req.query = Object.fromEntries(url.searchParams);
    req.user = user;
    req.log = log;

    if (!user && !PUBLIC_PATHS.has(url.pathname)) {
      const rigAllowed = [...RIG_TOKEN_PATHS].some((p) => url.pathname === p || url.pathname.startsWith(p + '/'));
      if (rigAllowed) {
        const rig = auth.rigFor(req, url);
        if (!rig) { sendError(res, 401, '矿机密钥无效'); return true; }
        req.rig = rig;
      } else {
        sendError(res, 401, '未登录');
        return true;
      }
    }
    try {
      await route.handler(req, res);
    } catch (e) {
      if (e instanceof HttpError) sendError(res, e.status, e.message);
      else {
        log?.error?.(`API 错误 ${req.method} ${url.pathname}: ${e.stack || e.message}`);
        sendError(res, 500, '服务器内部错误');
      }
    }
    return true;
  }

  return { dispatch };
}

// ───────────────── 辅助 ─────────────────
function parseAuthHeader(req) {
  const cookie = String(req.headers.cookie || '');
  const m = cookie.match(/mm_session=([^;]+)/);
  return { token: m ? decodeURIComponent(m[1]) : null };
}

function parseRange(q) {
  const to = q.to ? Number(q.to) : now();
  const hours = num(q.hours) ?? 24;
  const from = q.from ? Number(q.from) : to - hours * 3600_000;
  return { from: Math.min(from, to - 60_000), to, granularity: q.granularity ? Number(q.granularity) : undefined };
}

function safeJson(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

function safeFilename(name) {
  return String(name).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'rig';
}

/** 生成兼容中文文件名的 Content-Disposition（RFC 5987） */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function commandLabel(type) {
  return {
    start: '启动矿工', stop: '停止矿工', restart: '重启矿工', reboot: '重启矿机',
    shutdown: '关机', apply_oc: '应用超频', reset_oc: '恢复默认频率',
    update_agent: '更新采集端', update_miner: '升级挖矿程序', update_system: '升级系统组件',
    rollback_miner: '回滚矿工版本', sync_config: '同步配置', run: '执行自定义命令',
  }[type] || type;
}

function validateFlightSheet(body, cfg, registry) {
  if (!String(body?.name || '').trim()) return '飞行表名称不能为空';
  if (!registry[body?.coin]) return '请选择币种';
  if (!cfg.miner || !MINERS[cfg.miner]) return '请选择矿工';
  if (!cfg.poolUrl || !/^[^\s]+:\d{1,5}$/.test(String(cfg.poolUrl))) return '矿池地址格式应为 host:port';
  if (!cfg.poolUser || String(cfg.poolUser).trim().length < 10) return '请填写有效钱包地址';
  if (cfg.apiPort && (num(cfg.apiPort) < 1 || num(cfg.apiPort) > 65535)) return 'API 端口无效';
  return null;
}

/**
 * 收益估算：算力占比 × 每日出块 × 区块奖励 − 电费
 * 仅用于"参考值"，实际受难度波动/矿池手续费影响。
 */
function estimateEarnings(c, net) {
  const hashrate = num(c.hashrate) || 0;
  const price = num(net.price?.[c.coin]?.usd);
  const netHash = num(net.net?.[c.coin]?.hashrate);
  if (!hashrate || !price || !netHash) return null;
  const share = hashrate / netHash;
  let coinPerDay = null;
  if (c.coin === 'PRL') {
    const height = num(net.net?.PRL?.height) || 0;
    const { blockTimeSec } = coins().PRL?.emission || { blockTimeSec: 194 };
    const blocksPerDay = 86400 / blockTimeSec;
    coinPerDay = share * blocksPerDay * pearlSubsidy(height);
  } else if (c.coin === 'XMR') {
    const reward = num(net.net?.XMR?.lastReward) ?? 0.6;
    const blocksPerDay = 86400 / 120;
    coinPerDay = share * blocksPerDay * reward;
  }
  if (!coinPerDay) return null;
  const revenue = coinPerDay * price;
  const electricity = (num(c.power) || 0) / 1000 * 24 * 0.7; // 默认 0.7 元/度，可在前端覆盖
  return {
    coinPerDay: round(coinPerDay, 6),
    coinPerMonth: round(coinPerDay * 30, 4),
    revenueDay: round(revenue, 2),
    electricityDay: round(electricity, 2),
    profitDay: round(revenue - electricity, 2),
    price,
    netHashrate: netHash,
  };
}

function defaultSettings() {
  return {
    siteName: '矿机监控中心',
    publicUrl: '',
    agentAutoRegister: true,
    heartbeatSec: 5,
    offlineAfterSec: 45,
    retentionDays: 30,
    coinGecko: true,
    customCoins: [],
    notifications: {
      telegram: { botToken: '', chatId: '' },
      discord: { webhookUrl: '' },
      webhook: { url: '' },
    },
  };
}

/** 深合并设置，但对 secret 字段做特殊处理：掩码值（含 •）不覆盖真实值 */
function mergeSettings(current, patch) {
  const out = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    if (k === 'notifications' && isPlainObject(v)) {
      const cur = isPlainObject(current.notifications) ? current.notifications : {};
      const merged = { ...cur };
      for (const chan of Object.keys(v)) {
        if (!isPlainObject(v[chan])) continue;
        merged[chan] = { ...(cur[chan] || {}) };
        for (const [ck, cv] of Object.entries(v[chan])) {
          if (String(cv).includes('•')) continue;
          merged[chan][ck] = cv;
        }
      }
      out.notifications = merged;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function maskSettings(s) {
  const out = structuredClone(s);
  const mask = (v) => {
    if (!v) return '';
    const str = String(v);
    if (str.length <= 6) return '••••••';
    return str.slice(0, 3) + '••••••' + str.slice(-3);
  };
  if (out.notifications) {
    for (const chan of Object.values(out.notifications)) {
      if (!isPlainObject(chan)) continue;
      for (const f of SECRET_FIELDS) {
        if (chan[f]) chan[f] = mask(chan[f]);
      }
    }
  }
  return out;
}
