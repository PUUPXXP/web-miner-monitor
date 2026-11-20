// 币种注册表：内置币种 + 用户在控制台自定义的币种
// 自定义币种保存在 settings.customCoins（JSON），采集端从飞行表拿到 coin 字符串即可，
// 因此新增币种不需要升级采集端。
import { COINS as BUILTIN_COINS } from './miners.js';

/**
 * @typedef {Object} CoinDef
 * @property {string} symbol
 * @property {string} name
 * @property {string} algo         默认算法
 * @property {string} unit         算力单位
 * @property {string} color        UI 颜色
 * @property {boolean} builtin
 * @property {string[]} miners     兼容的矿工 id（从注册表读取）
 * @property {string} [poolHint]   矿池填写提示
 * @property {Object} [emission]   收益公式参数
 */

const COIN_COLORS = ['#f59e0b', '#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#facc15', '#fb7185', '#22d3ee'];

export function normalizeCoin(input, existingCount = 0) {
  const symbol = String(input?.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) throw new Error('币种代号需为 2-12 位大写字母或数字');
  const name = String(input?.name || '').trim() || symbol;
  const algo = String(input?.algo || '').trim() || 'custom';
  return {
    symbol,
    name: name.slice(0, 40),
    algo: algo.slice(0, 30),
    unit: String(input?.unit || 'H/s').slice(0, 10),
    color: /^#[0-9a-f]{6}$/i.test(input?.color || '') ? input.color : COIN_COLORS[existingCount % COIN_COLORS.length],
    family: String(input?.family || 'custom').slice(0, 30),
    addressHint: String(input?.addressHint || '').slice(0, 120),
    builtin: false,
    miners: Array.isArray(input?.miners) ? input.miners.map(String).slice(0, 20) : [],
    emission: input?.emission && typeof input.emission === 'object' ? input.emission : undefined,
  };
}

/** 合并内置 + 自定义币种；自定义不能覆盖内置代号 */
export function buildCoinRegistry(customCoins = [], miners = {}) {
  const reg = {};
  for (const [symbol, def] of Object.entries(BUILTIN_COINS)) {
    reg[symbol] = {
      symbol,
      name: def.name,
      algo: def.defaultAlgo,
      unit: def.unit || 'H/s',
      color: def.color,
      family: def.family,
      builtin: true,
      miners: Object.values(miners).filter((m) => m.coins?.includes(symbol)).map((m) => m.id),
      emission: def.emission,
      netStats: def.netStats,
    };
  }
  for (const c of Array.isArray(customCoins) ? customCoins : []) {
    if (!c?.symbol || reg[c.symbol]) continue;
    reg[c.symbol] = {
      symbol: c.symbol,
      name: c.name || c.symbol,
      algo: c.algo || 'custom',
      unit: c.unit || 'H/s',
      color: c.color || '#7c5cff',
      family: c.family || 'custom',
      builtin: false,
      miners: Array.isArray(c.miners) && c.miners.length
        ? c.miners
        : Object.values(miners).filter((m) => m.coins?.includes(c.symbol) || m.coins?.includes('*')).map((m) => m.id),
      addressHint: c.addressHint || '',
      emission: c.emission,
    };
  }
  return reg;
}

/** 估算收益：内置币种用各自公式，自定义币种用通用公式（若提供 emission） */
export function estimateCoinEarnings(coinDef, { hashrate, powerW, price, netHashrate, heights = {} }) {
  const hr = Number(hashrate) || 0;
  const p = Number(price);
  const nh = Number(netHashrate);
  if (!hr || !Number.isFinite(p) || !nh) return null;
  const share = hr / nh;
  let coinPerDay = null;
  if (coinDef.emission?.total && coinDef.emission?.c && heights[coinDef.symbol]) {
    const h = heights[coinDef.symbol];
    const blockTime = Number(coinDef.emission.blockTimeSec) || 120;
    coinPerDay = share * (86400 / blockTime) * ((coinDef.emission.total * coinDef.emission.c) / ((h + coinDef.emission.c) * (h + coinDef.emission.c - 1)));
  } else if (coinDef.symbol === 'XMR') {
    coinPerDay = share * (86400 / 120) * 0.6;
  } else if (coinDef.symbol === 'PRL') {
    coinPerDay = null; // 由调用方用准确公式计算
  }
  if (!coinPerDay) return null;
  const revenue = coinPerDay * p;
  const electricity = (Number(powerW) || 0) / 1000 * 24 * 0.7;
  return {
    coinPerDay: Math.round(coinPerDay * 1e6) / 1e6,
    coinPerMonth: Math.round(coinPerDay * 30 * 1e4) / 1e4,
    revenueDay: Math.round(revenue * 100) / 100,
    electricityDay: Math.round(electricity * 100) / 100,
    profitDay: Math.round((revenue - electricity) * 100) / 100,
    price: p,
    netHashrate: nh,
  };
}
