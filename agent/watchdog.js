// 采集端看门狗：崩溃重启、算力掉零/骤降重启、过热保护
import { num, now } from '../shared/util.js';

export class Watchdog {
  constructor({ log, runner }) {
    this.log = log;
    this.runner = runner;
    this.restarts = 0;
    this.lastRestartAt = null;
    this.reason = null;
    this.state = 'idle';       // idle | ok | warn | cooling
    this.recentRestarts = [];  // 重启时间戳，用于避免死循环
    this.hashSamples = [];     // { t, h }
    this.lastCrashRestartAt = 0;
    this.hotSince = 0;
  }

  /** 每次心跳调用。返回是否需要动作（内部已执行或标记） */
  async check({ profile, minerState, stats, tempMax, enabled }) {
    if (!profile || !enabled) {
      this.state = 'idle';
      return { action: null };
    }
    const wd = profile.watchdog || {};
    if (wd.enabled === false) {
      this.state = 'disabled';
      return { action: null };
    }
    const t = now();
    const cfg = {
      maxTempC: num(wd.maxTempC) ?? 85,
      minHashratePercent: num(wd.minHashratePercent) ?? 60,
      crashRestart: wd.crashRestart !== false,
      restartDelaySec: num(wd.restartDelaySec) ?? 10,
      maxRestartsPerHour: num(wd.maxRestartsPerHour) ?? 20,
      hashDropGraceSec: num(wd.hashDropGraceSec) ?? 180,
    };

    // 1) 过热保护
    if (tempMax !== null && tempMax >= cfg.maxTempC) {
      if (!this.hotSince) this.hotSince = t;
      this.state = 'hot';
      // 持续 30 秒过热则停止矿工，等温度降下来
      if (t - this.hotSince > 30_000 && minerState === 'running') {
        this.log?.warn?.(`GPU 温度 ${tempMax}°C 超过 ${cfg.maxTempC}°C，停止矿工保护硬件`);
        await this.runner.stop();
        this.hotSince = t;
        return { action: 'stopped-hot', detail: `温度 ${tempMax}°C 超过阈值` };
      }
    } else {
      this.hotSince = 0;
      if (this.state === 'hot') this.state = 'ok';
    }

    // 2) 崩溃重启
    if ((minerState === 'stopped' || minerState === 'error') && cfg.crashRestart) {
      this.state = 'restarting';
      if (t - this.lastCrashRestartAt < cfg.restartDelaySec * 1000) return { action: null };
      if (!this._allowRestart(cfg.maxRestartsPerHour)) {
        this.log?.error?.('看门狗：重启过于频繁，已暂停自动重启（请检查矿工配置/矿池）');
        this.state = 'blocked';
        return { action: 'blocked' };
      }
      this.lastCrashRestartAt = t;
      const r = await this._restart(profile, '矿工未运行，自动重启');
      return { action: 'restarted', ...r };
    }

    // 3) 算力骤降 / 掉零
    if (minerState === 'running') {
      const h = num(stats?.hashrate) ?? 0;
      this.hashSamples.push({ t, h });
      this.hashSamples = this.hashSamples.filter((s) => t - s.t < 15 * 60_000);
      if (this.hashSamples.length >= 6) {
        const recent = this.hashSamples.slice(-6).map((s) => s.h);
        const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const older = this.hashSamples.slice(0, -6).map((s) => s.h).filter((v) => v > 0);
        const baseline = older.length ? older.reduce((a, b) => a + b, 0) / older.length : null;
        const runningFor = this.hashSamples[0] ? t - this.hashSamples[0].t : 0;
        const dropped = baseline && baseline > 0 ? (1 - recentAvg / baseline) * 100 : 0;
        const zero = recentAvg === 0 && this.hashSamples.length >= 12;
        if ((zero || dropped >= cfg.minHashratePercent) && runningFor > cfg.hashDropGraceSec * 1000) {
          if (!this._allowRestart(cfg.maxRestartsPerHour)) {
            this.state = 'blocked';
            return { action: 'blocked' };
          }
          const why = zero ? '算力为 0' : `算力下降 ${Math.round(dropped)}%`;
          const r = await this._restart(profile, why);
          this.hashSamples = [];
          return { action: 'restarted', ...r };
        }
      }
      if (this.state === 'idle') this.state = 'ok';
    }

    if (this.state !== 'hot') this.state = 'ok';
    return { action: null };
  }

  _allowRestart(maxPerHour) {
    const t = now();
    this.recentRestarts = this.recentRestarts.filter((x) => t - x < 3600_000);
    return this.recentRestarts.length < maxPerHour;
  }

  async _restart(profile, reason) {
    this.restarts += 1;
    this.lastRestartAt = now();
    this.reason = reason;
    this.recentRestarts.push(now());
    this.log?.warn?.(`看门狗重启矿工：${reason}`);
    try {
      const r = await this.runner.restart(profile);
      return { ok: true, pid: r.pid };
    } catch (e) {
      this.log?.error?.(`看门狗重启失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }
}
