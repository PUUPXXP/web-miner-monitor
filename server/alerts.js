// 告警引擎：规则求值 -> 触发/恢复 -> 多渠道通知
import { now, num } from '../shared/util.js';

const CHECK_MS = 15_000;
const COOLDOWN_MS = 5 * 60_000;

export class AlertEngine {
  constructor(db, bus, collector, log) {
    this.db = db;
    this.bus = bus;
    this.collector = collector;
    this.log = log;
    this.states = new Map(); // ruleId|key -> { value, since, firedAlertIds: [] }
    this.lastPush = new Map();
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.check(), CHECK_MS);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); }

  targets() {
    // [{ key, rigId, rigName, group, coin, online, value(metric 取值函数由 evaluate 决定) }]
    return this.db.listRigs().map((r) => ({
      key: r.id,
      rig: r,
    }));
  }

  matchTarget(rule, rig) {
    if (rule.target === 'fleet') return true;
    if (rule.target.startsWith('rig:')) return rule.target.slice(4) === rig.id;
    if (rule.target.startsWith('group:')) return rule.target.slice(6) === rig.group_name;
    if (rule.target.startsWith('coin:')) return rule.target.slice(5) === rig.coin;
    return true;
  }

  metricsFor(rig) {
    const live = this.collector.live.get(rig.id);
    const offlineSec = rig.online ? 0 : Math.max(0, Math.round((now() - (rig.last_seen || rig.created_at)) / 1000));
    const hashrate = num(rig.total_hashrate) ?? 0;
    const hist = live?.hashrateHistory || [];
    const recent = hist.slice(-12).map((p) => p.h).filter((v) => v > 0);
    const recentAvg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
    const lastHour = this.db.db.prepare(`SELECT AVG(hashrate) AS h FROM rig_buckets WHERE rig_id = ? AND ts > ?`).get(rig.id, now() - 3600_000)?.h;
    const baseline = num(lastHour) ?? recentAvg;
    let dropPct = 0;
    if (baseline && baseline > 0 && recentAvg !== null) dropPct = Math.max(0, (1 - recentAvg / baseline) * 100);
    const total = (rig.accepted || 0) + (rig.rejected || 0);
    const rejectPct = total > 0 ? ((rig.rejected || 0) / total) * 100 : 0;
    return {
      offline: offlineSec,
      temp: num(rig.temp_max) ?? 0,
      hashrate,
      hashrate_drop: dropPct,
      miner_down: rig.miner_state === 'running' ? 0 : (rig.miner_state === 'starting' ? 0 : 1),
      power: num(rig.power_w) ?? 0,
      rejected: rejectPct,
    };
  }

  async check() {
    let rules;
    try { rules = this.db.listAlertRules(); } catch { return; }
    const activeKeys = new Set();
    for (const rule of rules) {
      if (!rule.enabled) continue;
      let channels;
      try { channels = JSON.parse(rule.channels); } catch { channels = ['inapp']; }
      for (const rig of this.db.listRigs()) {
        if (!this.matchTarget(rule, rig)) continue;
        const key = `${rule.id}|${rig.id}`;
        activeKeys.add(key);
        const metrics = this.metricsFor(rig);
        const value = metrics[rule.metric];
        if (value === undefined) continue;
        const hit = compare(value, rule.comparator, num(rule.threshold) ?? 0);
        const st = this.states.get(key) || { since: 0, firing: false, value: null };
        if (hit) {
          if (!st.since) st.since = now();
          st.value = value;
          const shouldFire = !st.firing && now() - st.since >= (rule.duration_sec || 0) * 1000;
          if (shouldFire) {
            st.firing = true;
            const msg = this.formatMessage(rule, rig, value);
            const severity = rule.metric === 'offline' || rule.metric === 'miner_down' ? 'critical' : 'warning';
            const alertId = this.db.addAlert({
              ruleId: rule.id, rigId: rig.id, rigName: rig.name, metric: rule.metric,
              severity, message: msg, value,
            });
            this.db.addEvent({ level: 'warn', category: 'alert', rigId: rig.id, rigName: rig.name, message: msg });
            this.bus.broadcast({ type: 'alert', alert: { id: alertId, ruleId: rule.id, rigId: rig.id, rigName: rig.name, message: msg, severity, metric: rule.metric, value, ts: now() } });
            this.notify(channels, msg, { rule, rig, value, severity, alertId });
          }
        } else if (st.firing) {
          st.firing = false;
          st.since = 0;
          const open = this.db.firingAlertsFor(rule.id, rig.id);
          for (const a of open) {
            this.db.resolveAlert(a.id);
            this.bus.broadcast({ type: 'alert.resolved', alertId: a.id });
          }
          this.db.addEvent({ level: 'info', category: 'alert', rigId: rig.id, rigName: rig.name, message: `告警恢复: ${rule.name}` });
        } else {
          st.since = 0;
        }
        this.states.set(key, st);
      }
    }
    // 清理已删除规则/矿机的状态
    for (const key of this.states.keys()) if (!activeKeys.has(key)) this.states.delete(key);
  }

  formatMessage(rule, rig, value) {
    const v = typeof value === 'number' ? Math.round(value * 100) / 100 : value;
    switch (rule.metric) {
      case 'offline': return `矿机 ${rig.name} 已离线 ${Math.round(value)} 秒`;
      case 'temp': return `矿机 ${rig.name} 温度过高：${v}°C（阈值 ${rule.threshold}°C）`;
      case 'hashrate_drop': return `矿机 ${rig.name} 算力下降 ${Math.round(value)}%（阈值 ${rule.threshold}%）`;
      case 'miner_down': return `矿机 ${rig.name} 矿工未运行（状态 ${rig.miner_state || 'unknown'}）`;
      case 'power': return `矿机 ${rig.name} 功耗 ${v}W（阈值 ${rule.threshold}W）`;
      case 'rejected': return `矿机 ${rig.name} 拒绝率 ${Math.round(value * 10) / 10}%（阈值 ${rule.threshold}%）`;
      default: return `矿机 ${rig.name} 触发规则 ${rule.name}：${v}`;
    }
  }

  async notify(channels, message, ctx) {
    const t = now();
    const key = `${ctx.rule.id}:${ctx.rig.id}`;
    if (t - (this.lastPush.get(key) || 0) < COOLDOWN_MS) return;
    this.lastPush.set(key, t);
    const settings = this.db.allSettings();
    const notif = settings.notifications || {};
    const tasks = [];
    if (channels.includes('telegram') && notif.telegram?.botToken && notif.telegram?.chatId) {
      tasks.push(this.sendTelegram(notif.telegram, `【矿机告警】${message}`));
    }
    if (channels.includes('discord') && notif.discord?.webhookUrl) {
      tasks.push(this.sendDiscord(notif.discord.webhookUrl, message));
    }
    if (channels.includes('webhook') && notif.webhook?.url) {
      tasks.push(this.sendWebhook(notif.webhook.url, { message, ...ctx, ts: t }));
    }
    await Promise.allSettled(tasks);
  }

  async sendTelegram(cfg, text) {
    try {
      const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) this.log?.warn?.(`Telegram 通知失败: HTTP ${r.status}`);
    } catch (e) {
      this.log?.warn?.(`Telegram 通知异常: ${e.message}`);
    }
  }

  async sendDiscord(webhookUrl, text) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `**矿机告警**\n${text}` }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.log?.warn?.(`Discord 通知异常: ${e.message}`);
    }
  }

  async sendWebhook(url, payload) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.log?.warn?.(`Webhook 通知异常: ${e.message}`);
    }
  }

  /** 发送测试通知（设置页用） */
  async test(channel) {
    const settings = this.db.allSettings();
    const notif = settings.notifications || {};
    if (channel === 'telegram') {
      if (!notif.telegram?.botToken) throw new Error('未配置 Telegram Bot Token');
      await this.sendTelegram(notif.telegram, '✅ 矿机监控：Telegram 通知测试成功');
    } else if (channel === 'discord') {
      if (!notif.discord?.webhookUrl) throw new Error('未配置 Discord Webhook');
      await this.sendDiscord(notif.discord.webhookUrl, '✅ 矿机监控：Discord 通知测试成功');
    } else if (channel === 'webhook') {
      if (!notif.webhook?.url) throw new Error('未配置 Webhook 地址');
      await this.sendWebhook(notif.webhook.url, { message: '✅ 矿机监控：Webhook 测试成功', ts: now() });
    } else {
      throw new Error('未知通知渠道');
    }
  }
}

function compare(value, cmp, threshold) {
  const v = num(value) ?? 0;
  switch (cmp) {
    case '>': return v > threshold;
    case '>=': return v >= threshold;
    case '<': return v < threshold;
    case '<=': return v <= threshold;
    case '==': return v === threshold;
    default: return false;
  }
}
