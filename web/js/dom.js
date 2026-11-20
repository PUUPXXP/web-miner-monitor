// DOM 辅助工具：轻量元素构建 / 转义 / 格式化
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

export function fmtHash(v, unit = 'H/s') {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '0 ' + unit;
  const steps = [['P', 1e15], ['T', 1e12], ['G', 1e9], ['M', 1e6], ['k', 1e3]];
  for (const [p, base] of steps) {
    if (n >= base) {
      const x = n / base;
      return `${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)} ${p}${unit}`;
    }
  }
  return `${n.toFixed(n < 10 ? 2 : 0)} ${unit}`;
}

export function fmtNum(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtMoney(v, cur = 'US$') {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${cur}${n.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

export function fmtPower(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `${Math.round(n)} W` : '—';
}

export function fmtTemp(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n)}°C` : '—';
}

export function tempClass(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'dim';
  if (n >= 84) return 't-crit';
  if (n >= 76) return 't-hot';
  if (n >= 68) return 't-warm';
  if (n >= 45) return 't-ok';
  return 't-cool';
}

export function fmtAgo(ts) {
  const t = Number(ts);
  if (!t) return '从未';
  const d = Math.max(0, Date.now() - t);
  if (d < 2000) return '刚刚';
  if (d < 60_000) return `${Math.round(d / 1000)} 秒前`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} 小时前`;
  return `${Math.round(d / 86_400_000)} 天前`;
}

export function fmtTime(ts, withDate = true) {
  const t = Number(ts);
  if (!t) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return withDate ? `${d.getMonth() + 1}/${d.getDate()} ${time}` : time;
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天${hh}小时`;
  if (hh > 0) return `${hh}小时${mm}分`;
  if (mm > 0) return `${mm}分${s % 60}秒`;
  return `${s}秒`;
}

export function coinTag(coin) {
  return h('span', { class: `badge ${coin === 'PRL' ? 'badge-accent' : 'badge-warn'}`, text: coin === 'PRL' ? 'PRL' : 'XMR' });
}

export function statusBadge(rig) {
  if (rig.maintenance) return h('span', { class: 'badge badge-warn' }, '维护中');
  if (!rig.online) return h('span', { class: 'badge badge-danger' }, '离线');
  if (rig.miner_state === 'running') return h('span', { class: 'badge badge-ok' }, '挖矿中');
  if (rig.miner_state === 'starting') return h('span', { class: 'badge badge-info' }, '启动中');
  if (rig.miner_state === 'error') return h('span', { class: 'badge badge-danger' }, '矿工错误');
  return h('span', { class: 'badge badge-muted' }, '未挖矿');
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
