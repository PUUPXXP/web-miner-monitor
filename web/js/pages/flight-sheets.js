// 飞行表 + 钱包管理
import { h, clear, fmtNum, fmtAgo, coinTag } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { toast } from '../realtime.js';
import { confirmDialog, openModal, pageHeader } from '../components.js';

export function FlightSheetsPage(root, props = {}) {
  let data = null;
  let editing = null; // 正在编辑的飞行表
  const el = h('div');
  root.appendChild(el);
  const unsub = [];

  async function load() {
    data = await api.flightSheets();
    render();
  }

  function render() {
    if (!data) return;
    clear(el);
    el.appendChild(pageHeader('飞行表', '一套「币种 + 矿工 + 矿池 + 钱包 + 超频」组合，可一键分配给任意矿机', [
      h('button', { class: 'btn btn-primary', onclick: () => openEditor(null) }, '＋ 新建飞行表'),
      h('button', { class: 'btn', onclick: openWallets }, '钱包地址簿'),
    ]));
    if (editing) {
      el.appendChild(editorView(editing));
      return;
    }
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '16px' } });
    if (!data.flightSheets.length) {
      grid.appendChild(h('div', { class: 'card', style: { gridColumn: '1 / -1' } },
        h('div', { class: 'empty' }, h('div', { class: 'big' }, '✈'), h('h3', {}, '还没有飞行表'), h('p', {}, '创建第一套配置，然后分配给矿机。'), h('button', { class: 'btn btn-primary', onclick: () => openEditor(null) }, '新建飞行表'))));
    }
    for (const s of data.flightSheets) grid.appendChild(sheetCard(s));
    el.appendChild(grid);
    el.appendChild(templatesHint());
  }

  function sheetCard(s) {
    const cfg = s.config || {};
    const miner = (data.presets?.miners || []).find((m) => m.id === cfg.miner);
    const users = store.get().rigs.filter((r) => r.flight_sheet_id === s.id);
    return h('div', { class: 'card', style: { borderColor: s.is_default ? 'rgba(124,92,255,.45)' : null } },
      h('div', { class: 'flex-between' },
        h('div', { class: 'flex', style: { gap: '8px', minWidth: 0 } },
          h('div', { style: { fontWeight: '650', fontSize: '15px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.name),
          s.is_default ? h('span', { class: 'badge badge-accent' }, '默认') : null,
        ),
        coinTag(s.coin),
      ),
      h('div', { class: 'mt-8', style: { fontSize: '12.5px', color: 'var(--text-2)' } },
        h('div', {}, '矿工：', h('b', {}, miner?.name || cfg.miner || '—'), miner?.hint ? h('span', { class: 'dim' }, ` · ${miner.hint}`) : null),
        h('div', {}, '矿池：', h('span', { class: 'mono' }, cfg.poolUrl || '—')),
        h('div', { class: 'ellipsis' }, '钱包：', h('span', { class: 'mono' }, cfg.poolUser ? shortWallet(cfg.poolUser) : '—')),
        h('div', {}, '算法：', h('span', { class: 'mono' }, cfg.algo || '—'), cfg.tls ? h('span', { class: 'badge badge-ok', style: { marginLeft: '6px' } }, 'TLS') : null),
      ),
      h('div', { class: 'flex-between mt-14' },
        h('span', { class: 'dim', style: { fontSize: '11.5px' } }, `${users.length} 台矿机使用 · ${fmtAgo(s.updated_at)}`),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-sm', onclick: () => copySheet(s.id) }, '复制'),
          h('button', { class: 'btn btn-sm', onclick: () => openEditor(s) }, '编辑'),
          h('button', { class: 'btn btn-sm', onclick: () => assignSheet(s) }, '分配'),
          h('button', { class: 'btn btn-danger btn-sm', onclick: () => removeSheet(s) }, '删除'),
        ),
      ),
    );
  }

  function templatesHint() {
    return h('div', { class: 'card mt-20' },
      h('div', { class: 'card-title' }, '💡 快速开始'),
      h('div', { class: 'mt-8', style: { fontSize: '13px', color: 'var(--text-2)' } },
        h('div', {}, '1. 选择币种与矿工（门罗推荐 XMRig；Pearl 推荐 PeakMiner），填入矿池地址与钱包。'),
        h('div', {}, '2. 保存后点「分配」，选择矿机（或全部分组）。'),
        h('div', {}, '3. 采集端会收到配置并自动启动矿工；可在矿机详情页查看算力、温度与日志。'),
        h('div', { class: 'mt-8 dim', style: { fontSize: '12px' } },
          '矿工程序需要提前放在矿机上。默认路径：<安装目录>/miners/<矿工ID>/<可执行文件>，也可以在飞行表里填写绝对路径。'),
      ),
    );
  }

  // ───────── 编辑器 ─────────
  function openEditor(sheet) {
    editing = {
      id: sheet?.id || null,
      name: sheet?.name || '',
      coin: sheet?.coin || 'XMR',
      isDefault: !!sheet?.is_default,
      cfg: sheet?.config || defaultConfig('XMR'),
    };
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function defaultConfig(coin) {
    const miners = (data?.presets?.miners || []).filter((m) => m.coins.includes(coin));
    const miner = miners[0]?.id || 'xmrig';
    const pool = (data?.presets?.pools?.[coin] || [])[0];
    return {
      miner,
      poolUrl: pool?.url || '',
      poolUser: '',
      poolPass: 'x',
      workerName: '{rig}',
      algo: coin === 'PRL' ? 'pearlhash' : 'rx/0',
      tls: !!pool?.tls,
      apiPort: miners[0]?.apiPort || (coin === 'PRL' ? 4068 : 3333),
      extraArgs: '',
      oc: { powerLimitW: null, coreClockOffset: null, memClockOffset: null, fanSpeed: null },
      watchdog: { enabled: true, maxTempC: 85, minHashratePercent: 60, crashRestart: true, restartDelaySec: 10 },
      autoStart: true,
    };
  }

  function editorView(state) {
    const presets = data.presets || {};
    const wrap = h('div', {});
    const isNew = !state.id;
    const form = h('div', { class: 'card' });
    form.appendChild(h('div', { class: 'card-title mb-14' }, isNew ? '新建飞行表' : `编辑：${state.name}`));

    // 基础
    const name = h('input', { class: 'input', value: state.name, placeholder: '例如：门罗 XMRig 主矿池' });
    const coin = h('select', { class: 'select' },
      h('option', { value: 'XMR', selected: state.coin === 'XMR' }, 'Monero (XMR) — RandomX / CPU'),
      h('option', { value: 'PRL', selected: state.coin === 'PRL' }, 'Pearl (PRL) — PearlHash / GPU'),
    );
    const isDefault = h('input', { type: 'checkbox', checked: state.isDefault, style: { width: '18px', height: '18px', accentColor: 'var(--accent)' } });
    form.append(
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', {}, '名称'), name),
        h('div', { class: 'field' }, h('label', {}, '币种'), coin),
      ),
      h('label', { class: 'flex', style: { gap: '8px', cursor: 'pointer', marginBottom: '16px' } }, isDefault, '设为默认飞行表'),

      h('div', { class: 'card-title mb-8', style: { marginTop: '8px' } }, '矿工'),
      minerRow(),
      poolRow(),
      h('div', { class: 'grid-3' },
        h('div', { class: 'field' }, h('label', {}, '算力单位 / 算法'), algoInput()),
        h('div', { class: 'field' }, h('label', {}, 'API 端口'), apiPortInput(), h('div', { class: 'hint' }, '用于读取算力/份额')),
        h('div', { class: 'field' }, h('label', {}, 'Worker（{rig} 自动替换为矿机名）'), workerInput()),
      ),
      h('div', { class: 'field' }, h('label', {}, '额外启动参数'), extraArgsInput(), h('div', { class: 'hint' }, '例如 --keepalive、--cpu-max-threads-hint 80')),
    );

    // 超频
    form.appendChild(h('div', { class: 'card-title mb-8', style: { marginTop: '12px' } }, '功耗 / 超频（NVIDIA，需要管理员权限）'));
    const oc = h('div', { class: 'grid-4' },
      numField('功耗上限 (W)', state.cfg.oc?.powerLimitW, (v) => { state.cfg.oc.powerLimitW = v; }),
      numField('核心频率偏移 (MHz)', state.cfg.oc?.coreClockOffset, (v) => { state.cfg.oc.coreClockOffset = v; }),
      numField('显存频率偏移 (MHz)', state.cfg.oc?.memClockOffset, (v) => { state.cfg.oc.memClockOffset = v; }),
      numField('风扇转速 (%)', state.cfg.oc?.fanSpeed, (v) => { state.cfg.oc.fanSpeed = v; }),
    );
    form.appendChild(oc);

    // 看门狗
    form.appendChild(h('div', { class: 'card-title mb-8', style: { marginTop: '12px' } }, '看门狗 / 保护'));
    const wdEnabled = h('input', { type: 'checkbox', checked: state.cfg.watchdog?.enabled !== false, style: { width: '18px', height: '18px', accentColor: 'var(--accent)' } });
    const wdCrash = h('input', { type: 'checkbox', checked: state.cfg.watchdog?.crashRestart !== false, style: { width: '18px', height: '18px', accentColor: 'var(--accent)' } });
    const wdTemp = h('input', { class: 'input', type: 'number', value: state.cfg.watchdog?.maxTempC ?? 85 });
    const wdDrop = h('input', { class: 'input', type: 'number', value: state.cfg.watchdog?.minHashratePercent ?? 60 });
    const autoStart = h('input', { type: 'checkbox', checked: state.cfg.autoStart !== false, style: { width: '18px', height: '18px', accentColor: 'var(--accent)' } });
    form.appendChild(h('div', { class: 'grid-4' },
      h('div', { class: 'field' }, h('label', { class: 'flex' }, wdEnabled, '启用看门狗')),
      h('div', { class: 'field' }, h('label', { class: 'flex' }, wdCrash, '崩溃自动重启')),
      h('div', { class: 'field' }, h('label', {}, '温度上限 (°C)'), wdTemp),
      h('div', { class: 'field' }, h('label', {}, '算力下降阈值 (%)'), wdDrop),
    ));
    form.appendChild(h('label', { class: 'flex', style: { gap: '8px', cursor: 'pointer', marginBottom: '16px' } }, autoStart, '采集端启动时自动开始挖矿'));

    form.appendChild(h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-primary', onclick: save }, isNew ? '创建飞行表' : '保存修改'),
      h('button', { class: 'btn', onclick: () => { editing = null; render(); } }, '取消'),
    ));
    wrap.appendChild(form);
    wrap.appendChild(h('div', { class: 'card mt-20' },
      h('div', { class: 'card-title' }, '命令预览'),
      h('div', { class: 'logview mt-8', id: 'cmdPreview' }, previewCommand(state)),
    ));
    return wrap;

    // 子控件
    function minerRow() {
      const box = h('div', { class: 'field' }, h('label', {}, '矿工程序'));
      const sel = h('select', { class: 'select', onchange: (e) => { state.cfg.miner = e.target.value; updatePreview(); } },
        ...(presets.miners || []).map((m) => h('option', { value: m.id, selected: m.id === state.cfg.miner }, `${m.name}${m.coins.includes(state.coin) ? '' : '（不支持当前币种）'}`)),
      );
      box.appendChild(sel);
      const hint = h('div', { class: 'hint' });
      const bin = h('input', { class: 'input mt-8', placeholder: '可选：矿工完整路径（留空则用安装目录下默认路径）', value: state.cfg.binPath || '' });
      bin.addEventListener('input', () => { state.cfg.binPath = bin.value; updatePreview(); });
      const updateHint = () => {
        const m = (presets.miners || []).find((x) => x.id === state.cfg.miner);
        hint.textContent = m ? `${m.hint || ''}  默认：miners/${m.id}/${m.bin}` : '';
      };
      box.append(bin, hint);
      updateHint();
      sel.addEventListener('change', updateHint);
      return box;
    }
    function poolRow() {
      const box = h('div', {});
      const list = presets.pools?.[state.coin] || [];
      const sel = h('select', { class: 'select', onchange: (e) => {
        const p = list[Number(e.target.value)];
        if (!p) return;
        state.cfg.poolUrl = p.url; state.cfg.tls = p.tls;
        urlInput.value = p.url; tls.checked = p.tls; updatePreview();
      } }, h('option', { value: '' }, '选择预设矿池…'), ...list.map((p, i) => h('option', { value: i }, `${p.name} — ${p.url}`)));
      const urlInput = h('input', { class: 'input mono', value: state.cfg.poolUrl || '', placeholder: 'host:port' });
      const tls = h('input', { type: 'checkbox', checked: !!state.cfg.tls, style: { width: '18px', height: '18px', accentColor: 'var(--accent)' } });
      const wallet = h('input', { class: 'input mono', value: state.cfg.poolUser || '', placeholder: state.coin === 'PRL' ? 'prl1…' : '4…' });
      const pass = h('input', { class: 'input mono', value: state.cfg.poolPass || 'x' });
      urlInput.addEventListener('input', () => { state.cfg.poolUrl = urlInput.value; updatePreview(); });
      tls.addEventListener('change', () => { state.cfg.tls = tls.checked; updatePreview(); });
      wallet.addEventListener('input', () => { state.cfg.poolUser = wallet.value; updatePreview(); });
      pass.addEventListener('input', () => { state.cfg.poolPass = pass.value; updatePreview(); });
      box.append(
        h('div', { class: 'field' }, h('label', {}, '矿池预设'), sel),
        h('div', { class: 'grid-2' },
          h('div', { class: 'field' }, h('label', {}, '矿池地址'), urlInput),
          h('div', { class: 'field' }, h('label', { class: 'flex' }, tls, '使用 TLS'), h('div', { class: 'hint' }, '多数矿池 TLS 端口不同，注意对应')),
        ),
        h('div', { class: 'grid-2' },
          h('div', { class: 'field' }, h('label', {}, '钱包地址'), wallet, h('div', { class: 'hint' }, '建议先在「钱包地址簿」保存常用地址')),
          h('div', { class: 'field' }, h('label', {}, '矿池密码'), pass),
        ),
      );
      return box;
    }
    function algoInput() {
      const list = presets.algos?.[state.coin] || [];
      return h('input', { class: 'input mono', value: state.cfg.algo || '', list: 'algoList', oninput: (e) => { state.cfg.algo = e.target.value; updatePreview(); } });
    }
    function apiPortInput() {
      return h('input', { class: 'input mono', type: 'number', value: state.cfg.apiPort ?? '', oninput: (e) => { state.cfg.apiPort = Number(e.target.value) || null; updatePreview(); } });
    }
    function workerInput() {
      return h('input', { class: 'input mono', value: state.cfg.workerName || '{rig}', oninput: (e) => { state.cfg.workerName = e.target.value; updatePreview(); } });
    }
    function extraArgsInput() {
      return h('textarea', { class: 'textarea', rows: 2, oninput: (e) => { state.cfg.extraArgs = e.target.value; updatePreview(); } }, state.cfg.extraArgs || '');
    }
    function numField(label, value, set) {
      const inp = h('input', { class: 'input', type: 'number', value: value ?? '', oninput: (e) => set(e.target.value === '' ? null : Number(e.target.value)) });
      return h('div', { class: 'field' }, h('label', {}, label), inp);
    }
    function save() {
      if (!name.value.trim()) return toast('请填写名称', 'err');
      const body = {
        id: state.id,
        name: name.value.trim(),
        coin: coin.value,
        isDefault: isDefault.checked,
        config: {
          ...state.cfg,
          watchdog: {
            enabled: wdEnabled.checked,
            crashRestart: wdCrash.checked,
            maxTempC: Number(wdTemp.value) || 85,
            minHashratePercent: Number(wdDrop.value) || 60,
            restartDelaySec: 10,
          },
          autoStart: autoStart.checked,
        },
      };
      api.saveFlightSheet(body).then(async () => {
        toast('飞行表已保存', 'ok');
        editing = null;
        await load();
      }).catch((e) => toast(e.message, 'err'));
    }
    function updatePreview() {
      const el = document.getElementById('cmdPreview');
      if (el) el.textContent = previewCommand(state);
    }
  }

  function previewCommand(state) {
    const miner = (data.presets.miners || []).find((m) => m.id === state.cfg.miner);
    const args = [];
    const c = state.cfg;
    if (c.miner === 'xmrig') {
      args.push('-o', c.poolUrl || '<矿池>', '-u', c.poolUser || '<钱包>', '-p', c.poolPass || 'x', '-a', c.algo || 'rx/0', '--rig-id', c.workerName || '{rig}');
      if (c.tls) args.push('--tls');
      if (c.extraArgs) args.push(c.extraArgs);
      args.push('--http-host 127.0.0.1', `--http-port ${c.apiPort || 3333}`);
    } else if (c.miner === 'peakminer') {
      const url = c.tls && !/^(stratum\+ssl|stratum\+tls):\/\//i.test(c.poolUrl || '') ? `stratum+ssl://${c.poolUrl}` : (c.poolUrl || '<矿池>');
      args.push('--coin pearl', '-o', url, '-u', `${c.poolUser || '<钱包>'}.${c.workerName || 'rig'}`, `--api-port ${c.apiPort || 4068}`);
      if (c.extraArgs) args.push(c.extraArgs);
    } else if (c.miner === 'custom') {
      args.push(String(c.command || '<自定义命令>'));
    } else {
      args.push(`<${miner?.name || c.miner} 启动参数>`, c.poolUrl || '<矿池>');
    }
    return `${miner?.bin || c.miner} ${args.join(' ')}`;
  }

  // ───────── 操作 ─────────
  function copySheet(id) {
    const s = data.flightSheets.find((x) => x.id === id);
    if (!s) return;
    openEditor({ ...s, id: null, name: `${s.name} 副本` });
    toast('已复制配置，修改后保存', 'ok');
  }

  async function removeSheet(s) {
    const ok = await confirmDialog({ title: '删除飞行表', message: `确定删除「${s.name}」？使用它的矿机会停止挖矿。`, okText: '删除' });
    if (!ok) return;
    try { await api.deleteFlightSheet(s.id); toast('已删除', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); }
  }

  function assignSheet(s) {
    const rigs = store.get().rigs;
    const body = h('div', {});
    body.appendChild(h('p', { class: 'muted', style: { marginTop: 0 } }, `将「${s.name}」分配给：`));
    const checks = rigs.map((r) => {
      const cb = h('input', { type: 'checkbox', checked: r.flight_sheet_id === s.id, style: { width: '17px', height: '17px', accentColor: 'var(--accent)' } });
      return { rig: r, cb, el: h('label', { class: 'flex', style: { padding: '6px 0', cursor: 'pointer', gap: '10px' } }, cb, h('span', { style: { flex: '1' } }, r.name), coinTag(r.coin), r.online ? h('span', { class: 'badge badge-ok' }, '在线') : h('span', { class: 'badge badge-muted' }, '离线')) };
    });
    if (!rigs.length) body.appendChild(h('div', { class: 'dim' }, '暂无矿机，请先添加矿机。'));
    else body.append(...checks.map((c) => c.el));
    const modal = openModal({
      title: '分配飞行表',
      body,
      footer: h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => modal.close() }, '取消'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const ids = checks.filter((c) => c.cb.checked).map((c) => c.rig.id);
            try {
              await api.bulk(ids.length ? ids : rigs.map((r) => r.id), 'patch', { flightSheetId: s.id });
              toast(`已分配给 ${ids.length || rigs.length} 台矿机`, 'ok');
              modal.close();
              const { rigs: fresh } = await api.rigs();
              store.setRigs(fresh);
            } catch (e) { toast(e.message, 'err'); }
          },
        }, '应用'),
      ),
    });
  }

  async function openWallets() {
    const wallets = data.wallets || [];
    const body = h('div', {});
    body.appendChild(h('div', { class: 'flex-between mb-14' },
      h('span', { class: 'dim', style: { fontSize: '12px' } }, '保存常用钱包地址，创建飞行表时可直接选用。'),
      h('button', { class: 'btn btn-sm btn-primary', onclick: addWallet }, '＋ 添加'),
    ));
    if (!wallets.length) body.appendChild(h('div', { class: 'dim' }, '还没有保存的钱包。'));
    for (const w of wallets) {
      body.appendChild(h('div', { class: 'flex', style: { padding: '8px 0', borderBottom: '1px solid var(--border)', gap: '10px' } },
        coinTag(w.coin),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { style: { fontWeight: '600' } }, w.name),
          h('div', { class: 'mono dim ellipsis', style: { fontSize: '11px' } }, w.address),
        ),
        h('button', { class: 'btn btn-sm', onclick: () => { navigator.clipboard?.writeText(w.address); toast('已复制地址', 'ok'); } }, '复制'),
      ));
    }
    const modal = openModal({ title: '钱包地址簿', body, footer: h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => modal.close() }, '关闭')) });

    async function addWallet() {
      const coinSel = h('select', { class: 'select' }, h('option', { value: 'XMR' }, 'Monero (XMR)'), h('option', { value: 'PRL' }, 'Pearl (PRL)'));
      const nm = h('input', { class: 'input', placeholder: '例如：主钱包' });
      const addr = h('input', { class: 'input mono', placeholder: '钱包地址' });
      const m2 = openModal({
        title: '添加钱包',
        body: h('div', {}, h('div', { class: 'field' }, h('label', {}, '币种'), coinSel), h('div', { class: 'field' }, h('label', {}, '名称'), nm), h('div', { class: 'field' }, h('label', {}, '地址'), addr)),
        footer: h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => m2.close() }, '取消'),
          h('button', {
            class: 'btn btn-primary',
            onclick: async () => {
              try {
                await api.saveWallet({ coin: coinSel.value, name: nm.value.trim(), address: addr.value.trim() });
                toast('已保存', 'ok');
                m2.close();
                await load();
                openWallets();
              } catch (e) { toast(e.message, 'err'); }
            },
          }, '保存'),
        ),
      });
    }
  }

  load().catch((e) => {
    clear(el);
    el.appendChild(h('div', { class: 'empty' }, h('p', {}, `加载失败：${e.message}`)));
  });
  return () => { unsub.forEach((f) => f()); };
}

function shortWallet(w) {
  return w.length > 20 ? `${w.slice(0, 10)}…${w.slice(-6)}` : w;
}
