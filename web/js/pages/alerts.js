// 告警规则与告警记录
import { h, clear, fmtAgo, fmtTime } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { toast } from '../realtime.js';
import { confirmDialog, formDialog, pageHeader, openModal } from '../components.js';

const METRIC_LABEL = {
  offline: '离线时长',
  temp: '最高温度',
  hashrate_drop: '算力下降',
  miner_down: '矿工未运行',
  power: '功耗',
  rejected: '拒绝率',
};

export function AlertsPage(root) {
  let data = null;
  const el = h('div');
  root.appendChild(el);

  async function load() {
    data = await api.alerts();
    render();
  }

  function render() {
    if (!data) return;
    clear(el);
    el.appendChild(pageHeader('告警', '规则会在条件持续满足后触发，并在恢复后自动关闭', [
      h('button', { class: 'btn btn-primary', onclick: () => editRule(null) }, '＋ 新建规则'),
      h('button', { class: 'btn', onclick: testChannels }, '测试通知渠道'),
    ]));

    // 规则表
    const rules = data.rules || [];
    const rulesCard = h('div', { class: 'card pad-0 mb-20', style: { overflow: 'auto' } });
    rulesCard.appendChild(h('div', { class: 'card-title', style: { padding: '14px 16px 0' } }, '告警规则'));
    if (!rules.length) {
      rulesCard.appendChild(h('div', { class: 'empty', style: { padding: '34px' } }, h('p', {}, '还没有规则，点击「新建规则」创建。')));
    } else {
      const table = h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, '规则'), h('th', {}, '指标'), h('th', {}, '条件'), h('th', {}, '作用范围'), h('th', {}, '持续'), h('th', {}, '渠道'), h('th', {}, '状态'), h('th', {}, ''))),
        h('tbody', {}, ...rules.map((r) => h('tr', {},
          h('td', { style: { fontWeight: '600' } }, r.name),
          h('td', {}, METRIC_LABEL[r.metric] || r.metric),
          h('td', { class: 'mono' }, `${r.comparator} ${r.threshold}${r.metric === 'temp' ? '°C' : r.metric === 'offline' ? 's' : r.metric === 'power' ? 'W' : r.metric === 'hashrate_drop' || r.metric === 'rejected' ? '%' : ''}`),
          h('td', { class: 'dim' }, targetLabel(r.target)),
          h('td', { class: 'dim' }, r.duration_sec ? `${r.duration_sec}s` : '立即'),
          h('td', { class: 'dim' }, (r.channels || []).map((c) => channelLabel(c)).join(' / ')),
          h('td', {}, r.enabled ? h('span', { class: 'badge badge-ok' }, '启用') : h('span', { class: 'badge badge-muted' }, '停用')),
          h('td', {}, h('div', { class: 'btn-row' },
            h('button', { class: 'btn btn-sm', onclick: () => editRule(r) }, '编辑'),
            h('button', { class: 'btn btn-danger btn-sm', onclick: () => removeRule(r) }, '删除'),
          )),
        ))),
      );
      rulesCard.appendChild(table);
    }
    el.appendChild(rulesCard);

    // 告警记录
    const alerts = (store.get().alerts.length ? store.get().alerts : data.alerts) || [];
    const listCard = h('div', { class: 'card pad-0' });
    listCard.appendChild(h('div', { class: 'card-title', style: { padding: '14px 16px 0' } }, '告警记录'));
    if (!alerts.length) {
      listCard.appendChild(h('div', { class: 'empty', style: { padding: '30px' } }, h('p', {}, '没有告警记录。')));
    } else {
      listCard.appendChild(h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, '时间'), h('th', {}, '矿机'), h('th', {}, '内容'), h('th', {}, '严重度'), h('th', {}, '状态'), h('th', {}, ''))),
        h('tbody', {}, ...alerts.slice(0, 200).map((a) => h('tr', {},
          h('td', { class: 'mono dim', style: { fontSize: '11.5px' } }, fmtTime(a.created_at)),
          h('td', {}, a.rig_name || '—'),
          h('td', {}, a.message),
          h('td', {}, a.severity === 'critical' ? h('span', { class: 'badge badge-danger' }, '严重') : h('span', { class: 'badge badge-warn' }, '警告')),
          h('td', {}, a.state === 'firing'
            ? h('span', { class: 'badge badge-danger' }, '触发中')
            : h('span', { class: 'badge badge-ok' }, '已恢复')),
          h('td', {}, a.state === 'firing' && !a.acked_at
            ? h('button', { class: 'btn btn-sm', onclick: async () => { await api.ackAlert(a.id); toast('已确认', 'ok'); await load(); } }, '确认')
            : h('span', { class: 'dim', style: { fontSize: '11px' } }, a.resolved_at ? fmtAgo(a.resolved_at) : '')),
        ))),
      ));
    }
    el.appendChild(listCard);
  }

  async function editRule(rule) {
    const s = store.get();
    const targets = [
      { value: 'fleet', label: '全部矿机' },
      ...s.rigs.map((r) => ({ value: `rig:${r.id}`, label: `矿机：${r.name}` })),
      ...[...new Set(s.rigs.map((r) => r.group_name))].filter(Boolean).map((g) => ({ value: `group:${g}`, label: `分组：${g}` })),
      { value: 'coin:XMR', label: '币种：XMR' },
      { value: 'coin:PRL', label: '币种：PRL' },
    ];
    const metricSel = h('select', { class: 'select' },
      ...Object.entries(METRIC_LABEL).map(([k, v]) => h('option', { value: k, selected: rule?.metric === k }, v)));
    const targetSel = h('select', { class: 'select' }, ...targets.map((t) => h('option', { value: t.value, selected: rule?.target === t.value }, t.label)));
    const cmpSel = h('select', { class: 'select' }, ...['>', '>=', '<', '<='].map((c) => h('option', { value: c, selected: rule?.comparator === c }, c)));
    const thr = h('input', { class: 'input', type: 'number', value: rule?.threshold ?? 85 });
    const dur = h('input', { class: 'input', type: 'number', value: rule?.duration_sec ?? 0 });
    const name = h('input', { class: 'input', value: rule?.name || '', placeholder: '例如：GPU 温度超过 85°C' });
    const channelBoxes = {};
    for (const c of [['inapp', '站内'], ['telegram', 'Telegram'], ['discord', 'Discord'], ['webhook', 'Webhook']]) {
      channelBoxes[c[0]] = h('input', { type: 'checkbox', checked: rule ? (rule.channels || []).includes(c[0]) : c[0] === 'inapp', style: { width: '17px', height: '17px', accentColor: 'var(--accent)' } });
    }
    const body = h('div', {},
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', {}, '规则名称'), name),
        h('div', { class: 'field' }, h('label', {}, '指标'), metricSel),
      ),
      h('div', { class: 'grid-3' },
        h('div', { class: 'field' }, h('label', {}, '条件'), cmpSel),
        h('div', { class: 'field' }, h('label', {}, '阈值'), thr),
        h('div', { class: 'field' }, h('label', {}, '持续（秒）'), dur, h('div', { class: 'hint' }, '0 = 立即触发')),
      ),
      h('div', { class: 'field' }, h('label', {}, '作用范围'), targetSel),
      h('div', { class: 'field' }, h('label', {}, '通知渠道'),
        h('div', { class: 'flex', style: { gap: '14px', flexWrap: 'wrap' } },
          ...Object.entries(channelBoxes).map(([k, cb]) => h('label', { class: 'flex', style: { gap: '6px', cursor: 'pointer' } }, cb, channelLabel(k)))),
        h('div', { class: 'hint' }, 'Telegram / Discord / Webhook 需要在「设置 → 通知」中配置'),
      ),
    );
    const modal = openModal({
      title: rule ? '编辑告警规则' : '新建告警规则',
      body,
      footer: h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => modal.close() }, '取消'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            if (!name.value.trim()) return toast('请填写规则名称', 'err');
            const channels = Object.entries(channelBoxes).filter(([, cb]) => cb.checked).map(([k]) => k);
            try {
              await api.saveRule({
                id: rule?.id,
                name: name.value.trim(),
                metric: metricSel.value,
                target: targetSel.value,
                comparator: cmpSel.value,
                threshold: Number(thr.value),
                durationSec: Number(dur.value) || 0,
                enabled: true,
                channels: channels.length ? channels : ['inapp'],
              });
              toast('规则已保存', 'ok');
              modal.close();
              await load();
            } catch (e) { toast(e.message, 'err'); }
          },
        }, '保存'),
      ),
    });
  }

  async function removeRule(rule) {
    const ok = await confirmDialog({ title: '删除规则', message: `确定删除「${rule.name}」？`, okText: '删除' });
    if (!ok) return;
    try { await api.deleteRule(rule.id); toast('已删除', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); }
  }

  function testChannels() {
    const modal = openModal({
      title: '测试通知渠道',
      body: h('div', {},
        h('p', { class: 'muted', style: { marginTop: 0 } }, '点击发送测试消息，检查配置是否正确。'),
        h('div', { class: 'btn-row' },
          ...['telegram', 'discord', 'webhook'].map((c) => h('button', {
            class: 'btn',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                await api.testNotification(c);
                toast(`${channelLabel(c)} 测试消息已发送`, 'ok');
              } catch (err) { toast(err.message, 'err'); }
              e.target.disabled = false;
            },
          }, `测试 ${channelLabel(c)}`)),
        ),
      ),
      footer: h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => modal.close() }, '关闭')),
    });
  }

  load().catch((e) => {
    clear(el);
    el.appendChild(h('div', { class: 'empty' }, h('p', {}, `加载失败：${e.message}`)));
  });
  const unsub = store.subscribe(() => render());
  return () => unsub();
}

function channelLabel(c) {
  return { inapp: '站内', telegram: 'Telegram', discord: 'Discord', webhook: 'Webhook' }[c] || c;
}
function targetLabel(t) {
  if (!t || t === 'fleet') return '全部矿机';
  if (t.startsWith('rig:')) {
    const rig = store.get().rigMap.get(t.slice(4));
    return `矿机：${rig?.name || t.slice(4)}`;
  }
  if (t.startsWith('group:')) return `分组：${t.slice(6)}`;
  if (t.startsWith('coin:')) return `币种：${t.slice(5)}`;
  return t;
}
