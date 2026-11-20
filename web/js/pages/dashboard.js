// 总览 / 矿机列表页
import {
  h, clear, fmtHash, fmtPower, fmtTemp, tempClass, fmtAgo, fmtNum, fmtMoney, statusBadge, coinTag, debounce,
} from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { realtime, toast } from '../realtime.js';
import { LineChart } from '../chart.js';
import { openModal, confirmDialog, formDialog, pageHeader } from '../components.js';

export function DashboardPage(root, props = {}) {
  const listMode = !!props.listMode;
  let chart = null;
  let chartHours = 24;
  let groupFilter = '全部';
  let coinFilter = '全部';
  let search = '';
  let renderQueued = false;
  const unsub = [];

  // 稳定的容器：一次创建，局部刷新
  const statsEl = h('div');
  const chartEl = h('div', { class: 'card mb-20' });
  const sectionEl = h('div');
  const filterEl = h('div');
  const gridEl = h('div');
  const alertEl = h('div');
  const listEl = h('div');
  const rootEl = h('div', {}, statsEl, listMode ? null : chartEl, sectionEl, filterEl, listMode ? listEl : gridEl, listMode ? null : alertEl);
  root.appendChild(rootEl);

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    const s = store.get();
    if (s.loading && !s.rigs.length) {
      clear(gridEl);
      gridEl.appendChild(h('div', { class: 'skeleton', style: { height: '120px' } }));
      return;
    }
    if (listMode) {
      clear(listEl);
      listEl.appendChild(pageHeader('矿机', `共 ${s.rigs.length} 台`, [
        h('button', { class: 'btn btn-primary', onclick: createRigDialog }, '＋ 添加矿机'),
        h('button', { class: 'btn', onclick: () => fleetCommand('sync_config') }, '⟳ 全部同步配置'),
      ]));
      listEl.appendChild(filterBar());
      listEl.appendChild(rigList());
      return;
    }
    clear(statsEl);
    statsEl.appendChild(statsStrip());
    if (!chart) renderChart();
    clear(sectionEl);
    sectionEl.appendChild(sectionHeader());
    clear(filterEl);
    filterEl.appendChild(filterBar());
    clear(gridEl);
    gridEl.appendChild(rigGrid());
    clear(alertEl);
    const firing = s.alerts.filter((a) => a.state === 'firing');
    if (firing.length) alertEl.appendChild(alertPanel(firing));
  }

  // ───────── 顶部统计 ─────────
  function statsStrip() {
    const s = store.get();
    const f = store.fleetStats();
    const ov = s.overview || {};
    const price = s.price || {};
    const coins = ov.coins || [];
    const xmr = f.byCoin.find((c) => c.coin === 'XMR');
    const prl = f.byCoin.find((c) => c.coin === 'PRL');
    const earning = coins.reduce((sum, c) => sum + (c.earnings?.profitDay || 0), 0);
    const revenue = coins.reduce((sum, c) => sum + (c.earnings?.revenueDay || 0), 0);
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(178px, 1fr))', gap: '14px', marginBottom: '18px' } },
      statCard('矿机在线', `${f.online}/${f.total}`, f.offline ? `${f.offline} 台离线` : '全部在线', f.offline ? 'down' : 'up'),
      statCard('总功耗', fmtNum(f.power, 0), 'W', f.online ? `${fmtNum(f.power / Math.max(1, f.online), 0)} W/台` : ''),
      statCard('算力 · 门罗', fmtHash(xmr.hashrate), `XMR · ${xmr.online} 台`, price.XMR?.usd ? `${fmtMoney(price.XMR.usd)}/XMR` : ''),
      statCard('算力 · Pearl', fmtHash(prl.hashrate), `PRL · ${prl.online} 台`, price.PRL?.usd ? `${fmtMoney(price.PRL.usd)}/PRL` : ''),
      statCard('日预估收益', fmtMoney(revenue), 'US$', `净利 ${fmtMoney(earning)}`),
      statCard('最高温度', f.tempMax ? `${Math.round(f.tempMax)}` : '—', '°C', f.tempMax >= 80 ? '注意散热' : '温度正常', f.tempMax >= 80 ? 'down' : ''),
    );
  }

  function statCard(label, value, unit, sub, cls = '') {
    return h('div', { class: 'card' },
      h('div', { class: 'stat' },
        h('span', { class: 'label' }, label),
        h('span', { class: 'value' }, String(value), unit ? h('span', { class: 'unit' }, unit) : null),
        sub ? h('span', { class: `delta ${cls}` }, sub) : null,
      ),
    );
  }

  // ───────── 机群曲线 ─────────
  async function renderChart() {
    clear(chartEl);
    const head = h('div', { class: 'card-title' },
      h('span', {}, '机群算力 / 功耗'),
      h('div', { class: 'spacer' }),
      ...[['1h', 1], ['6h', 6], ['24h', 24], ['7d', 168]].map(([label, hrs]) =>
        h('button', {
          class: `btn btn-sm ${chartHours === hrs ? 'btn-primary' : ''}`,
          onclick: () => { chartHours = hrs; chart?.destroy(); chart = null; renderChart(); },
        }, label)),
    );
    const holder = h('div', { class: 'mt-14' });
    chartEl.append(head, holder);
    try {
      const { series } = await api.fleetHistory(chartHours);
      chart = new LineChart(holder, {
        height: 230,
        series: [
          { key: 'hashrateXMR', label: 'XMR 算力', color: '#ff7a18', unit: ' H/s' },
          { key: 'hashratePRL', label: 'PRL 算力', color: '#2ee6c8', unit: ' H/s' },
          { key: 'power', label: '功耗', color: '#7c5cff', unit: ' W', yAxis: 1 },
        ],
        yAxes: 2,
        points: (series || []).map((p) => ({
          ts: p.ts,
          hashrateXMR: p.coins?.XMR ?? p.hashrate ?? 0,
          hashratePRL: p.coins?.PRL ?? 0,
          power: p.power ?? 0,
        })),
      });
    } catch {
      holder.appendChild(h('div', { class: 'dim', style: { padding: '30px 0', textAlign: 'center' } }, '历史数据暂不可用'));
    }
  }

  // ───────── 过滤 ─────────
  function filterBar() {
    const s = store.get();
    const groups = ['全部', ...new Set(s.rigs.map((r) => r.group_name).filter(Boolean))];
    const sel = h('select', { class: 'select', style: { width: 'auto', minWidth: '120px' }, onchange: (e) => { groupFilter = e.target.value; scheduleRender(); } },
      ...groups.map((g) => h('option', { value: g, selected: g === groupFilter }, g === '全部' ? '全部分组' : g)),
    );
    const coinSel = h('select', { class: 'select', style: { width: 'auto' }, onchange: (e) => { coinFilter = e.target.value; scheduleRender(); } },
      ...['全部', 'XMR', 'PRL'].map((c) => h('option', { value: c, selected: c === coinFilter }, c === '全部' ? '全部币种' : c)),
    );
    const input = h('input', {
      class: 'input', style: { width: '200px' }, placeholder: '搜索矿机名称 / IP…', value: search,
      oninput: debounce((e) => { search = e.target.value.trim(); scheduleRender(); }, 200),
    });
    return h('div', { class: 'card', style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px', marginBottom: '14px' } },
      sel, coinSel, input,
      h('div', { style: { flex: '1' } }),
      h('span', { class: 'dim', style: { fontSize: '12px' } }, `${filteredRigs().length} 台`),
    );
  }

  function filteredRigs() {
    return store.get().rigs.filter((r) => {
      if (groupFilter !== '全部' && r.group_name !== groupFilter) return false;
      if (coinFilter !== '全部' && r.coin !== coinFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!`${r.name} ${r.agent_ip} ${r.gpu_summary}`.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  function sectionHeader() {
    return h('div', { class: 'flex-between', style: { marginBottom: '10px' } },
      h('h3', { style: { margin: 0, fontSize: '15px' } }, '矿机'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-sm', onclick: () => fleetCommand('sync_config') }, '⟳ 同步配置'),
        h('button', { class: 'btn btn-sm', onclick: bulkGroup }, '分组调整'),
        h('button', { class: 'btn btn-primary btn-sm', onclick: createRigDialog }, '＋ 添加矿机'),
      ),
    );
  }

  // ───────── 矿机卡片 ─────────
  function rigGrid() {
    const rigs = filteredRigs().sort((a, b) => (a.online === b.online ? a.name.localeCompare(b.name) : a.online ? -1 : 1));
    if (!rigs.length) {
      const hasAny = store.get().rigs.length > 0;
      return h('div', { class: 'card' },
        h('div', { class: 'empty' },
          h('div', { class: 'big' }, '⛏'),
          h('h3', {}, hasAny ? '没有匹配的矿机' : '还没有矿机'),
          h('p', {}, hasAny ? '换个筛选条件试试。' : '点击「添加矿机」创建，或安装采集端后自动上线。'),
          hasAny ? null : h('button', { class: 'btn btn-primary', onclick: createRigDialog }, '＋ 添加矿机'),
        ),
      );
    }
    return h('div', { class: 'rig-grid' }, ...rigs.map(rigCard));
  }

  function rigCard(rig) {
    const live = rig.live;
    const gpus = live?.gpus || [];
    const online = rig.online;
    const hashStr = fmtHash(rig.total_hashrate || 0);
    const [hashVal, hashUnit] = hashStr.split(' ');
    const card = h('div', {
      class: `rig-card ${online ? '' : 'offline'} ${rig.maintenance ? 'maintenance' : ''}`,
      onclick: (e) => { if (e.target.closest('button')) return; location.hash = `#/rig/${rig.id}`; },
    });
    card.appendChild(h('div', { class: 'rig-head' },
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { class: 'rig-name' },
          h('span', { class: `dot ${online ? 'online pulse' : 'offline'}` }),
          h('span', { class: 'name-text', title: rig.name }, rig.name),
        ),
        h('div', { class: 'rig-meta' },
          coinTag(rig.coin),
          h('span', {}, rig.group_name || '默认分组'),
          rig.agent_ip ? h('span', { class: 'mono' }, rig.agent_ip) : null,
          online ? h('span', {}, fmtAgo(rig.last_seen)) : h('span', { style: { color: 'var(--danger)' } }, '离线 ' + fmtAgo(rig.last_seen)),
        ),
      ),
      statusBadge(rig),
    ));
    card.appendChild(h('div', { class: 'rig-hash' },
      h('span', { class: 'big' }, hashVal),
      h('span', { class: 'unit' }, hashUnit || 'H/s'),
      h('span', { class: 'coin' }, coinTag(rig.coin)),
    ));
    if (gpus.length) {
      card.appendChild(h('div', { class: 'mini-gpus' }, ...gpus.slice(0, 4).map((g) => h('div', { class: 'mini-gpu' },
        h('span', { class: 'gname' }, `${g.index} · ${g.name}`),
        h('div', { class: 'gstats' },
          h('span', {}, '⛏ ', h('b', {}, fmtHash(g.hashrate || 0).replace(/ H\/s$/, ''))),
          h('span', { class: tempClass(g.temp) }, '🌡 ', h('b', {}, g.temp != null ? Math.round(g.temp) + '°' : '—')),
          h('span', {}, '⚡ ', h('b', {}, g.power != null ? Math.round(g.power) + 'W' : '—')),
        ),
      ))));
    } else if (!online) {
      card.appendChild(h('div', { class: 'dim', style: { fontSize: '12px', padding: '8px 0' } }, '等待采集端上线…'));
    }
    const accepted = Number(rig.accepted) || 0;
    const rejected = Number(rig.rejected) || 0;
    const totalShares = accepted + rejected;
    const rejPct = totalShares > 0 ? (rejected / totalShares) * 100 : 0;
    card.appendChild(h('div', { class: 'rig-foot' },
      h('span', {}, '⚡ ' + fmtPower(rig.power_w)),
      h('span', { class: tempClass(rig.temp_max) }, '🌡 ' + fmtTemp(rig.temp_max)),
      h('span', { title: '接受/拒绝份额' }, `✓ ${accepted}`, rejPct > 1 ? h('span', { style: { color: 'var(--danger)' } }, ` / ✗ ${rejected}`) : null),
      h('div', { class: 'spacer' }),
      h('div', { class: 'rig-actions' },
        h('button', { class: 'icon-btn', title: '重启矿工', onclick: () => command(rig, 'restart') }, '↻'),
        h('button', {
          class: 'icon-btn',
          title: rig.miner_state === 'running' ? '停止矿工' : '启动矿工',
          onclick: () => command(rig, rig.miner_state === 'running' ? 'stop' : 'start'),
        }, rig.miner_state === 'running' ? '■' : '▶'),
        h('button', { class: 'icon-btn', title: '详情', onclick: () => { location.hash = `#/rig/${rig.id}`; } }, '›'),
      ),
    ));
    return card;
  }

  // ───────── 列表模式 ─────────
  function rigList() {
    const rigs = filteredRigs();
    if (!rigs.length) return h('div', { class: 'card' }, h('div', { class: 'empty' }, h('div', { class: 'big' }, '⛏'), h('h3', {}, '没有矿机'), h('p', {}, '添加矿机或安装采集端。')));
    const table = h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        h('th', {}, '矿机'), h('th', {}, '分组'), h('th', {}, '币种'), h('th', { class: 'num' }, '算力'),
        h('th', { class: 'num' }, 'GPU'), h('th', { class: 'num' }, '温度'), h('th', { class: 'num' }, '功耗'),
        h('th', {}, '矿工'), h('th', {}, '状态'), h('th', {}, '最后心跳'), h('th', {}, ''),
      )),
      h('tbody', {}, ...rigs.map((r) => h('tr', {},
        h('td', {}, h('a', { href: `#/rig/${r.id}`, style: { fontWeight: '600' } }, r.name)),
        h('td', { class: 'dim' }, r.group_name),
        h('td', {}, coinTag(r.coin)),
        h('td', { class: 'num' }, fmtHash(r.total_hashrate || 0)),
        h('td', { class: 'num' }, r.gpu_count || '—'),
        h('td', { class: `num ${tempClass(r.temp_max)}` }, r.temp_max != null ? Math.round(r.temp_max) + '°C' : '—'),
        h('td', { class: 'num' }, fmtPower(r.power_w)),
        h('td', { class: 'dim' }, r.miner_name || '—'),
        h('td', {}, statusBadge(r)),
        h('td', { class: 'dim nowrap' }, fmtAgo(r.last_seen)),
        h('td', {}, h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-sm', onclick: () => command(r, 'restart') }, '重启'),
          h('button', { class: 'btn btn-sm', onclick: () => { location.hash = `#/rig/${r.id}`; } }, '详情'),
        )),
      ))),
    );
    return h('div', { class: 'card pad-0', style: { overflow: 'auto' } }, table);
  }

  function alertPanel(firing) {
    return h('div', { class: 'card', style: { marginTop: '18px', borderColor: 'rgba(255,77,103,.3)' } },
      h('div', { class: 'card-title' }, h('span', {}, '⚑ 进行中的告警'), h('div', { class: 'spacer' }), h('a', { href: '#/alerts', style: { fontSize: '12px' } }, '查看全部')),
      h('div', { class: 'mt-8' }, ...firing.slice(0, 8).map((a) => h('div', { class: 'flex', style: { padding: '6px 0', borderBottom: '1px solid var(--border)' } },
        h('span', { class: 'dot offline' }),
        h('span', { style: { flex: '1' } }, a.message),
        h('span', { class: 'dim mono', style: { fontSize: '11px' } }, fmtAgo(a.created_at)),
      ))),
    );
  }

  // ───────── 操作 ─────────
  async function command(rig, type) {
    try {
      const res = await api.command(rig.id, type);
      toast(`命令已发送：${typeLabel(type)}${res.status === 'queued' ? '（矿机离线，排队中）' : ''}`, 'ok', 2500);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function fleetCommand(type) {
    const total = store.get().rigs.length;
    const ok = await confirmDialog({
      title: '批量命令',
      message: `确定对全部 ${total} 台矿机执行「${typeLabel(type)}」吗？`,
      okText: '执行',
      danger: type === 'reboot' || type === 'stop',
    });
    if (!ok) return;
    try {
      const r = await api.fleetCommand(type);
      toast(`已发送 ${r.sent} 台`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function bulkGroup() {
    const s = store.get();
    const values = await formDialog({
      title: '批量修改分组',
      fields: [
        { name: 'group', label: '目标分组', value: s.groups[0] || '默认分组', hint: '全部矿机将被移动到该分组' },
      ],
      okText: '应用',
      onSubmit: async () => {},
    });
    if (!values?.group) return;
    try {
      await api.bulk(s.rigs.map((r) => r.id), 'patch', { group: values.group });
      toast('分组已更新', 'ok');
      const { rigs } = await api.rigs();
      store.setRigs(rigs);
    } catch (e) { toast(e.message, 'err'); }
  }

  async function createRigDialog() {
    const sheets = await api.flightSheets().catch(() => ({ flightSheets: [] }));
    await formDialog({
      title: '添加矿机',
      fields: [
        { name: 'name', label: '矿机名称', required: true, placeholder: '例如：机房A-01' },
        { name: 'group', label: '分组', value: '默认分组' },
        { name: 'coin', label: '币种', type: 'select', value: 'XMR', options: [{ value: 'XMR', label: 'Monero (XMR)' }, { value: 'PRL', label: 'Pearl (PRL)' }] },
        { name: 'sheet', label: '飞行表（可选）', type: 'select', value: '', options: [{ value: '', label: '暂不分配' }, ...sheets.flightSheets.map((f) => ({ value: f.id, label: `${f.name} (${f.coin})` }))] },
        { name: 'note', label: '备注', type: 'textarea', rows: 2, placeholder: '可选' },
      ],
      onSubmit: async (v) => {
        if (!v.name.trim()) throw new Error('请输入矿机名称');
        const r = await api.createRig({ name: v.name.trim(), group: v.group, coin: v.coin, note: v.note, flightSheetId: v.sheet || null });
        const { rigs } = await api.rigs();
        store.setRigs(rigs);
        toast('矿机已创建，正在生成安装脚本…', 'ok');
        openInstall(r.rig.id);
      },
    });
  }

  unsub.push(store.subscribe(scheduleRender));
  unsub.push(realtime.on('rig', () => { if (!listMode) scheduleRender(); }));
  render();
  return () => { unsub.forEach((f) => f()); chart?.destroy(); };
}

function typeLabel(t) {
  return { start: '启动矿工', stop: '停止矿工', restart: '重启矿工', reboot: '重启矿机', shutdown: '关机', sync_config: '同步配置', update_agent: '更新采集端', apply_oc: '应用超频' }[t] || t;
}

async function openInstall(rigId) {
  let script = '';
  try { script = await (await fetch(`/api/rigs/${rigId}/install`)).text(); } catch { /* ignore */ }
  const modal = openModal({
    title: '安装采集端',
    wide: true,
    body: h('div', {},
      h('p', { style: { marginTop: 0 } }, '在矿机上用管理员 PowerShell 执行以下脚本；采集端会自动注册并上报（约 10 秒后上线）：'),
      h('div', { class: 'logview', style: { maxHeight: '260px' } }, script.slice(0, 6000)),
      h('p', { class: 'dim', style: { marginBottom: 0 } }, '也可以下载 .ps1 文件执行，或直接运行 node agent/agent.js（需要 Node 22+）。'),
    ),
    footer: h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => { navigator.clipboard?.writeText(script); toast('已复制', 'ok'); } }, '复制脚本'),
      h('button', { class: 'btn btn-primary', onclick: () => modal.close() }, '知道了'),
    ),
  });
}
