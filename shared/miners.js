// 币种 / 矿工目录：服务端与采集端共用。
// 数据依据 2026-11 的实测调研（见 docs/挖矿知识与参数.md）：Pearl 使用 PearlHash 算法，
// 主流矿工是 PeakMiner / SRBMiner-MULTI / bzMiner / OneZeroMiner / WildRig，lolMiner 不支持 Pearl。
// 这里只描述"某种矿工怎么启动、去哪里读数据"，不绑定具体路径（路径由飞行表配置）。

export const COINS = {
  XMR: {
    symbol: 'XMR',
    name: 'Monero 门罗',
    family: 'RandomX',
    unit: 'H/s',
    defaultAlgo: 'rx/0',
    color: '#ff6600',
    algoHelp: 'RandomX（rx/0）：CPU 挖矿为主，显卡挖 XMR 性价比很低。',
    priceIds: { coingecko: 'monero' },
    netStats: {
      label: 'Monero 网络',
      url: 'https://moneroblocks.info/api/get_stats',
      extract: (j) => ({ hashrate: j?.hashrate ?? null, difficulty: j?.difficulty ?? null, height: j?.height ?? null }),
    },
  },
  PRL: {
    symbol: 'PRL',
    name: 'Pearl',
    family: 'PearlHash',
    unit: 'H/s',
    defaultAlgo: 'pearlhash',
    color: '#33e0c8',
    algoHelp: 'PearlHash（ZK 证明式 PoW）：GPU 挖矿，NVIDIA 20 系及以上；算力数值比普通算法小很多。',
    priceIds: {},
    // Pearl 总量 21 亿，无限接近；补贴公式见 docs/挖矿知识与参数.md
    emission: { total: 2_100_000_000, c: 650_226, blockTimeSec: 194 },
    netStats: {
      label: 'Pearl 网络',
      url: 'https://server.miningpoolstats.stream/data/pearl.js',
      extract: (j) => ({ hashrate: j?.hashrate ?? null, difficulty: j?.difficulty ?? null, height: j?.height ?? null, price: j?.price ?? null }),
    },
  },
};

/** 矿工目录
 *  - bin: 默认可执行文件名（Windows）
 *  - family: 采集端统计解析器（xmrig / peakminer / srbminer / bzminer / onezero / wildrig / teamredminer / gminer / custom）
 *  - api: 内置 HTTP 统计接口
 *  - buildArgs(profile) -> string[]
 */
export const MINERS = {
  // ───────── Monero ─────────
  xmrig: {
    id: 'xmrig',
    name: 'XMRig',
    bin: 'xmrig.exe',
    binLinux: 'xmrig',
    family: 'xmrig',
    coins: ['XMR'],
    api: { kind: 'http', port: 3333, path: '/2/summary' },
    version: '6.26.0',
    download: 'https://github.com/xmrig/xmrig/releases/download/v6.26.0/xmrig-6.26.0-windows-x64.zip',
    buildArgs(p) {
      const args = ['-o', p.poolUrl];
      if (p.poolUser) args.push('-u', p.poolUser);
      if (p.poolPass) args.push('-p', p.poolPass);
      args.push('-a', p.algo || 'rx/0');
      if (p.workerName) args.push('--rig-id', p.workerName);
      if (p.tls) args.push('--tls');
      if (p.extraArgs) args.push(...splitArgs(p.extraArgs));
      if (!p.isCustom) {
        args.push('--http-host', '127.0.0.1', '--http-port', String(p.apiPort || 3333));
        if (p.apiToken) args.push('--http-access-token', p.apiToken);
      }
      args.push('--no-color', '--print-time', '30');
      return args;
    },
    hint: 'XMRig 6.26+ / RandomX（CPU 挖门罗首选，Windows 版官方提供）',
  },
  srbminer: {
    id: 'srbminer',
    name: 'SRBMiner-MULTI',
    bin: 'SRBMiner-MULTI.exe',
    binLinux: 'SRBMiner-MULTI',
    family: 'srbminer',
    coins: ['XMR', 'PRL'],
    api: { kind: 'http', port: 21550, path: '/' },
    version: '3.8.9',
    download: 'https://github.com/doktor83/SRBMiner-Multi/releases/download/3.8.9/SRBMiner-Multi-3-8-9-win64.zip',
    buildArgs(p) {
      const args = [];
      if (p.coin === 'XMR') args.push('--disable-gpu');
      else args.push('--disable-cpu');
      args.push('--algorithm', p.algo || (p.coin === 'PRL' ? 'pearlhash' : 'randomx'), '--pool', p.poolUrl);
      if (p.poolUser) args.push('--wallet', p.poolUser);
      if (p.poolPass) args.push('--password', p.poolPass);
      if (p.workerName) args.push('--worker', p.workerName);
      if (p.tls) args.push('--tls');
      args.push('--api-enable', '--api-port', String(p.apiPort || 21550), '--api-rig-id', p.workerName || 'rig');
      if (p.extraArgs) args.push(...splitArgs(p.extraArgs));
      return args;
    },
    hint: 'SRBMiner-MULTI 3.8.9（XMR=CPU / PRL=GPU，AMD+NVIDIA，API 端口 21550）',
  },
  teamredminer: {
    id: 'teamredminer',
    name: 'TeamRedMiner',
    bin: 'teamredminer.exe',
    binLinux: 'teamredminer',
    family: 'teamredminer',
    coins: ['XMR'],
    api: { kind: 'http', port: 4028, path: '/' },
    buildArgs(p) {
      const args = ['-a', p.algo || 'rx/0', '-o', p.poolUrl];
      if (p.poolUser) args.push('-u', p.poolUser);
      if (p.poolPass) args.push('-p', p.poolPass);
      if (p.workerName) args.push('-r', p.workerName);
      if (p.tls) args.push('--use_tls', 'true');
      if (p.extraArgs) args.push(...splitArgs(p.extraArgs));
      args.push('--api_listen', `127.0.0.1:${p.apiPort || 4028}`);
      return args;
    },
    hint: 'TeamRedMiner（AMD 卡 RandomX；显卡挖 XMR 仅作备选）',
  },

  // ───────── Pearl ─────────
  peakminer: {
    id: 'peakminer',
    name: 'PeakMiner',
    bin: 'peakminer.exe',
    binLinux: 'peakminer',
    family: 'peakminer',
    coins: ['PRL'],
    api: { kind: 'http', port: 4068, path: '/summary' },
    version: '2.20.9',
    download: 'https://github.com/peakminer/peakminer/releases/download/v2.20.9/peakminer-2.20.9-windows-x86_64.zip',
    buildArgs(p) {
      // PeakMiner：TLS 由 URL 前缀决定（stratum+ssl://），没有 --tls 参数
      const url = p.tls && !/^(stratum\+ssl|stratum\+tls):\/\//i.test(p.poolUrl || '')
        ? `stratum+ssl://${p.poolUrl}`
        : p.poolUrl;
      const args = ['--coin', 'pearl', '-o', url];
      if (p.poolUser) {
        const user = p.workerName && !String(p.poolUser).includes('.') ? `${p.poolUser}.${p.workerName}` : p.poolUser;
        args.push('-u', user);
      }
      args.push('--api-port', String(p.apiPort || 4068));
      if (p.apiKey) args.push('--api-key', p.apiKey);
      if (p.extraArgs) args.push(...splitArgs(p.extraArgs));
      return args;
    },
    hint: 'PeakMiner 2.20+（Pearl 首选：文档完整、API 含每卡温度/功耗/份额）',
  },
  bzminer: {
    id: 'bzminer',
    name: 'bzMiner',
    bin: 'bzminer.exe',
    binLinux: 'bzminer',
    family: 'bzminer',
    coins: ['PRL', 'XMR'],
    api: { kind: 'http', port: 4014, path: '/api/snapshot' },
    version: '100.81',
    download: 'https://github.com/bzminer/bzminer/releases/download/v100.81/bzminer_v100.81_windows.zip',
    buildArgs(p) {
      const algo = p.algo || (p.coin === 'PRL' ? 'pearl' : 'randomx');
      const args = ['-a', algo, '-p', p.poolUrl];
      if (p.poolUser) args.push('-w', p.poolUser);
      if (p.poolPass) args.push('-r', p.poolPass);
      if (p.workerName) args.push('--nc', '1');
      if (p.tls) args.push('--ssl', '1');
      args.push('--http_enabled', '1', '--http_port', String(p.apiPort || 4014));
      if (p.extraArgs) args.push(...splitArgs(p.extraArgs));
      return args;
    },
    hint: 'bzMiner v100（NVIDIA/AMD/Intel，多算法，自带 Web UI 在 4014）',
  },
  onezerominer: {
    id: 'onezerominer',
    name: 'OneZeroMiner',
    bin: 'onezerominer.exe',
    binLinux: 'onezerominer',
    family: 'onezero',
    coins: ['PRL'],
    api: { kind: 'http', port: 3001, path: '/summary' },
    version: '1.8.6',
    download: 'https://github.com/OneZeroMiner/onezerominer/releases/download/v1.8.6/onezerominer-win64-1.8.6.zip',
    buildArgs(p) {
      const args = ['-a', p.algo || 'pearl', '-w', p.poolUser || ''];
      args.push('-o', p.poolUrl);
      if (p.extraArgs) args.push(...splitArgs(p.extraArgs));
      args.push('--api-port', String(p.apiPort || 3001));
      return args;
    },
    hint: 'OneZeroMiner 1.8.6（Pearl 支持，API 端口 3001）',
  },
  wildrig: {
    id: 'wildrig',
    name: 'WildRig Multi',
    bin: 'wildrig.exe',
    binLinux: 'wildrig',
    family: 'wildrig',
    coins: ['PRL'],
    api: { kind: 'http', port: 3333, path: '/' },
    version: '0.52.3',
    download: 'https://github.com/andru-kun/wildrig-multi/releases/download/0.52.3/wildrig-multi-windows-0.52.3.zip',
    buildArgs(p) {
      const args = ['-a', p.algo || 'pearlhash', '-o', p.poolUrl];
      if (p.poolUser) args.push('-u', p.poolUser);
      if (p.poolPass) args.push('-p', p.poolPass);
      if (p.workerName) args.push('--api-worker-id', p.workerName);
      args.push('--api-port', String(p.apiPort || 3333));
      if (p.extraArgs) args.push(...splitArgs(p.extraArgs));
      return args;
    },
    hint: 'WildRig Multi（Pearlhash 老牌实现，AMD 也可）',
  },
  gminer: {
    id: 'gminer',
    name: 'GMiner',
    bin: 'miner.exe',
    binLinux: 'miner',
    family: 'gminer',
    coins: ['PRL'],
    api: { kind: 'http', port: 4000, path: '/stat' },
    buildArgs(p) {
      const args = ['--algo', p.algo || 'pearl', '--server', p.poolUrl];
      if (p.poolUser) args.push('--user', p.poolUser);
      if (p.poolPass) args.push('--pass', p.poolPass);
      if (p.workerName) args.push('--worker', p.workerName);
      if (p.tls) args.push('--ssl', '1');
      if (p.extraArgs) args.push(...splitArgs(p.extraArgs));
      args.push('--api', String(p.apiPort || 4000));
      return args;
    },
    hint: 'GMiner（NVIDIA 优化；请确认版本支持 PearlHash）',
  },

  // ───────── 通用 ─────────
  custom: {
    id: 'custom',
    name: '自定义矿工',
    bin: '',
    binLinux: '',
    family: 'custom',
    coins: ['XMR', 'PRL'],
    api: { kind: 'http', port: 3333, path: '/2/summary' },
    buildArgs(p) {
      return splitArgs(renderTemplate(p.command || '', p));
    },
    hint: '任意矿工：命令模板支持 {pool} {wallet} {worker} {algo} {pass} {port} 占位符',
  },
};

/** 常见矿池预设（2026-11 实测端口） */
export const POOL_PRESETS = {
  XMR: [
    { name: 'MoneroOcean', url: 'gulf.moneroocean.stream:10128', tls: false, site: 'https://moneroocean.stream' },
    { name: 'MoneroOcean TLS', url: 'gulf.moneroocean.stream:20128', tls: true, site: 'https://moneroocean.stream' },
    { name: 'SupportXMR', url: 'pool.supportxmr.com:3333', tls: false, site: 'https://supportxmr.com' },
    { name: 'SupportXMR TLS', url: 'pool.supportxmr.com:443', tls: true, site: 'https://supportxmr.com' },
    { name: '2Miners TLS', url: 'xmr.2miners.com:12222', tls: true, site: 'https://xmr.2miners.com' },
    { name: 'HeroMiners TLS', url: 'monero.herominers.com:1118', tls: true, site: 'https://monero.herominers.com' },
  ],
  PRL: [
    { name: 'Kryptex (SSL)', url: 'prl.kryptex.network:8048', tls: true, site: 'https://pool.kryptex.com/prl' },
    { name: 'Kryptex (TCP)', url: 'prl.kryptex.network:7048', tls: false, site: 'https://pool.kryptex.com/prl' },
    { name: 'f2pool', url: 'pearl.f2pool.com:5500', tls: false, site: 'https://www.f2pool.com' },
    { name: 'PearlHash (TLS)', url: 'pool.pearlhash.xyz:9443', tls: true, site: 'https://pearlhash.xyz' },
    { name: 'PearlHash (TCP)', url: 'pool.pearlhash.xyz:9000', tls: false, site: 'https://pearlhash.xyz' },
    { name: 'HeroMiners US', url: 'us.pearl.herominers.com:1200', tls: false, site: 'https://pearl.herominers.com' },
    { name: 'LuckyPool', url: 'pearl.luckypool.io:3360', tls: false, site: 'https://pearl.luckypool.io' },
  ],
};

/** 算法选项 */
export const ALGO_PRESETS = {
  XMR: ['rx/0', 'rx/wow', 'rx/xeq', 'rx/arq', 'rx/sfx'],
  PRL: ['pearlhash'],
};

/**
 * Pearl 区块补贴（PRL）：smooth decay，无减半。
 * cumulative(h) = TOTAL * h / (h + C)，subsidy(h) = TOTAL*C/((h+C)*(h+C-1))
 */
export function pearlSubsidy(height) {
  const { total, c } = COINS.PRL.emission;
  const h = Math.max(0, Number(height) || 0);
  return (total * c) / ((h + c) * (h + c - 1));
}

/** 根据币种 + 矿工构造完整启动参数 */
export function buildCommand(minerId, profile) {
  const miner = MINERS[minerId] || MINERS.custom;
  return {
    bin: process.platform === 'win32' ? miner.bin : (miner.binLinux || miner.bin),
    args: miner.buildArgs(profile),
    family: miner.family,
    api: {
      port: Number(profile.apiPort || miner.api?.port || 0) || null,
      path: miner.api?.path || '/',
    },
  };
}

export function minerForCoin(coin) {
  return Object.values(MINERS).filter((m) => m.coins.includes(coin));
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s ?? '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function renderTemplate(tpl, p) {
  return String(tpl)
    .replaceAll('{pool}', p.poolUrl || '')
    .replaceAll('{wallet}', p.poolUser || '')
    .replaceAll('{worker}', p.workerName || '')
    .replaceAll('{algo}', p.algo || '')
    .replaceAll('{pass}', p.poolPass || 'x')
    .replaceAll('{port}', String(p.apiPort || ''));
}
