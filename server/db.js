// SQLite 持久层（node:sqlite，Node >= 22.5，零第三方依赖）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, randomId, now } from '../shared/util.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  totp_secret   TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS rigs (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  token          TEXT NOT NULL UNIQUE,
  group_name     TEXT NOT NULL DEFAULT '默认分组',
  coin           TEXT NOT NULL DEFAULT 'XMR',
  flight_sheet_id TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  maintenance    INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  -- 运行状态（由采集端心跳更新）
  online         INTEGER NOT NULL DEFAULT 0,
  last_seen      INTEGER,
  first_seen     INTEGER,
  agent_version  TEXT,
  os_info        TEXT,
  cpu_name       TEXT,
  gpu_summary    TEXT,
  gpu_count      INTEGER NOT NULL DEFAULT 0,
  total_hashrate REAL,
  power_w        REAL,
  temp_max       REAL,
  fan_max        REAL,
  miner_name     TEXT,
  miner_state    TEXT,
  pool_url       TEXT,
  uptime_sec     INTEGER,
  agent_ip       TEXT,
  -- 汇总
  accepted       INTEGER NOT NULL DEFAULT 0,
  rejected       INTEGER NOT NULL DEFAULT 0,
  watchdog_restarts INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rigs_group ON rigs(group_name);

CREATE TABLE IF NOT EXISTS gpu_samples (
  rig_id    TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  gpu_index INTEGER NOT NULL,
  name      TEXT,
  hashrate  REAL,
  temp      REAL,
  fan       REAL,
  power     REAL,
  util      REAL,
  mem_used  REAL,
  mem_total REAL,
  clock_core REAL,
  clock_mem REAL,
  PRIMARY KEY (rig_id, ts, gpu_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_gpu_samples_ts ON gpu_samples(ts);

CREATE TABLE IF NOT EXISTS rig_buckets (
  rig_id     TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  hashrate   REAL,
  power      REAL,
  temp_max   REAL,
  fan_max    REAL,
  accepted   INTEGER,
  rejected   INTEGER,
  samples    INTEGER,
  PRIMARY KEY (rig_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS buckets (
  coin     TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  hashrate REAL,
  rigs     INTEGER,
  power    REAL,
  accepted INTEGER,
  rejected INTEGER,
  PRIMARY KEY (coin, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS flight_sheets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  coin       TEXT NOT NULL DEFAULT 'XMR',
  config     TEXT NOT NULL,           -- JSON: 钱包/矿池/矿工/超频/看门狗
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  id         TEXT PRIMARY KEY,
  coin       TEXT NOT NULL,
  name       TEXT NOT NULL,
  address    TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  metric      TEXT NOT NULL,          -- offline / temp / hashrate_drop / miner_down / power / rejected
  target      TEXT NOT NULL DEFAULT 'fleet', -- fleet | rig:<id> | group:<name> | coin:<coin>
  comparator  TEXT NOT NULL DEFAULT '>',
  threshold   REAL NOT NULL,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  channels    TEXT NOT NULL DEFAULT '["inapp"]',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id          TEXT PRIMARY KEY,
  rule_id     TEXT,
  rig_id      TEXT,
  rig_name    TEXT,
  metric      TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'warning',
  message     TEXT NOT NULL,
  value       REAL,
  state       TEXT NOT NULL DEFAULT 'firing', -- firing | resolved
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  acked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts(state);

CREATE TABLE IF NOT EXISTS events (
  id        TEXT PRIMARY KEY,
  ts        INTEGER NOT NULL,
  level     TEXT NOT NULL DEFAULT 'info', -- info | warn | error
  category  TEXT NOT NULL DEFAULT 'system',
  rig_id    TEXT,
  rig_name  TEXT,
  message   TEXT NOT NULL,
  data      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

CREATE TABLE IF NOT EXISTS commands (
  id         TEXT PRIMARY KEY,
  rig_id     TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | sent | ok | error | timeout
  result     TEXT,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  done_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_commands_rig ON commands(rig_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_releases (
  version    TEXT PRIMARY KEY,
  notes      TEXT,
  url        TEXT,
  sha256     TEXT,
  created_at INTEGER NOT NULL
);

-- 升级任务：镜像/采集端/矿工/系统组件的在线升级
CREATE TABLE IF NOT EXISTS update_jobs (
  id          TEXT PRIMARY KEY,
  rig_id      TEXT,
  kind        TEXT NOT NULL,            -- agent | miner | system
  target_id   TEXT,                     -- 矿工 id / 组件 id
  from_version TEXT,
  to_version   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | running | ok | error | timeout
  progress    INTEGER NOT NULL DEFAULT 0,
  message     TEXT,
  created_at  INTEGER NOT NULL,
  done_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_update_jobs_rig ON update_jobs(rig_id, created_at DESC);
`;

export class DB {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'monitor.sqlite');
    this.db = new DatabaseSync(this.file);
    // 多进程（采集端心跳 + 定时任务 + 前端）并发写时等待而不是直接报错
    try { this.db.exec('PRAGMA busy_timeout = 5000;'); } catch { /* ignore */ }
    this.db.exec(SCHEMA);
    this._migrate();
    this._prep();
  }

  _migrate() {
    // 兼容旧库的小步迁移：缺列就补
    const cols = this.db.prepare('PRAGMA table_info(rigs)').all().map((c) => c.name);
    const wanted = [
      ['miner_name', 'TEXT'], ['miner_state', 'TEXT'], ['pool_url', 'TEXT'],
      ['agent_ip', 'TEXT'], ['watchdog_restarts', 'INTEGER NOT NULL DEFAULT 0'],
      ['gpu_summary', 'TEXT'], ['temp_max', 'REAL'], ['fan_max', 'REAL'],
      ['wallet_hint', 'TEXT'], ['fingerprint', 'TEXT'],
      ['miner_versions', 'TEXT'], ['update_state', 'TEXT'], ['os_image_version', 'TEXT'],
    ];
    const cmdCols = this.db.prepare('PRAGMA table_info(commands)').all().map((c) => c.name);
    if (!cmdCols.includes('claimed_at')) this.db.exec('ALTER TABLE commands ADD COLUMN claimed_at INTEGER');
    for (const [name, type] of wanted) {
      if (!cols.includes(name)) this.db.exec(`ALTER TABLE rigs ADD COLUMN ${name} ${type}`);
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rigs_fingerprint ON rigs(fingerprint) WHERE fingerprint IS NOT NULL');
  }

  _prep() {
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      getSetting: p('SELECT value FROM settings WHERE key = ?'),
      setSetting: p('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      allSettings: p('SELECT key, value FROM settings'),

      userByName: p('SELECT * FROM users WHERE username = ?'),
      userById: p('SELECT * FROM users WHERE id = ?'),
      countUsers: p('SELECT COUNT(*) AS n FROM users'),
      insertUser: p('INSERT INTO users(id, username, password_hash, role, created_at) VALUES(?,?,?,?,?)'),
      updateUserPassword: p('UPDATE users SET password_hash = ? WHERE id = ?'),
      touchLogin: p('UPDATE users SET last_login_at = ? WHERE id = ?'),
      listUsers: p('SELECT id, username, role, created_at, last_login_at FROM users ORDER BY created_at'),

      insertSession: p('INSERT INTO sessions(token, user_id, created_at, expires_at, user_agent) VALUES(?,?,?,?,?)'),
      sessionByToken: p('SELECT s.*, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
      deleteSession: p('DELETE FROM sessions WHERE token = ?'),
      purgeSessions: p('DELETE FROM sessions WHERE expires_at < ?'),

      allRigs: p('SELECT * FROM rigs ORDER BY name COLLATE NOCASE'),
      rigById: p('SELECT * FROM rigs WHERE id = ?'),
      rigByToken: p('SELECT * FROM rigs WHERE token = ?'),
      insertRig: p(`INSERT INTO rigs(id, name, token, group_name, coin, flight_sheet_id, enabled, maintenance,
        note, first_seen, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`),
      updateRigName: p('UPDATE rigs SET name = ?, updated_at = ? WHERE id = ?'),
      deleteRig: p('DELETE FROM rigs WHERE id = ?'),
      rotateToken: p('UPDATE rigs SET token = ? WHERE id = ?'),
      allGroups: p('SELECT DISTINCT group_name AS g FROM rigs ORDER BY g'),
      rigByFingerprint: p('SELECT * FROM rigs WHERE fingerprint = ?'),
    };
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  // ── settings ──
  setting(key, fallback = null) {
    const row = this.q.getSetting.get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }
  setSetting(key, value) {
    this.q.setSetting.run(key, JSON.stringify(value));
  }
  allSettings() {
    const out = {};
    for (const r of this.q.allSettings.all()) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  }

  // ── users / sessions ──
  ensureAdmin(username, password) {
    const n = this.q.countUsers.get().n;
    if (n > 0) return { created: false };
    const id = randomId(12);
    this.q.insertUser.run(id, username, hashPassword(password), 'admin', now());
    return { created: true, id };
  }
  verifyUser(username, password) {
    const user = this.q.userByName.get(username);
    if (!user) return null;
    return user;
  }
  createSession(userId, ttlMs, userAgent = '') {
    const token = randomId(32);
    this.q.insertSession.run(token, userId, now(), now() + ttlMs, String(userAgent).slice(0, 200));
    return token;
  }
  sessionUser(token) {
    if (!token) return null;
    const s = this.q.sessionByToken.get(token);
    if (!s) return null;
    if (s.expires_at < now()) { this.q.deleteSession.run(token); return null; }
    return s;
  }
  deleteSession(token) { this.q.deleteSession.run(token); }

  // ── rigs ──
  createRig({ name, group = '默认分组', coin = 'XMR', note = '', enabled = 1, maintenance = 0 }) {
    const id = randomId(9);
    const token = 'rig_' + randomId(24);
    const t = now();
    this.q.insertRig.run(id, name, token, group, coin, null, enabled ? 1 : 0, maintenance ? 1 : 0, note, t, t, t);
    return this.rigById(id);
  }
  rigById(id) { return this.q.rigById.get(id); }
  rigByToken(token) { return this.q.rigByToken.get(token); }
  rigByFingerprint(fp) { return fp ? this.q.rigByFingerprint.get(fp) : null; }
  bindFingerprint(rigId, fp) {
    this.db.prepare('UPDATE rigs SET fingerprint = ? WHERE id = ?').run(String(fp).slice(0, 64), rigId);
  }
  listRigs() { return this.q.allRigs.all(); }
  updateRig(id, patch) {
    const allowed = [
      'name', 'group_name', 'coin', 'flight_sheet_id', 'enabled', 'maintenance', 'note', 'token',
      'online', 'last_seen', 'agent_version', 'os_info', 'cpu_name', 'gpu_summary', 'gpu_count',
      'total_hashrate', 'power_w', 'temp_max', 'fan_max', 'miner_name', 'miner_state', 'pool_url',
      'uptime_sec', 'agent_ip', 'accepted', 'rejected', 'watchdog_restarts', 'wallet_hint', 'fingerprint',
      'miner_versions', 'update_state', 'os_image_version',
    ];
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    vals.push(now(), id);
    this.db.prepare(`UPDATE rigs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  deleteRig(id) {
    this.tx(() => {
      this.db.prepare('DELETE FROM rigs WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM gpu_samples WHERE rig_id = ?').run(id);
      this.db.prepare('DELETE FROM rig_buckets WHERE rig_id = ?').run(id);
      this.db.prepare('DELETE FROM commands WHERE rig_id = ?').run(id);
    });
  }
  groups() { return this.q.allGroups.all().map((r) => r.g); }

  // ── events ──
  addEvent({ level = 'info', category = 'system', rigId = null, rigName = null, message, data = null }) {
    const id = randomId(8);
    this.db.prepare('INSERT INTO events(id, ts, level, category, rig_id, rig_name, message, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, now(), level, category, rigId, rigName, String(message).slice(0, 2000), data ? JSON.stringify(data) : null);
    return id;
  }
  listEvents({ limit = 100, before = null, rigId = null, level = null, category = null } = {}) {
    const where = [];
    const args = [];
    if (before) { where.push('ts < ?'); args.push(before); }
    if (rigId) { where.push('rig_id = ?'); args.push(rigId); }
    if (level) { where.push('level = ?'); args.push(level); }
    if (category) { where.push('category = ?'); args.push(category); }
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(Number(limit) || 100, 1000));
  }

  // ── 采样 / 历史 ──
  insertGpuSamples(rigId, ts, gpus) {
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO gpu_samples
      (rig_id, ts, gpu_index, name, hashrate, temp, fan, power, util, mem_used, mem_total, clock_core, clock_mem)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.tx(() => {
      for (const g of gpus) {
        stmt.run(rigId, ts, g.index ?? 0, g.name ?? null, g.hashrate ?? null, g.temp ?? null, g.fan ?? null,
          g.power ?? null, g.util ?? null, g.memUsed ?? null, g.memTotal ?? null, g.clockCore ?? null, g.clockMem ?? null);
      }
    });
  }
  gpuSamples(rigId, from, to, limit = 5000) {
    return this.db.prepare(`SELECT ts, gpu_index AS gpuIndex, name, hashrate, temp, fan, power, util
      FROM gpu_samples WHERE rig_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT ?`)
      .all(rigId, from, to, limit);
  }
  insertRigBucket(rigId, ts, { hashrate, power, tempMax, fanMax, accepted, rejected, samples }) {
    this.db.prepare(`INSERT OR REPLACE INTO rig_buckets(rig_id, ts, hashrate, power, temp_max, fan_max, accepted, rejected, samples)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(rigId, ts, hashrate, power, tempMax, fanMax, accepted, rejected, samples);
  }
  insertBucket(coin, ts, { hashrate, rigs, power, accepted, rejected }) {
    this.db.prepare(`INSERT OR REPLACE INTO buckets(coin, ts, hashrate, rigs, power, accepted, rejected)
      VALUES(?,?,?,?,?,?,?)`).run(coin, ts, hashrate, rigs, power, accepted, rejected);
  }
  maxGpuTs(rigId) {
    const r = this.db.prepare('SELECT MAX(ts) AS ts FROM gpu_samples WHERE rig_id = ?').get(rigId);
    return r?.ts ?? 0;
  }
  oldestGpuSampleTs() {
    return this.db.prepare('SELECT MIN(ts) AS ts FROM gpu_samples').get()?.ts ?? null;
  }
  purgeGpuSamples(olderThan, maxRows = 400_000) {
    this.db.prepare('DELETE FROM gpu_samples WHERE ts < ?').run(olderThan);
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM gpu_samples').get()?.n ?? 0;
    if (n > maxRows) {
      this.db.prepare(`DELETE FROM gpu_samples WHERE rowid IN
        (SELECT rowid FROM gpu_samples ORDER BY ts ASC LIMIT ?)`).run(n - maxRows);
    }
  }

  // ── 通用 CRUD（flight sheets / wallets / alert rules）─────
  listFlightSheets() {
    return this.db.prepare('SELECT * FROM flight_sheets ORDER BY is_default DESC, name COLLATE NOCASE').all();
  }
  getFlightSheet(id) { return this.db.prepare('SELECT * FROM flight_sheets WHERE id = ?').get(id); }
  saveFlightSheet({ id, name, coin, config, isDefault = 0 }) {
    const t = now();
    if (!id) id = randomId(8);
    const exists = this.getFlightSheet(id);
    if (exists) {
      this.db.prepare('UPDATE flight_sheets SET name = ?, coin = ?, config = ?, is_default = ?, updated_at = ? WHERE id = ?')
        .run(name, coin, JSON.stringify(config), isDefault ? 1 : 0, t, id);
    } else {
      this.db.prepare('INSERT INTO flight_sheets(id, name, coin, config, is_default, created_at, updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, name, coin, JSON.stringify(config), isDefault ? 1 : 0, t, t);
    }
    if (isDefault) this.db.prepare('UPDATE flight_sheets SET is_default = 0 WHERE id <> ?').run(id);
    return this.getFlightSheet(id);
  }
  deleteFlightSheet(id) { this.db.prepare('DELETE FROM flight_sheets WHERE id = ?').run(id); }

  listWallets() { return this.db.prepare('SELECT * FROM wallets ORDER BY coin, name').all(); }
  saveWallet({ id, coin, name, address, note = '' }) {
    if (!id) id = randomId(8);
    const exists = this.db.prepare('SELECT id FROM wallets WHERE id = ?').get(id);
    if (exists) {
      this.db.prepare('UPDATE wallets SET coin = ?, name = ?, address = ?, note = ? WHERE id = ?').run(coin, name, address, note, id);
    } else {
      this.db.prepare('INSERT INTO wallets(id, coin, name, address, note, created_at) VALUES(?,?,?,?,?,?)')
        .run(id, coin, name, address, note, now());
    }
    return this.db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);
  }
  deleteWallet(id) { this.db.prepare('DELETE FROM wallets WHERE id = ?').run(id); }

  listAlertRules() { return this.db.prepare('SELECT * FROM alert_rules ORDER BY created_at').all(); }
  saveAlertRule({ id, name, metric, target, comparator, threshold, durationSec = 0, enabled = 1, channels = ['inapp'] }) {
    if (!id) id = randomId(8);
    const exists = this.db.prepare('SELECT id FROM alert_rules WHERE id = ?').get(id);
    const ch = JSON.stringify(channels);
    if (exists) {
      this.db.prepare(`UPDATE alert_rules SET name=?, metric=?, target=?, comparator=?, threshold=?, duration_sec=?, enabled=?, channels=? WHERE id=?`)
        .run(name, metric, target, comparator, threshold, durationSec, enabled ? 1 : 0, ch, id);
    } else {
      this.db.prepare(`INSERT INTO alert_rules(id, name, metric, target, comparator, threshold, duration_sec, enabled, channels, created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, name, metric, target, comparator, threshold, durationSec, enabled ? 1 : 0, ch, now());
    }
    return this.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id);
  }
  deleteAlertRule(id) { this.db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id); }

  listAlerts({ limit = 100, state = null } = {}) {
    const where = state ? 'WHERE state = ?' : '';
    const args = state ? [state] : [];
    return this.db.prepare(`SELECT * FROM alerts ${where} ORDER BY created_at DESC LIMIT ?`).all(...args, Math.min(limit, 500));
  }
  addAlert({ ruleId, rigId, rigName, metric, severity = 'warning', message, value }) {
    const id = randomId(8);
    this.db.prepare(`INSERT INTO alerts(id, rule_id, rig_id, rig_name, metric, severity, message, value, state, created_at)
      VALUES(?,?,?,?,?,?,?,?, 'firing', ?)`).run(id, ruleId ?? null, rigId ?? null, rigName ?? null, metric, severity, message, value ?? null, now());
    return id;
  }
  resolveAlert(id) {
    this.db.prepare("UPDATE alerts SET state = 'resolved', resolved_at = ? WHERE id = ? AND state = 'firing'").run(now(), id);
  }
  ackAlert(id) { this.db.prepare('UPDATE alerts SET acked_at = ? WHERE id = ?').run(now(), id); }
  firingAlertsFor(ruleId, key) {
    return this.db.prepare("SELECT * FROM alerts WHERE rule_id = ? AND COALESCE(rig_id, '') = ? AND state = 'firing'").all(ruleId, key);
  }
  openAlertCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE state = 'firing'").get()?.n ?? 0; }

  // ── commands ──
  addCommand(rigId, type, payload = null) {
    const id = randomId(8);
    this.db.prepare('INSERT INTO commands(id, rig_id, type, payload, status, created_at) VALUES(?,?,?,?,?,?)')
      .run(id, rigId, type, payload ? JSON.stringify(payload) : null, 'pending', now());
    return id;
  }
  finishCommand(id, status, result) {
    this.db.prepare('UPDATE commands SET status = ?, result = ?, done_at = ? WHERE id = ?')
      .run(status, String(result ?? '').slice(0, 4000), now(), id);
  }
  pendingCommandsFor(rigId) {
    return this.db.prepare("SELECT * FROM commands WHERE rig_id = ? AND status IN ('pending','sent') ORDER BY created_at").all(rigId);
  }
  /**
   * 领取待执行命令（采集端心跳时调用）。
   * 设计：命令只要没执行完就一直保留并重复投递（矿机离线数天后上线也能收到）。
   * - pending：新命令
   * - sent 且 claimed_at 超过 90 秒：上次投递丢失（采集端重启/网络中断），重新投递
   */
  claimCommands(rigId) {
    const t = now();
    const rows = this.db.prepare(`SELECT * FROM commands
      WHERE rig_id = ? AND (status = 'pending' OR (status = 'sent' AND COALESCE(claimed_at, 0) < ?))
      ORDER BY created_at LIMIT 10`).all(rigId, t - 90_000);
    const stmt = this.db.prepare("UPDATE commands SET status = 'sent', claimed_at = ? WHERE id = ? AND status IN ('pending','sent')");
    for (const r of rows) stmt.run(t, r.id);
    return rows.map((r) => ({ ...r, status: 'sent', claimed_at: t }));
  }
  /** 清理长期无回执的命令（30 天前） */
  expireStaleCommands(olderThanMs = 30 * 86400_000) {
    this.db.prepare("UPDATE commands SET status = 'timeout', done_at = ? WHERE status IN ('pending','sent') AND created_at < ?")
      .run(now(), now() - olderThanMs);
  }
  recentCommands(limit = 50) {
    return this.db.prepare('SELECT * FROM commands ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  // ── 升级任务 ──
  addUpdateJob({ rigId = null, kind, targetId = null, fromVersion = null, toVersion = null }) {
    const id = randomId(8);
    this.db.prepare(`INSERT INTO update_jobs(id, rig_id, kind, target_id, from_version, to_version, status, progress, message, created_at)
      VALUES(?,?,?,?,?,?, 'pending', 0, '', ?)`).run(id, rigId, kind, targetId, fromVersion, toVersion, now());
    return id;
  }
  updateJob(id, patch) {
    const allowed = ['status', 'progress', 'message', 'done_at'];
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (!sets.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE update_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  recentUpdateJobs(limit = 100) {
    return this.db.prepare(`SELECT j.*, r.name AS rig_name FROM update_jobs j
      LEFT JOIN rigs r ON r.id = j.rig_id ORDER BY j.created_at DESC LIMIT ?`).all(limit);
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

export function openDb(dataDir) {
  return new DB(dataDir);
}
