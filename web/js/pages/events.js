// 事件日志
import { h, clear, fmtTime } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { realtime } from '../realtime.js';
import { pageHeader } from '../components.js';

export function EventsPage(root) {
  const el = h('div');
  root.appendChild(el);
  let level = '';
  let category = '';
  let rigId = '';
  const CATEGORIES = [['', '全部类型'], ['rig', '矿机'], ['agent', '采集端'], ['command', '命令'], ['alert', '告警'], ['config', '配置'], ['auth', '认证'], ['system', '系统']];
  const LEVELS = [['', '全部级别'], ['info', '信息'], ['warn', '警告'], ['error', '错误']];

  async function load() {
    clear(el);
    const rigOpts = [['', '全部矿机'], ...store.get().rigs.map((r) => [r.id, r.name])];
    el.appendChild(pageHeader('事件日志', '系统、采集端、命令与告警的完整记录', [
      h('button', { class: 'btn', onclick: load }, '↻ 刷新'),
    ]));
    el.appendChild(h('div', { class: 'card', style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', marginBottom: '14px' } },
      selectField(LEVELS, level, (v) => { level = v; load(); }),
      selectField(CATEGORIES, category, (v) => { category = v; load(); }),
      selectField(rigOpts, rigId, (v) => { rigId = v; load(); }),
      h('div', { style: { flex: '1' } }),
      h('span', { class: 'dim', style: { fontSize: '12px' } }, '仅保留最近 30 天'),
    ));
    const card = h('div', { class: 'card pad-0' });
    el.appendChild(card);
    try {
      const { events } = await api.events({ limit: 300, level, category, rigId });
      if (!events.length) {
        card.appendChild(h('div', { class: 'empty' }, h('p', {}, '没有事件记录')));
        return;
      }
      card.appendChild(h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', { style: { width: '150px' } }, '时间'), h('th', { style: { width: '90px' } }, '级别'), h('th', { style: { width: '110px' } }, '类型'), h('th', { style: { width: '160px' } }, '矿机'), h('th', {}, '内容'))),
        h('tbody', {}, ...events.map((e) => h('tr', {},
          h('td', { class: 'mono dim', style: { fontSize: '11.5px' } }, fmtTime(e.ts)),
          h('td', {}, levelBadge(e.level)),
          h('td', { class: 'dim' }, categoryLabel(e.category)),
          h('td', {}, e.rig_name || '—'),
          h('td', {}, e.message),
        ))),
      ));
    } catch (err) {
      card.appendChild(h('div', { class: 'empty' }, h('p', {}, `加载失败：${err.message}`)));
    }
  }

  const unsub = realtime.on('event', () => { /* 实时事件不打断浏览，刷新按钮可更新 */ });
  load();
  return () => unsub();
}

function selectField(opts, value, onChange) {
  return h('select', { class: 'select', style: { width: 'auto' }, onchange: (e) => onChange(e.target.value) },
    ...opts.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}
function levelBadge(level) {
  if (level === 'error') return h('span', { class: 'badge badge-danger' }, '错误');
  if (level === 'warn') return h('span', { class: 'badge badge-warn' }, '警告');
  return h('span', { class: 'badge badge-info' }, '信息');
}
function categoryLabel(c) {
  return { rig: '矿机', agent: '采集端', command: '命令', alert: '告警', config: '配置', auth: '认证', system: '系统' }[c] || c;
}
