// DOM 冒烟测试（jsdom）：真实调用 API，挂载每个页面并检查渲染结果
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PASS = process.argv[3] || 'admin12345';

const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div><div id="toast-root"></div><div id="modal-root"></div></body></html>`, {
  url: BASE + '/',
  pretendToBeVisual: true,
});
const { window } = dom;

// 浏览器 API 垫片
class FakeWS {
  constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 10); }
  send() {}
  close() { this.readyState = 3; }
}
window.WebSocket = FakeWS;
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
window.scrollTo = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLCanvasElement.prototype.getContext = function () {
  const noop = () => {};
  return {
    setTransform: noop, clearRect: noop, fillText: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    stroke: noop, fill: noop, arc: noop, closePath: noop, createLinearGradient: () => ({ addColorStop: noop }),
    measureText: () => ({ width: 20 }), set lineWidth(v) {}, set strokeStyle(v) {}, set fillStyle(v) {},
    set font(v) {}, set textAlign(v) {}, set lineJoin(v) {},
  };
};
window.navigator.clipboard = { writeText: async () => {} };
window.URL.createObjectURL = () => 'blob:test';
window.URL.revokeObjectURL = () => {};

// 复制到全局，供模块使用（navigator 等只读属性跳过）
for (const k of ['window', 'document', 'location', 'HTMLElement', 'Node', 'CustomEvent', 'Event', 'Blob', 'URL', 'localStorage', 'getComputedStyle']) {
  if (k === 'window') { globalThis.window = window; continue; }
  try { globalThis[k] = window[k]; } catch { /* ignore readonly */ }
}
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }); } catch { /* ignore */ }
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.WebSocket = window.WebSocket;
globalThis.ResizeObserver = window.ResizeObserver;

// 记录真实登录 cookie，注入 fetch
let cookie = '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' && input.startsWith('/') ? BASE + input : input;
  const headers = { ...(init.headers || {}) };
  if (cookie && String(url).includes('/api/')) headers.cookie = cookie;
  const res = await realFetch(url, { ...init, headers });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return res;
};

const results = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    (v) => { results.push({ name, ok: true, info: v || '' }); console.log('✓', name, v ? '— ' + v : ''); },
    (e) => { results.push({ name, ok: false, info: e.message }); console.log('✗', name, '—', e.stack?.split('\n').slice(0, 4).join('\n')); },
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const login = await realFetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS }),
  });
  if (!login.ok) throw new Error('登录失败');
  cookie = login.headers.get('set-cookie').split(';')[0];

  const { api } = await import('../web/js/api.js');
  const { store } = await import('../web/js/store.js');

  await check('加载概览数据', async () => {
    const [ov, rigs] = await Promise.all([api.overview(), api.rigs()]);
    store.set({ overview: ov, price: ov.price, net: ov.net, alerts: (await api.alerts()).alerts, loading: false });
    store.setRigs(rigs.rigs);
    if (!rigs.rigs.length) throw new Error('没有矿机数据');
    return `${rigs.rigs.length} 台矿机, ${ov.coins.length} 个币种`;
  });

  await check('总览页渲染', async () => {
    const { DashboardPage } = await import('../web/js/pages/dashboard.js');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const cleanup = DashboardPage(root, {});
    await sleep(900);
    const cards = root.querySelectorAll('.rig-card').length;
    const stats = root.querySelectorAll('.stat').length;
    if (!cards) throw new Error('未渲染矿机卡片');
    if (!stats) throw new Error('未渲染统计卡');
    const txt = root.textContent;
    if (!txt.includes('矿机在线')) throw new Error('缺少统计标题');
    cleanup?.();
    root.remove();
    return `${cards} 张矿机卡, ${stats} 个统计`;
  });

  await check('矿机详情页渲染', async () => {
    const { RigPage } = await import('../web/js/pages/rig.js');
    const rig = store.get().rigs.find((r) => r.online && (r.live?.gpus?.length || 0) > 0) || store.get().rigs[0];
    const root = document.createElement('div');
    document.body.appendChild(root);
    const cleanup = RigPage(root, { params: [rig.id] });
    await sleep(1500);
    const text = root.textContent;
    if (!text.includes(rig.name)) throw new Error('缺少矿机名称');
    if (!text.includes('看门狗')) throw new Error('缺少看门狗面板');
    const gpuCards = [...root.querySelectorAll('.card')].filter((c) => /^GPU \d/.test(c.textContent.trim())).length;
    cleanup?.();
    root.remove();
    return `${gpuCards} 个 GPU 卡（${rig.name}）`;
  });

  await check('飞行表页渲染', async () => {
    const { FlightSheetsPage } = await import('../web/js/pages/flight-sheets.js');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const cleanup = FlightSheetsPage(root, {});
    await sleep(1000);
    const text = root.textContent;
    if (!text.includes('飞行表')) throw new Error('缺少标题');
    if (!text.includes('矿池')) throw new Error('缺少矿池信息');
    cleanup?.();
    root.remove();
    const n = (text.match(/矿工：/g) || []).length;
    return `${n} 个飞行表`;
  });

  await check('飞行表编辑器渲染', async () => {
    const { FlightSheetsPage } = await import('../web/js/pages/flight-sheets.js');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const cleanup = FlightSheetsPage(root, {});
    await sleep(800);
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent.includes('新建'));
    btn?.click();
    await sleep(500);
    const text = root.textContent;
    if (!text.includes('创建飞行表')) throw new Error('编辑器未打开');
    if (!text.includes('看门狗')) throw new Error('缺少看门狗设置');
    if (!text.includes('命令预览')) throw new Error('缺少命令预览');
    cleanup?.();
    root.remove();
  });

  await check('告警页渲染', async () => {
    const { AlertsPage } = await import('../web/js/pages/alerts.js');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const cleanup = AlertsPage(root, {});
    await sleep(900);
    const text = root.textContent;
    if (!text.includes('告警规则')) throw new Error('缺少规则区');
    if (!text.includes('新建规则')) throw new Error('缺少新建按钮');
    cleanup?.();
    root.remove();
  });

  await check('创建告警规则', async () => {
    const { api } = await import('../web/js/api.js');
    await api.saveRule({
      name: '测试：GPU 温度 > 85°C', metric: 'temp', target: 'fleet',
      comparator: '>', threshold: 85, durationSec: 30, enabled: true, channels: ['inapp'],
    });
    const data = await api.alerts();
    const rule = data.rules.find((r) => r.name.startsWith('测试：GPU 温度'));
    if (!rule) throw new Error('规则未创建');
    await api.deleteRule(rule.id);
    return '规则创建/删除正常';
  });

  await check('事件页渲染', async () => {
    const { EventsPage } = await import('../web/js/pages/events.js');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const cleanup = EventsPage(root, {});
    await sleep(900);
    const rows = root.querySelectorAll('tbody tr').length;
    cleanup?.();
    root.remove();
    if (!rows) throw new Error('没有事件行');
    return `${rows} 条事件`;
  });

  await check('设置页渲染', async () => {
    const { SettingsPage } = await import('../web/js/pages/settings.js');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const cleanup = SettingsPage(root, {});
    await sleep(900);
    const text = root.textContent;
    if (!text.includes('基础设置')) throw new Error('缺少基础设置');
    if (!text.includes('Telegram')) throw new Error('缺少通知设置');
    cleanup?.();
    root.remove();
  });

  await check('MinerOS 系统镜像页渲染', async () => {
    const { OsPage } = await import('../web/js/pages/os.js');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const cleanup = OsPage(root, {});
    await sleep(1000);
    const text = root.textContent;
    if (!text.includes('MinerOS')) throw new Error('缺少标题');
    if (!text.includes('rig.conf')) throw new Error('缺少 rig.conf 入口');
    if (!text.includes('flash-usb')) throw new Error('缺少烧录说明');
    const links = root.querySelectorAll('a[href="/api/os/agent.tar.gz"]').length;
    if (!links) throw new Error('缺少离线采集端下载');
    cleanup?.();
    root.remove();
  });

  await check('在线升级中心页渲染', async () => {
    const { UpdatesPage } = await import('../web/js/pages/updates.js');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const cleanup = UpdatesPage(root, {});
    await sleep(1000);
    const text = root.textContent;
    if (!text.includes('在线升级中心')) throw new Error('缺少标题');
    if (!text.includes('升级包')) throw new Error('缺少升级包标签页');
    if (!text.includes('矿机版本')) throw new Error('缺少矿机版本标签页');
    if (!text.includes('采集端')) throw new Error('缺少采集端统计');
    cleanup?.();
    root.remove();
  });

  await check('币种管理页渲染', async () => {
    const { CoinsPage } = await import('../web/js/pages/coins.js');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const cleanup = CoinsPage(root, {});
    await sleep(900);
    const text = root.textContent;
    if (!text.includes('币种管理')) throw new Error('缺少标题');
    if (!text.includes('XMR')) throw new Error('缺少内置币种 XMR');
    if (!text.includes('PearlHash') && !text.includes('PRL')) throw new Error('缺少 Pearl 币种');
    if (!text.includes('矿工支持矩阵')) throw new Error('缺少矿工支持矩阵');
    cleanup?.();
    root.remove();
  });

  await check('新增自定义币种接口', async () => {
    const { api } = await import('../web/js/api.js');
    const symbol = 'T' + String(Date.now()).slice(-4);
    const created = await api.addCoin({ symbol, name: '测试币', algo: 'testAlgo', unit: 'MH/s' });
    if (!created.coin || created.coin.symbol !== symbol) throw new Error('新增失败');
    const list = await api.coins();
    if (!list.coins.some((c) => c.symbol === symbol && !c.builtin)) throw new Error('列表未包含新币种');
    await api.deleteCoin(symbol);
    const after = await api.coins();
    if (after.coins.some((c) => c.symbol === symbol)) throw new Error('删除失败');
    return symbol;
  });

  await check('OS 接口（manifest / rig.conf / tar.gz）', async () => {
    const { api } = await import('../web/js/api.js');
    const os = await api.os();
    if (!os.rigs) throw new Error('缺少矿机列表');
    const rig = os.rigs[0];
    const conf = await (await fetch(`/api/os/rig-conf/${rig.id}`)).text();
    if (!conf.includes('SERVER_URL=')) throw new Error('rig.conf 缺少 SERVER_URL');
    if (!conf.includes('RIG_NAME=')) throw new Error('rig.conf 缺少 RIG_NAME');
    const tar = await fetch('/api/os/agent.tar.gz');
    if (!tar.ok) throw new Error(`tar.gz HTTP ${tar.status}`);
    const buf = Buffer.from(await tar.arrayBuffer());
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) throw new Error('不是 gzip 流');
    return `${os.rigs.length} 台矿机, tar.gz ${(buf.length / 1024).toFixed(1)} KB`;
  });

  await check('图表组件绘制', async () => {
    const { LineChart } = await import('../web/js/chart.js');
    const holder = document.createElement('div');
    Object.defineProperty(holder, 'clientWidth', { value: 600 });
    document.body.appendChild(holder);
    const chart = new LineChart(holder, {
      height: 200,
      series: [{ key: 'h', label: '算力', color: '#fff' }],
      points: Array.from({ length: 50 }, (_, i) => ({ ts: Date.now() - i * 60000, h: 1000 + i })),
    });
    if (!holder.querySelector('canvas')) throw new Error('未创建 canvas');
    chart.destroy();
    holder.remove();
  });

  await check('实时数据合并', async () => {
    const before = store.get().rigs[0];
    store.upsertRig({ ...before, total_hashrate: 12345 });
    const after = store.get().rigMap.get(before.id);
    if (after.total_hashrate !== 12345) throw new Error('upsert 未生效');
    const stats = store.fleetStats();
    if (!stats.total) throw new Error('fleetStats 异常');
    return `${stats.total} 台 / 在线 ${stats.online}`;
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) {
    for (const f of failed) console.log('  -', f.name, ':', f.info);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('❌ 测试失败:', e.stack || e.message); process.exit(1); });
