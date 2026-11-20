// 应用外壳：登录、路由、侧边栏、全局数据加载
import { h, clear, fmtTime } from './dom.js';
import { api } from './api.js';
import { store } from './store.js';
import { realtime, toast } from './realtime.js';
import { LoginPage } from './pages/login.js';
import { DashboardPage } from './pages/dashboard.js';
import { RigPage } from './pages/rig.js';
import { FlightSheetsPage } from './pages/flight-sheets.js';
import { AlertsPage } from './pages/alerts.js';
import { EventsPage } from './pages/events.js';
import { SettingsPage } from './pages/settings.js';
import { OsPage } from './pages/os.js';
import { UpdatesPage } from './pages/updates.js';
import { CoinsPage } from './pages/coins.js';

const NAV = [
  { group: '监控', items: [
    { path: '/', label: '总览', icon: '◈' },
    { path: '/rigs', label: '矿机', icon: '▦' },
    { path: '/alerts', label: '告警', icon: '⚑' },
    { path: '/events', label: '事件日志', icon: '≡' },
  ] },
  { group: '配置', items: [
    { path: '/flight-sheets', label: '飞行表', icon: '✈' },
    { path: '/coins', label: '币种', icon: '◎' },
    { path: '/updates', label: '在线升级', icon: '⬆' },
    { path: '/os', label: '系统镜像', icon: '💿' },
    { path: '/settings', label: '设置', icon: '⚙' },
  ] },
];

const app = document.getElementById('app');
let currentCleanup = null;
let shellEls = null;
let refreshTimer = null;

// ───────── 认证 ─────────
async function ensureAuth() {
  try {
    const { user } = await api.me();
    store.set({ user });
    return true;
  } catch {
    return false;
  }
}

function showLogin() {
  app.innerHTML = '';
  currentCleanup?.();
  currentCleanup = LoginPage(app, {
    onSuccess: async (user) => {
      store.set({ user });
      await boot();
    },
  });
}

window.addEventListener('auth:expired', () => {
  if (!store.get().user) return;
  store.set({ user: null });
  toast('登录已过期，请重新登录', 'warn');
  showLogin();
});

// ───────── 外壳 ─────────
function renderShell() {
  app.innerHTML = '';
  const s = store.get();
  const nav = h('nav', { class: 'sidebar' });
  const brand = h('div', { class: 'brand' },
    h('div', { class: 'brand-logo' }, '⛏'),
    h('div', {},
      h('div', { class: 'brand-name', id: 'brandName' }, '矿机监控中心'),
      h('div', { class: 'brand-sub' }, 'Miner Monitor'),
    ),
  );
  nav.appendChild(brand);
  for (const g of NAV) {
    nav.appendChild(h('div', { class: 'nav-group-label' }, g.group));
    for (const it of g.items) {
      const a = h('a', { class: 'nav-item', href: `#${it.path}`, dataset: { path: it.path } },
        h('span', { class: 'ico' }, it.icon),
        h('span', {}, it.label),
        it.path === '/alerts' ? h('span', { class: 'badge badge-danger', id: 'navAlertBadge', style: { display: 'none' } }, '0') : null,
      );
      nav.appendChild(a);
    }
  }
  const agentCount = s.rigs.length;
  nav.appendChild(h('div', { class: 'sidebar-footer' },
    h('div', {}, h('span', { class: 'dot', id: 'wsDot' }), h('span', { id: 'wsText' }, '实时连接')),
    h('div', { style: { marginTop: '6px' }, id: 'sidebarCount' }, `${agentCount} 台矿机 · v1.0.0`),
  ));

  const topbar = h('div', { class: 'topbar' },
    h('h1', { id: 'pageTitle' }, '总览'),
    h('div', { class: 'sub', id: 'pageSub' }, ''),
    h('div', { class: 'spacer' }),
    h('div', { class: 'flex', style: { gap: '10px' } },
      h('span', { class: 'badge badge-muted', id: 'clock' }, '—'),
      h('button', { class: 'icon-btn', title: '刷新', id: 'refreshBtn' }, '↻'),
      h('button', { class: 'icon-btn', title: '退出登录', id: 'logoutBtn' }, '⏻'),
    ),
  );
  const main = h('div', { class: 'main' }, topbar, h('div', { class: 'page', id: 'page' }));
  const layout = h('div', { class: 'layout' }, nav, main);
  app.appendChild(layout);
  shellEls = { nav, main, page: main.querySelector('#page'), topbar };

  main.querySelector('#refreshBtn').addEventListener('click', () => refreshAll(true));
  main.querySelector('#logoutBtn').addEventListener('click', async () => {
    try { await api.logout(); } catch { /* ignore */ }
    store.set({ user: null });
    showLogin();
  });
  window.addEventListener('hashchange', route);
  setInterval(() => {
    const el = document.getElementById('clock');
    if (el) el.textContent = fmtTime(Date.now(), false);
  }, 1000);
  updateChrome();
}

function updateChrome() {
  if (!shellEls) return;
  const s = store.get();
  const path = location.hash.slice(1) || '/';
  for (const a of shellEls.nav.querySelectorAll('.nav-item')) {
    const p = a.dataset.path;
    a.classList.toggle('active', p === '/' ? path === '/' : path.startsWith(p) || (p === '/flight-sheets' && path.startsWith('/flight')));
  }  const wsDot = document.getElementById('wsDot');
  const wsText = document.getElementById('wsText');
  if (wsDot) {
    wsDot.className = 'dot ' + (s.realtime ? 'online' : 'offline');
    wsText.textContent = s.realtime ? '实时连接' : '轮询模式';
  }
  const badge = document.getElementById('navAlertBadge');
  if (badge) {
    const n = s.overview?.alerts?.filter((a) => a.state === 'firing').length || 0;
    badge.textContent = String(n);
    badge.style.display = n ? '' : 'none';
  }
  const name = s.settingsName || s.overview?.settings?.siteName;
  const brand = document.getElementById('brandName');
  if (brand && name) brand.textContent = name;
  const countEl = document.getElementById('sidebarCount');
  if (countEl) {
    const total = s.rigs?.length || s.overview?.fleet?.rigs || 0;
    const online = s.rigs?.filter((r) => r.online).length ?? s.overview?.fleet?.online ?? 0;
    countEl.textContent = `${total} 台矿机 · ${online} 在线`;
  }
}

// ───────── 数据加载 ─────────
async function refreshAll(showToast = false) {
  try {
    const [ov, rigsRes, alertsRes] = await Promise.all([api.overview(), api.rigs(), api.alerts()]);
    store.set({
      overview: ov,
      price: ov.price || {},
      net: ov.net || {},
      alerts: alertsRes.alerts || [],
      loading: false,
    });
    store.setRigs(rigsRes.rigs);
    updateChrome();
    if (showToast) toast('数据已刷新', 'ok', 1500);
  } catch (e) {
    if (e.status !== 401) toast(`加载数据失败: ${e.message}`, 'err');
  }
}

// ───────── 路由 ─────────
const ROUTES = [
  { pattern: /^\/$/, title: '总览', page: DashboardPage },
  { pattern: /^\/rigs$/, title: '矿机', page: DashboardPage, props: { listMode: true } },
  { pattern: /^\/rig\/([^/]+)$/, title: '矿机详情', page: RigPage },
  { pattern: /^\/flight-sheets$/, title: '飞行表', page: FlightSheetsPage },
  { pattern: /^\/os$/, title: 'MinerOS 系统镜像', page: OsPage },
  { pattern: /^\/updates$/, title: '在线升级中心', page: UpdatesPage },
  { pattern: /^\/coins$/, title: '币种管理', page: CoinsPage },
  { pattern: /^\/alerts$/, title: '告警', page: AlertsPage },
  { pattern: /^\/events$/, title: '事件日志', page: EventsPage },
  { pattern: /^\/settings$/, title: '设置', page: SettingsPage },
];

async function route() {
  if (!store.get().user) return;
  const path = location.hash.slice(1) || '/';
  const match = ROUTES.map((r) => ({ r, m: r.pattern.exec(path) })).find((x) => x.m);
  const page = shellEls?.page;
  if (!page) return;
  currentCleanup?.();
  currentCleanup = null;
  clear(page);
  if (!match) {
    page.appendChild(h('div', { class: 'empty' }, h('div', { class: 'big' }, '404'), h('h3', {}, '页面不存在'), h('p', {}, '请从左侧菜单进入。')));
    return;
  }
  const { r, m } = match;
  const props = { params: m.slice(1), ...(r.props || {}) };
  document.getElementById('pageTitle').textContent = r.title;
  document.getElementById('pageSub').textContent = r.props?.listMode ? '全部矿机列表' : '';
  try {
    currentCleanup = await r.page(page, props) || null;
  } catch (e) {
    page.appendChild(h('div', { class: 'empty' }, h('div', { class: 'big' }, '⚠'), h('h3', {}, '页面加载失败'), h('p', {}, e.message)));
  }
  updateChrome();
}

// ───────── 启动 ─────────
async function boot() {
  renderShell();
  await refreshAll();
  realtime.start();
  realtime.startFallbackPolling(15_000);
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => refreshAll(false), 60_000);
  store.subscribe(() => {
    updateChrome();
    const s = store.get();
    const badge = document.getElementById('navAlertBadge');
    if (badge) {
      const n = s.alerts.filter((a) => a.state === 'firing').length;
      badge.textContent = String(n);
      badge.style.display = n ? '' : 'none';
    }
  });
  realtime.on('rig', (rig) => {
    // 详情页自己订阅；总览页重绘由各页面自行订阅 store
    if (location.hash.includes('/rig/')) return;
  });
  realtime.on('alert', (a) => {
    toast(`⚠ ${a.message}`, 'warn', 6000);
  });
  realtime.on('command', (c) => {
    toast(c.status === 'ok' ? `命令执行成功` : `命令执行失败: ${c.output || ''}`, c.status === 'ok' ? 'ok' : 'err', 4000);
  });
  window.addEventListener('hashchange', () => {});
  await route();
}

(async () => {
  const ok = await ensureAuth();
  if (!ok) return showLogin();
  await boot();
})();

export { refreshAll, route };
