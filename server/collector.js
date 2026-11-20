// 采集端连接管理（HTTP 心跳 / WebSocket）+ 遥测入库 + 向浏览器广播
import { attachWs } from '../shared/ws.js';
import { num, round, now, clamp, isPlainObject } from '../shared/util.js';

const MAX_GPUS = 32;
const SAMPLE_INTERVAL_MS = 10_000; // GPU 明细采样入库间隔
const LIVE_TIMEOUT_MS = 45_000;    // 超过该时间未上报视为离线

const MINER_STATES = new Set(['running', 'starting', 'stopped', 'error', 'unknown']);

export class Collector {
  constructor(db, bus, log) {
    this.db = db;
    this.bus = bus;
    this.log = log;
    this.agents = new Map();   // rigId -> { conn?, lastSeen, name }
    this.live = new Map();     // rigId -> 最近一次遥测（内存）
    this.lastSampleAt = new Map();
    this.lastPersistAt = new Map();
    this._ws = null;
  }

  // ───────── WebSocket 通道（可选）─────────
  attach(server, auth) {
    this._ws = attachWs(server, {
      path: '/agent/ws',
      heartbeatMs: 25_000,
      verify: (req) => {
        const url = new URL(req.url, 'http://localhost');
        return !!auth.rigFor(req, url);
      },
      onConnection: (conn, req) => {
        const url = new URL(req.url, 'http://localhost');
        const rig = auth.rigFor(req, url);
        if (!rig) return conn.close(1008, 'invalid token');
        this._bind(conn, rig);
      },
    });
    return this._ws;
  }

  _bind(conn, rig) {
    conn.data.rigId = rig.id;
    const prev = this.agents.get(rig.id);
    if (prev?.conn && prev.conn !== conn) {
      try { prev.conn.close(4000, 'superseded'); } catch { /* ignore */ }
    }
    this.agents.set(rig.id, { conn, lastSeen: now(), name: rig.name });
    conn.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this._handleMessage(rig.id, conn, msg);
    });
    conn.on('close', () => {
      const cur = this.agents.get(rig.id);
      if (cur?.conn === conn) this.agents.delete(rig.id);
    });
    this.log?.info?.(`采集端已连接(WS): ${rig.name} (${conn.remote})`);
    this._sendWelcome(rig.id, conn);
    this._touch(rig.id, { ip: conn.remote, source: 'WebSocket' });
  }

  _sendWelcome(rigId, conn) {
    const rig = this.db.rigById(rigId);
    if (!rig) return;
    conn.send({
      type: 'welcome',
      serverTime: now(),
      rig: this.publicRig(rig),
      config: this.configFor(rig),
      pending: this.db.claimCommands(rigId).map((c) => ({
        id: c.id, type: c.type, payload: c.payload ? safeJson(c.payload) : null,
      })),
    });
  }

  _handleMessage(rigId, conn, msg) {
    const agent = this.agents.get(rigId);
    if (agent) agent.lastSeen = now();
    switch (msg?.type) {
      case 'hello':
        this.db.updateRig(rigId, { agent_version: String(msg.version || '').slice(0, 40) });
        if (msg.fingerprint) {
          const fp = String(msg.fingerprint).slice(0, 64);
          const clash = this.db.rigByFingerprint(fp);
          if (!clash || clash.id === rigId) this.db.bindFingerprint(rigId, fp);
        }
        this._settleAgentUpdates(rigId, String(msg.version || ''));
        conn.send({ type: 'hello-ack', serverTime: now() });
        break;
      case 'stats':
        this.ingest(rigId, msg.stats || msg);
        conn.send({ type: 'ack', seq: msg.seq ?? null, t: now() });
        break;
      case 'command-result':
        this._commandResult(rigId, msg);
        break;
      case 'event':
        this.db.addEvent({
          level: ['info', 'warn', 'error'].includes(msg.level) ? msg.level : 'info',
          category: 'agent', rigId, rigName: this.db.rigById(rigId)?.name,
          message: String(msg.message || '').slice(0, 1000),
        });
        break;
      default:
        break;
    }
  }

  // ───────── HTTP 心跳 ─────────
  /**
   * 采集端 POST /api/agent/heartbeat
   * @returns {{config: object, commands: object[], serverTime: number}}
   */
  handleHeartbeat(rig, body, ip) {
    this._touch(rig.id, { ip, source: 'HTTP' });
    if (body?.stats || body?.gpus) this.ingest(rig.id, body.stats || body);
    else if (body?.hello) {
      if (body.version) this.db.updateRig(rig.id, { agent_version: String(body.version).slice(0, 40) });
    }
    // 注意：命令统一由 /api/agent/commands 拉取，心跳不再领取命令，
    // 避免"心跳先领走、采集端却没处理"的丢失问题。
    return { config: this.configFor(rig), commands: [], serverTime: now() };
  }

  configFor(rig) {
    const sheet = rig.flight_sheet_id ? this.db.getFlightSheet(rig.flight_sheet_id) : null;
    return {
      rigId: rig.id,
      name: rig.name,
      coin: rig.coin,
      enabled: !!rig.enabled,
      maintenance: !!rig.maintenance,
      flightSheet: sheet ? { id: sheet.id, name: sheet.name, coin: sheet.coin, config: safeJson(sheet.config) } : null,
      heartbeatSec: num(this.db.setting('heartbeatSec')) ?? 5,
    };
  }

  _touch(rigId, { ip = null, source = '' } = {}) {
    const rig = this.db.rigById(rigId);
    if (!rig) return;
    const wasOnline = !!rig.online;
    const agent = this.agents.get(rigId);
    this.agents.set(rigId, { ...(agent || {}), lastSeen: now(), name: rig.name });
    if (!wasOnline) {
      this.db.updateRig(rigId, { online: 1, last_seen: now(), ...(ip ? { agent_ip: ip } : {}) });
      this.db.addEvent({
        level: 'info', category: 'agent', rigId, rigName: rig.name,
        message: `采集端${wasOnline ? '' : '上线'}${source ? `（${source}）` : ''}${ip ? ' ' + ip : ''}`,
      });
      this.broadcastRig(rigId);
    } else {
      // 降低写库频率
      const last = this.lastPersistAt.get(rigId) || 0;
      if (now() - last > 15_000) {
        this.lastPersistAt.set(rigId, now());
        this.db.updateRig(rigId, { last_seen: now(), ...(ip && !rig.agent_ip ? { agent_ip: ip } : {}) });
      }
    }
  }

  /**
   * 采集端重连上来了：把该矿机「采集端升级」任务收尾。
   * 只有新版本号与目标版本一致才算成功（builtin- 前缀视作最新）。
   */
  _settleAgentUpdates(rigId, version) {
    try {
      for (const job of this.db.recentUpdateJobs(50)) {
        if (job.rig_id !== rigId || job.kind !== 'agent') continue;
        if (job.status !== 'running' && job.status !== 'pending') continue;
        const target = String(job.to_version || '');
        const current = String(version || '');
        const builtin = target.startsWith('builtin-');
        const matched = builtin || !target || cmpVersion(current, target) >= 0;
        this.db.updateJob(job.id, {
          status: matched ? 'ok' : 'error',
          progress: matched ? 100 : job.progress || 0,
          message: matched
            ? `采集端已重启，当前版本 ${current || '未知'}`
            : `采集端版本 ${current || '未知'} 未达到目标 ${target}`,
          done_at: now(),
        });
        this.bus?.broadcast({ type: 'update.progress', job: { id: job.id, rigId, status: matched ? 'ok' : 'error', progress: matched ? 100 : 0 } });
      }
    } catch { /* 升级记录收尾失败不影响采集端 */ }
  }

  _commandResult(rigId, msg) {
    const id = msg.id || msg.commandId;
    if (!id) return;
    const status = msg.ok ? 'ok' : 'error';
    this.db.finishCommand(id, status, msg.output || msg.error || '');
    const rig = this.db.rigById(rigId);
    this.db.addEvent({
      level: msg.ok ? 'info' : 'error', category: 'command', rigId, rigName: rig?.name,
      message: `命令 ${msg.type || ''} ${msg.ok ? '执行成功' : '执行失败'}${msg.error ? ': ' + msg.error : ''}`,
    });
    this.bus.broadcast({ type: 'command.result', command: { id, rigId, status, output: msg.output || msg.error || '' } });
  }

  // ───────── 遥测 ─────────
  ingest(rigId, msg) {
    const rig = this.db.rigById(rigId);
    if (!rig) return;
    const ts = now();
    const data = sanitizeStats(msg);
    const prev = this.live.get(rigId);

    const gpus = data.gpus;
    // 每卡算力：矿工 API 给出按卡数据则使用，否则按总算力均分
    if (data.miner?.gpus && data.miner.gpus.length === gpus.length) {
      gpus.forEach((g, i) => { g.hashrate = num(data.miner.gpus[i]); });
    } else if (data.miner?.hashrate && gpus.length) {
      const per = round(data.miner.hashrate / gpus.length, 2);
      gpus.forEach((g) => { g.hashrate = per; });
    }
    // 矿工自带的每卡温度/风扇/功耗（AMD 或无 nvidia-smi 时更准确）覆盖 nvidia-smi 的空值
    const detail = data.miner?.perGpuDetail;
    if (Array.isArray(detail) && detail.length) {
      for (const d of detail) {
        const g = gpus.find((x) => x.index === d.index) || gpus[detail.indexOf(d)];
        if (!g) continue;
        for (const [src, dst] of [['temp', 'temp'], ['fan', 'fan'], ['power', 'power'], ['hashrate', 'hashrate']]) {
          if (num(d[src]) !== null) g[dst] = num(d[src]);
        }
      }
    }
    const totalHash = data.miner?.hashrate ?? sum(gpus.map((g) => g.hashrate));
    const power = sum(gpus.map((g) => g.power));
    const tempMax = maxOrNull(gpus.map((g) => g.temp));
    const fanMax = maxOrNull(gpus.map((g) => g.fan));

    let accepted = rig.accepted || 0;
    let rejected = rig.rejected || 0;
    if (prev && data.miner?.accepted != null) {
      const dA = data.miner.accepted - (prev.miner?.accepted ?? 0);
      const dR = (data.miner.rejected ?? 0) - (prev.miner?.rejected ?? 0);
      if (dA >= 0) accepted += dA;
      if (dR >= 0) rejected += dR;
    }

    const live = {
      ...data,
      rigId,
      online: true,
      ts,
      totalHashrate: totalHash,
      power,
      tempMax,
      fanMax,
      accepted,
      rejected,
      hashrateHistory: [...(prev?.hashrateHistory || []), { t: ts, h: totalHash ?? 0 }].slice(-240),
    };
    this.live.set(rigId, live);

    this.db.updateRig(rigId, {
      online: 1,
      last_seen: ts,
      agent_version: data.agent?.version || rig.agent_version,
      os_info: data.system?.os || rig.os_info,
      cpu_name: data.system?.cpu || rig.cpu_name,
      gpu_summary: gpus.map((g) => g.name).filter(Boolean).join(', ').slice(0, 300) || rig.gpu_summary,
      gpu_count: gpus.length,
      total_hashrate: totalHash,
      power_w: power,
      temp_max: tempMax,
      fan_max: fanMax,
      miner_name: data.miner?.name || data.miner?.minerId || rig.miner_name,
      miner_state: data.miner?.state || 'unknown',
      pool_url: data.miner?.pool || rig.pool_url,
      uptime_sec: data.system?.uptimeSec ?? rig.uptime_sec,
      agent_ip: data.system?.ip || rig.agent_ip,
      accepted,
      rejected,
      watchdog_restarts: data.watchdog?.restarts ?? 0,
      wallet_hint: data.miner?.walletHint || rig.wallet_hint,
      miner_versions: data.miner?.minerVersions ? JSON.stringify(data.miner.minerVersions) : rig.miner_versions,
      update_state: data.availableUpdates ? JSON.stringify(data.availableUpdates) : rig.update_state,
      os_image_version: data.agent?.osImage || rig.os_image_version,
    });

    const lastSample = this.lastSampleAt.get(rigId) || 0;
    if (ts - lastSample >= SAMPLE_INTERVAL_MS && gpus.length) {
      this.lastSampleAt.set(rigId, ts);
      try {
        this.db.insertGpuSamples(rigId, Math.floor(ts / 1000) * 1000, gpus.map((g, i) => ({ ...g, index: g.index ?? i })));
      } catch (e) {
        this.log?.warn?.(`写入 GPU 采样失败: ${e.message}`);
      }
    }

    this.broadcastRig(rigId);
  }

  _setOffline(rigId, reason = '心跳超时') {
    const rig = this.db.rigById(rigId);
    if (!rig) return;
    this.agents.delete(rigId);
    if (rig.online) {
      this.db.updateRig(rigId, { online: 0, miner_state: 'unknown' });
      this.db.addEvent({ level: 'warn', category: 'rig', rigId, rigName: rig.name, message: `矿机离线（${reason}）` });
    }
    const l = this.live.get(rigId);
    if (l) l.online = false;
    this.broadcastRig(rigId);
  }

  /** 定期巡检：离线判定 */
  tick() {
    const t = now();
    for (const [rigId, agent] of this.agents) {
      if (t - (agent.lastSeen || 0) > LIVE_TIMEOUT_MS) {
        try { agent.conn?.close(4001, 'timeout'); } catch { /* ignore */ }
        this._setOffline(rigId, '心跳超时');
      }
    }
    for (const rig of this.db.listRigs()) {
      if (rig.online && !this.agents.has(rig.id) && t - (rig.last_seen || 0) > LIVE_TIMEOUT_MS) {
        this._setOffline(rig.id, '心跳超时');
      }
    }
  }

  broadcastRig(rigId) {
    const rig = this.db.rigById(rigId);
    if (!rig) return;
    this.bus.broadcast({ type: 'rig.update', rig: this.publicRig(rig) }, { throttle: true });
  }

  publicRig(rig) {
    if (!rig) return null;
    const live = this.live.get(rig.id);
    const { token, ...rest } = rig;
    let minerVersions = null;
    let availableUpdates = null;
    try { minerVersions = rest.miner_versions ? JSON.parse(rest.miner_versions) : null; } catch { minerVersions = null; }
    try { availableUpdates = rest.update_state ? JSON.parse(rest.update_state) : null; } catch { availableUpdates = null; }
    return {
      ...rest,
      miner_versions: minerVersions,
      update_state: availableUpdates,
      enabled: !!rest.enabled,
      maintenance: !!rest.maintenance,
      online: !!(live?.online && rig.online),
      live: live ? {
        gpus: live.gpus,
        system: live.system,
        miner: live.miner,
        watchdog: live.watchdog,
        logs: live.logs,
        hashrateHistory: live.hashrateHistory,
        ts: live.ts,
        uptimeSec: live.system?.uptimeSec ?? null,
      } : null,
      hasToken: !!token,
    };
  }

  allRigs() {
    return this.db.listRigs().map((r) => this.publicRig(r));
  }

  rigWithLive(id) {
    const rig = this.db.rigById(id);
    return rig ? this.publicRig(rig) : null;
  }

  sendTo(rigId, msg) {
    const agent = this.agents.get(rigId);
    if (!agent?.conn) return false;
    return agent.conn.send(msg);
  }

  isConnected(rigId) {
    const agent = this.agents.get(rigId);
    if (!agent) return false;
    return now() - (agent.lastSeen || 0) < LIVE_TIMEOUT_MS;
  }

  connections() {
    return [...this.agents.entries()].map(([rigId, a]) => ({
      rigId, lastSeen: a.lastSeen, remote: a.conn?.remote || null, transport: a.conn ? 'ws' : 'http',
    }));
  }

  pushConfig(rigId) {
    const rig = this.db.rigById(rigId);
    if (!rig) return false;
    const agent = this.agents.get(rigId);
    if (agent?.conn) {
      agent.conn.send({ type: 'config', config: this.configFor(rig) });
      return true;
    }
    return false; // HTTP 模式下由下一次心跳带回新配置
  }
}

function sanitizeStats(msg) {
  const gpus = Array.isArray(msg.gpus) ? msg.gpus.slice(0, MAX_GPUS) : [];
  return {
    agent: {
      version: String(msg.agent?.version || '').slice(0, 40),
      hostname: String(msg.agent?.hostname || '').slice(0, 80),
      osImage: msg.agent?.osImage ? String(msg.agent.osImage).slice(0, 80) : null,
    },
    // 可用升级清单：采集端上报，用于控制台「有更新」标记
    availableUpdates: Array.isArray(msg.availableUpdates)
      ? msg.availableUpdates.slice(0, 60).map((u) => ({
        kind: String(u?.kind || '').slice(0, 20),
        id: String(u?.id || '').slice(0, 60),
        version: String(u?.version || '').slice(0, 40),
        platform: String(u?.platform || '').slice(0, 10),
      }))
      : null,
    system: {
      os: String(msg.system?.os || '').slice(0, 120),
      cpu: String(msg.system?.cpu || '').slice(0, 160),
      cpuCores: num(msg.system?.cpuCores),
      cpuLoad: num(msg.system?.cpuLoad),
      memTotalMb: num(msg.system?.memTotalMb),
      memUsedMb: num(msg.system?.memUsedMb),
      diskTotalGb: num(msg.system?.diskTotalGb),
      diskFreeGb: num(msg.system?.diskFreeGb),
      uptimeSec: num(msg.system?.uptimeSec),
      ip: String(msg.system?.ip || '').slice(0, 60),
    },
    gpus: gpus.map((g, i) => ({
      index: Number.isInteger(g.index) ? g.index : i,
      name: String(g.name || `GPU ${i}`).slice(0, 80),
      vendor: g.vendor === 'amd' ? 'amd' : 'nvidia',
      hashrate: num(g.hashrate),
      temp: num(g.temp),
      fan: num(g.fan),
      power: num(g.power),
      util: num(g.util),
      memUsed: num(g.memUsed),
      memTotal: num(g.memTotal),
      clockCore: num(g.clockCore),
      clockMem: num(g.clockMem),
      pstate: num(g.pstate),
      error: g.error ? String(g.error).slice(0, 160) : null,
    })),
    miner: {
      minerId: String(msg.miner?.minerId || '').slice(0, 40),
      name: String(msg.miner?.name || '').slice(0, 60),
      state: MINER_STATES.has(msg.miner?.state) ? msg.miner.state : 'unknown',
      algo: String(msg.miner?.algo || '').slice(0, 40),
      pool: String(msg.miner?.pool || '').slice(0, 160),
      walletHint: String(msg.miner?.walletHint || '').slice(0, 32),
      hashrate: num(msg.miner?.hashrate),
      hashrate10s: num(msg.miner?.hashrate10s),
      hashrate1m: num(msg.miner?.hashrate1m),
      hashrate15m: num(msg.miner?.hashrate15m),
      accepted: num(msg.miner?.accepted),
      rejected: num(msg.miner?.rejected),
      invalid: num(msg.miner?.invalid),
      uptimeSec: num(msg.miner?.uptimeSec),
      pid: num(msg.miner?.pid),
      lastError: msg.miner?.lastError ? String(msg.miner.lastError).slice(0, 500) : null,
      version: msg.miner?.version ? String(msg.miner.version).slice(0, 40) : null,
      minerVersions: isPlainObject(msg.miner?.minerVersions) ? msg.miner.minerVersions : null,
      gpus: Array.isArray(msg.miner?.gpus) ? msg.miner.gpus.slice(0, MAX_GPUS).map((v) => num(v)) : null,
      perGpuDetail: Array.isArray(msg.miner?.perGpuDetail)
        ? msg.miner.perGpuDetail.slice(0, MAX_GPUS).map((d) => ({
          index: Number.isInteger(d.index) ? d.index : null,
          hashrate: num(d.hashrate),
          temp: num(d.temp),
          fan: num(d.fan),
          power: num(d.power),
        }))
        : null,
    },
    watchdog: {
      restarts: num(msg.watchdog?.restarts) ?? 0,
      lastRestartAt: num(msg.watchdog?.lastRestartAt),
      reason: msg.watchdog?.reason ? String(msg.watchdog.reason).slice(0, 200) : null,
      state: String(msg.watchdog?.state || 'idle').slice(0, 20),
    },
    logs: Array.isArray(msg.logs) ? msg.logs.slice(-40).map((l) => String(l).slice(0, 300)) : [],
  };
}

function sum(arr) {
  let s = 0;
  let any = false;
  for (const v of arr) { const n = num(v); if (n !== null) { s += n; any = true; } }
  return any ? round(s, 2) : null;
}
function maxOrNull(arr) {
  const vals = arr.map(num).filter((v) => v !== null);
  return vals.length ? Math.max(...vals) : null;
}
function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
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