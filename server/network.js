// 外部行情/网络数据：CoinGecko 价格、门罗网络算力。带 5 分钟缓存，失败不影响系统
import { num, now } from '../shared/util.js';

const PRICE_TTL = 5 * 60_000;

export class NetworkStats {
  constructor(log) {
    this.log = log;
    this.cache = { t: 0, price: {}, net: {} };
    this.fetching = null;
  }

  /** CoinLore 聚合行情兜底（国内机房可访问；id=28 为 Monero） */
  async coinloreTicker(id) {
    try {
      const r = await fetch(`https://api.coinlore.net/api/ticker/?id=${id}`, {
        headers: { accept: 'application/json', 'user-agent': 'web-miner-monitor/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return null;
      const j = await r.json();
      const t = Array.isArray(j) ? j[0] : null;
      if (!t || !num(t.price_usd)) return null;
      return { usd: num(t.price_usd), change24h: num(t.percent_change_24h), source: 'coinlore' };
    } catch {
      return null;
    }
  }

  /** Gate.io 公开行情兜底（CoinGecko 在部分机房不可达） */
  async gateTicker(pair) {    try {
      const r = await fetch(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`, {
        headers: { accept: 'application/json', 'user-agent': 'web-miner-monitor/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return null;
      const j = await r.json();
      const t = Array.isArray(j) ? j[0] : null;
      if (!t || !num(t.last)) return null;
      return { usd: num(t.last), change24h: num(t.change_percentage) };
    } catch {
      return null;
    }
  }

  async refresh(force = false) {
    if (!force && now() - this.cache.t < PRICE_TTL) return this.cache;
    if (this.fetching) return this.fetching;
    this.fetching = (async () => {
      const out = { t: now(), price: {}, net: {} };
      // 价格：CoinGecko 免费接口（可能被网络屏蔽，失败则忽略）
      try {
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd,cny&include_24hr_change=true', {
          headers: { accept: 'application/json', 'user-agent': 'web-miner-monitor/1.0' },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const j = await r.json();
          if (j.monero) {
            out.price.XMR = {
              usd: num(j.monero.usd), cny: num(j.monero.cny),
              change24h: num(j.monero.usd_24h_change),
            };
          }
        }
      } catch (e) {
        this.log?.warn?.(`价格获取失败: ${e.message}`);
      }
      // XMR 价格兜底：CoinGecko 在部分网络（如中国大陆机房）不可达，改用 CoinLore 聚合行情
      if (!out.price.XMR) {
        const c = await this.coinloreTicker('28');
        if (c) out.price.XMR = c;
      }
      // 门罗网络算力/难度/高度
      try {
        const r = await fetch('https://moneroblocks.info/api/get_stats', {
          headers: { accept: 'application/json', 'user-agent': 'web-miner-monitor/1.0' },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const j = await r.json();
          out.net.XMR = {
            hashrate: num(j.hashrate),
            difficulty: num(j.difficulty),
            height: num(j.height),
            lastReward: num(j.last_reward) ? num(j.last_reward) / 1e12 : null,
          };
        }
      } catch { /* 忽略 */ }
      // Pearl 价格：优先 CoinGecko（若可用），否则 Gate.io 公开行情
      // Pearl 价格：优先 CoinGecko（若可用），否则 Gate.io 公开行情
      if (!out.price.PRL) {
        const g = await this.gateTicker('PRL_USDT');
        if (g) out.price.PRL = g;
      }
      // Pearl 网络数据（MiningPoolStats 合成了算力/难度/高度/价格）
      try {
        const r = await fetch('https://server.miningpoolstats.stream/data/pearl.js', {
          headers: { accept: 'application/json', 'user-agent': 'web-miner-monitor/1.0' },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const j = await r.json();
          out.net.PRL = {
            hashrate: num(j.hashrate),
            difficulty: num(j.difficulty),
            height: num(j.height),
            blockTime: num(j.block_time_average) ?? num(j.block_time_target),
            pools: Array.isArray(j.poolsminers) ? j.poolsminers : null,
          };
          if (!out.price.PRL && num(j.price)) out.price.PRL = { usd: num(j.price), change24h: null };
        }
      } catch { /* 忽略 */ }
      this.cache = { ...this.cache, ...out, price: { ...this.cache.price, ...out.price }, net: { ...this.cache.net, ...out.net } };
      return this.cache;
    })().finally(() => { this.fetching = null; });
    return this.fetching;
  }

  snapshot() {
    return this.cache;
  }
}
