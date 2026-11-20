// 历史数据聚合：把 10s 级 GPU 采样压缩成按分钟对齐的曲线，供图表使用
import { now, num } from '../shared/util.js';

const BUCKET_MS = 5 * 60_000;

/** 按时间范围自动选择聚合粒度（秒） */
export function pickGranularity(rangeMs) {
  if (rangeMs <= 3 * 3600_000) return 60;
  if (rangeMs <= 24 * 3600_000) return 300;
  if (rangeMs <= 7 * 24 * 3600_000) return 900;
  return 3600;
}

export class History {
  constructor(db) {
    this.db = db;
  }

  /** 机群总算力/功耗曲线（按币种分别汇总） */
  fleetSeries({ from, to, granularity, coin = null }) {
    const step = Math.max(60, Number(granularity) || pickGranularity(to - from)) * 1000;
    const rows = this.db.db.prepare(`SELECT coin, ts, hashrate, rigs, power, accepted, rejected FROM buckets
      WHERE ts BETWEEN ? AND ? ${coin ? 'AND coin = ?' : ''} ORDER BY ts ASC`).all(from, to, ...(coin ? [coin] : []));
    const byStep = new Map();
    for (const r of rows) {
      const key = Math.floor(r.ts / step) * step;
      let agg = byStep.get(key);
      if (!agg) { agg = { ts: key, hashrate: 0, power: 0, rigs: 0, accepted: 0, rejected: 0, coins: {} }; byStep.set(key, agg); }
      agg.hashrate += num(r.hashrate) ?? 0;
      agg.power += num(r.power) ?? 0;
      agg.rigs += num(r.rigs) ?? 0;
      agg.accepted += num(r.accepted) ?? 0;
      agg.rejected += num(r.rejected) ?? 0;
      agg.coins[r.coin] = (agg.coins[r.coin] || 0) + (num(r.hashrate) ?? 0);
    }
    return [...byStep.values()].sort((a, b) => a.ts - b.ts);
  }

  /** 单机曲线：优先 rig_buckets，没有则为空 */
  rigSeries(rigId, { from, to, granularity }) {
    const step = Math.max(60, Number(granularity) || pickGranularity(to - from)) * 1000;
    const rows = this.db.db.prepare(`SELECT ts, hashrate, power, temp_max, fan_max, accepted, rejected, samples
      FROM rig_buckets WHERE rig_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC`).all(rigId, from, to);
    const byStep = new Map();
    for (const r of rows) {
      const key = Math.floor(r.ts / step) * step;
      let agg = byStep.get(key);
      if (!agg) {
        agg = { ts: key, hashrate: 0, power: 0, tempMax: 0, fanMax: 0, accepted: 0, rejected: 0, n: 0 };
        byStep.set(key, agg);
      }
      agg.hashrate += num(r.hashrate) ?? 0;
      agg.power += num(r.power) ?? 0;
      agg.tempMax = Math.max(agg.tempMax, num(r.temp_max) ?? 0);
      agg.fanMax = Math.max(agg.fanMax, num(r.fan_max) ?? 0);
      agg.accepted += num(r.accepted) ?? 0;
      agg.rejected += num(r.rejected) ?? 0;
      agg.n += 1;
    }
    return [...byStep.values()].map((a) => ({ ...a, tempMax: a.tempMax || null, fanMax: a.fanMax || null })).sort((a, b) => a.ts - b.ts);
  }

  /** 逐卡曲线（直接读 10s 采样，按 GPU 分组） */
  gpuSeries(rigId, { from, to, granularity }) {
    const step = Math.max(60, Number(granularity) || pickGranularity(to - from)) * 1000;
    const rows = this.db.gpuSamples(rigId, from, to, 20000);
    const byGpu = new Map();
    for (const r of rows) {
      const key = Math.floor(r.ts / step) * step;
      if (!byGpu.has(r.gpuIndex)) byGpu.set(r.gpuIndex, new Map());
      const steps = byGpu.get(r.gpuIndex);
      let agg = steps.get(key);
      if (!agg) { agg = { ts: key, hashrate: [], temp: [], fan: [], power: [], util: [], name: r.name }; steps.set(key, agg); }
      for (const k of ['hashrate', 'temp', 'fan', 'power', 'util']) {
        const v = num(r[k]);
        if (v !== null) agg[k].push(v);
      }
    }
    const gpus = [];
    for (const [index, steps] of [...byGpu.entries()].sort((a, b) => a[0] - b[0])) {
      const series = [...steps.values()].sort((a, b) => a.ts - b.ts);
      const avg = (arr) => (arr.length ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100 : null);
      gpus.push({
        index,
        name: series[0]?.name || `GPU ${index}`,
        points: series.map((s) => ({
          ts: s.ts,
          hashrate: avg(s.hashrate),
          temp: avg(s.temp),
          fan: avg(s.fan),
          power: avg(s.power),
          util: avg(s.util),
        })),
      });
    }
    return gpus;
  }

  /** 把最近 5 分钟聚合写入房间桶（每 5 分钟一次），由定时任务调用 */
  rollup() {
    const t = now();
    const windowMs = 5 * 60_000;
    const from = Math.floor((t - windowMs) / windowMs) * windowMs;
    const to = from + windowMs;
    const rigs = this.db.listRigs();
    let n = 0;
    for (const rig of rigs) {
      const rows = this.db.db.prepare(`SELECT COUNT(*) AS n, AVG(hashrate) AS hr, AVG(power) AS pw,
        MAX(temp) AS tmax, MAX(fan) AS fmax FROM gpu_samples WHERE rig_id = ? AND ts >= ? AND ts < ?`).get(rig.id, from, to);
      if (!rows || !rows.n) continue;
      this.db.insertRigBucket(rig.id, from, {
        hashrate: round2(rows.hr),
        power: round2(rows.pw),
        tempMax: round2(rows.tmax),
        fanMax: round2(rows.fmax),
        accepted: rig.accepted || 0,
        rejected: rig.rejected || 0,
        samples: rows.n,
      });
      n++;
    }
    // 币种汇总（用当前在线数据：当前版本的机群桶在采集时实时更新更简单）
    this.rollupCoins(from);
    return n;
  }

  rollupCoins(ts) {
    const rigs = this.db.listRigs();
    const byCoin = new Map();
    for (const r of rigs) {
      if (!byCoin.has(r.coin)) byCoin.set(r.coin, { hashrate: 0, rigs: 0, power: 0, accepted: 0, rejected: 0 });
      const c = byCoin.get(r.coin);
      if (r.online) {
        c.hashrate += num(r.total_hashrate) ?? 0;
        c.rigs += 1;
        c.power += num(r.power_w) ?? 0;
      }
      c.accepted += num(r.accepted) ?? 0;
      c.rejected += num(r.rejected) ?? 0;
    }
    for (const [coin, v] of byCoin) {
      this.db.insertBucket(coin, ts, {
        hashrate: round2(v.hashrate), rigs: v.rigs, power: round2(v.power),
        accepted: v.accepted, rejected: v.rejected,
      });
    }
  }

  /** 保留策略：GPU 明细 7 天，桶 90 天 */
  purge() {
    const t = now();
    this.db.purgeGpuSamples(t - 7 * 86400_000);
    this.db.db.prepare('DELETE FROM rig_buckets WHERE ts < ?').run(t - 90 * 86400_000);
    this.db.db.prepare('DELETE FROM buckets WHERE ts < ?').run(t - 90 * 86400_000);
    this.db.db.prepare('DELETE FROM events WHERE ts < ?').run(t - 30 * 86400_000);
    this.db.db.prepare("DELETE FROM alerts WHERE state = 'resolved' AND resolved_at < ?").run(t - 30 * 86400_000);
    this.db.q.purgeSessions.run(t);
  }
}

function round2(v) {
  const n = num(v);
  return n === null ? null : Math.round(n * 100) / 100;
}
