// 币种管理：内置 + 自定义币种（新增币种不需要升级采集端）
import { h, clear, coinTag } from '../dom.js';
import { api } from '../api.js';
import { toast } from '../realtime.js';
import { pageHeader, openModal, confirmDialog } from '../components.js';

const ALGO_HINT = {
  'RandomX': 'Monero（CPU 为主）',
  'PearlHash': 'Pearl（GPU）',
  'KawPow': 'Ravencoin / Neoxa 等 GPU 币',
  'Ethash': 'ETC 等 GPU 币',
  'Autolykos2': 'Ergo',
  'GhostRider': 'Raptoreum',
  'Scrypt': 'Litecoin / Dogecoin',
  'Blake3': 'Alephium / Ironfish',
};

export function CoinsPage(root) {
  const el = h('div');
  root.appendChild(el);
  let data = null;

  async function load() {
    data = await api.coins();
    render();
  }

  function render() {
    clear(el);
    el.appendChild(pageHeader('币种管理', '内置币种开箱即用；自定义币种填好算法与矿池即可下发，采集端无需升级', [
      h('button', { class: 'btn btn-sm', onclick: load }, '↻ 刷新'),
      h('button', { class: 'btn btn-primary btn-sm', onclick: addDialog }, '+ 新增币种'),
    ]));
    if (!data) return el.appendChild(h('div', { class: 'skeleton', style: { height: '160px' } }));

    el.appendChild(h('div', { class: 'grid-3 mb-20' },
      statCard('币种总数', String(data.coins.length)),
      statCard('内置', String(data.builtinCount)),
      statCard('自定义', String(data.customCount)),
    ));

    const card = h('div', { class: 'card pad-0 mb-20' });
    card.appendChild(h('div', { class: 'card-title', style: { padding: '14px 16px 0' } }, '全部币种'));
    card.appendChild(h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, '币种'), h('th', {}, '算法'), h('th', {}, '算力单位'), h('th', {}, '可用矿工'), h('th', { class: 'num' }, '矿机数'), h('th', {}, '来源'), h('th', {}, ''))),
      h('tbody', {}, ...data.coins.map((c) => h('tr', {},
        h('td', {}, h('div', { class: 'flex', style: { gap: '8px' } }, coinTag(c.symbol), h('span', { style: { fontWeight: '600' } }, c.name))),
        h('td', {}, h('span', { class: 'badge badge-info' }, c.algo)),
        h('td', { class: 'mono dim' }, c.unit),
        h('td', { style: { fontSize: '12px' } }, (c.miners || []).join('、') || '—'),
        h('td', { class: 'num' }, String(c.rigCount || 0)),
        h('td', {}, c.builtin ? h('span', { class: 'badge badge-muted' }, '内置') : h('span', { class: 'badge badge-warn' }, '自定义')),
        h('td', {}, c.builtin ? '—' : h('button', { class: 'btn btn-sm btn-danger', onclick: () => remove(c) }, '删除')),
      ))),
    ));
    el.appendChild(card);

    // 矿工支持矩阵
    const mc = h('div', { class: 'card pad-0' });
    mc.appendChild(h('div', { class: 'card-title', style: { padding: '14px 16px 0' } }, '矿工支持矩阵'));
    mc.appendChild(h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, '矿工'), h('th', {}, 'Windows 可执行'), h('th', {}, 'Linux 可执行'), h('th', {}, '支持的币种'), h('th', {}, '说明'))),
      h('tbody', {}, ...data.miners.map((m) => h('tr', {},
        h('td', { style: { fontWeight: '600' } }, m.name, h('span', { class: 'dim mono', style: { fontSize: '11px', marginLeft: '6px' } }, m.id)),
        h('td', { class: 'mono dim', style: { fontSize: '12px' } }, m.bin || '—'),
        h('td', { class: 'mono dim', style: { fontSize: '12px' } }, m.binLinux || '—'),
        h('td', {}, ...(m.coins || []).map((c) => coinTag(c))),
        h('td', { class: 'dim', style: { fontSize: '12px' } }, m.hint || ''),
      ))),
    ));
    el.appendChild(mc);
  }

  function statCard(label, value) {
    return h('div', { class: 'card' }, h('div', { class: 'stat' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value)));
  }

  async function remove(c) {
    const ok = await confirmDialog({ title: '删除币种', message: `删除 ${c.symbol}（${c.name}）？`, okText: '删除' });
    if (!ok) return;
    try { await api.deleteCoin(c.symbol); toast('已删除', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); }
  }

  function addDialog() {
    const symbol = h('input', { class: 'input', placeholder: '例如 KAS', maxlength: 12 });
    const name = h('input', { class: 'input', placeholder: '例如 Kaspa' });
    const algo = h('input', { class: 'input', placeholder: '例如 kHeavyHash', list: 'algo-list' });
    const unit = h('input', { class: 'input', value: 'H/s' });
    const hint = h('input', { class: 'input', placeholder: '钱包地址格式提示（可选）' });
    const miners = h('input', { class: 'input', placeholder: '逗号分隔，如 gminer,srbminer（留空=自动识别）' });
    const datalist = h('datalist', { id: 'algo-list' }, ...Object.keys(ALGO_HINT).map((a) => h('option', { value: a }, ALGO_HINT[a])));
    const body = h('div', {},
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', {}, '币种代号 *'), symbol),
        h('div', { class: 'field' }, h('label', {}, '币种名称'), name),
      ),
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', {}, '算法 *'), algo, datalist),
        h('div', { class: 'field' }, h('label', {}, '算力单位'), unit),
      ),
      h('div', { class: 'field' }, h('label', {}, '兼容矿工'), miners),
      h('div', { class: 'field' }, h('label', {}, '地址提示'), hint),
      h('div', { class: 'hint' }, '新增后即可在飞行表里选择该币种；矿机端按矿工命令行参数直接启动，无需升级采集端。'),
    );
    const modal = openModal({
      title: '新增币种',
      body,
      footer: h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => modal.close() }, '取消'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              await api.addCoin({
                symbol: symbol.value, name: name.value, algo: algo.value, unit: unit.value,
                addressHint: hint.value,
                miners: miners.value.split(/[,，\s]+/).filter(Boolean),
              });
              toast('已新增', 'ok');
              modal.close();
              await load();
            } catch (e) { toast(e.message, 'err'); }
          },
        }, '保存'),
      ),
    });
  }

  load().catch((e) => { clear(el); el.appendChild(h('div', { class: 'empty' }, h('p', {}, `加载失败：${e.message}`))); });
  return () => {};
}
