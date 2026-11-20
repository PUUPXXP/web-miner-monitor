// 在线升级中心：镜像/采集端/矿工/系统组件
import { h, clear, fmtAgo, fmtNum, coinTag, statusBadge } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { realtime, toast } from '../realtime.js';
import { pageHeader, openModal, confirmDialog } from '../components.js';

const KIND_LABEL = { agent: '采集端', miner: '挖矿程序', system: '系统组件' };
const PLATFORM_LABEL = { win32: 'Windows', linux: 'Linux', any: '通用' };

export function UpdatesPage(root) {
  const el = h('div');
  root.appendChild(el);
  let data = null;
  let tab = 'packages';
  let uploading = false;

  async function load() {
    data = await api.updates();
    render();
  }

  function render() {
    if (!data) {
      clear(el);
      el.appendChild(h('div', { class: 'skeleton', style: { height: '200px' } }));
      return;
    }
    clear(el);
    el.appendChild(pageHeader('在线升级中心', '镜像组件、采集端、挖矿程序的版本管理与一键下发', [
      h('button', { class: 'btn btn-sm', onclick: load }, '↻ 刷新'),
      h('button', { class: 'btn btn-primary btn-sm', onclick: uploadDialog }, '⬆ 上传升级包'),
    ]));
    el.appendChild(summaryCards());
    el.appendChild(h('div', { class: 'tabs' },
      ...[['packages', '升级包'], ['rigs', '矿机版本'], ['jobs', '升级记录'], ['howto', '制作升级包']].map(([k, label]) =>
        h('div', { class: `tab ${tab === k ? 'active' : ''}`, onclick: () => { tab = k; render(); } }, label)),
    ));
    if (tab === 'packages') el.appendChild(packagesView());
    else if (tab === 'rigs') el.appendChild(rigsView());
    else if (tab === 'jobs') el.appendChild(jobsView());
    else el.appendChild(howtoView());
  }

  function summaryCards() {
    const p = data.status?.packages || { agent: [], miner: [], system: [] };
    const byKind = (k) => p[k]?.length || 0;
    const pending = (data.status?.rigs || []).reduce((n, r) => n + Object.keys(r.pending || {}).length, 0);
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '14px', marginBottom: '18px' } },
      card('升级包', String((data.all || []).length), '个版本'),
      card('采集端', `v${data.agentVersion}`, `${byKind('agent')} 个发布包`),
      card('挖矿程序', String(byKind('miner')), '个可升级'),
      card('待升级矿机', String((data.status?.rigs || []).filter((r) => Object.keys(r.miners || {}).length && isBehind(r)).length), '台'),
      card('进行中任务', String((data.jobs || []).filter((j) => j.status === 'running' || j.status === 'pending').length), `${byKind('system')} 个系统组件`),
    );
  }

  function isBehind(rig) {
    const latest = {};
    for (const pkg of data.feed || []) if (pkg.kind === 'miner') latest[pkg.id] = pkg.version;
    return Object.entries(rig.miners || {}).some(([id, v]) => latest[id] && cmp(v, latest[id]) < 0);
  }

  function card(label, value, sub) {
    return h('div', { class: 'card' }, h('div', { class: 'stat' },
      h('span', { class: 'label' }, label),
      h('span', { class: 'value' }, value),
      h('span', { class: 'delta' }, sub),
    ));
  }

  // ───────── 升级包 ─────────
  function packagesView() {
    const wrap = h('div', {});
    const all = data.all || [];
    if (!all.length) {
      wrap.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' },
        h('div', { class: 'big' }, '⬆'), h('h3', {}, '还没有升级包'),
        h('p', {}, '上传挖矿程序或采集端的 tar.gz，即可在控制台一键升级所有矿机。'),
        h('button', { class: 'btn btn-primary', onclick: uploadDialog }, '上传升级包'))));
      return wrap;
    }
    for (const kind of ['miner', 'agent', 'system']) {
      const items = all.filter((x) => x.kind === kind);
      if (!items.length) continue;
      const card = h('div', { class: 'card pad-0 mb-20' });
      card.appendChild(h('div', { class: 'card-title', style: { padding: '14px 16px 0' } },
        h('span', {}, KIND_LABEL[kind]),
        h('div', { class: 'spacer' }),
        h('span', { class: 'dim', style: { fontSize: '12px' } }, `${items.length} 个版本`)));
      card.appendChild(h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, '名称'), h('th', {}, '版本'), h('th', {}, '平台'), h('th', { class: 'num' }, '大小'), h('th', {}, '上传时间'), h('th', {}, 'SHA256'), h('th', {}, ''))),
        h('tbody', {}, ...items.sort((a, b) => cmp(b.version, a.version) || b.mtime - a.mtime).map((it) => h('tr', {},
          h('td', { style: { fontWeight: '600' } }, kind === 'miner' ? minerName(it.id) : it.id),
          h('td', { class: 'mono' }, `v${it.version}`),
          h('td', {}, h('span', { class: 'badge badge-muted' }, PLATFORM_LABEL[it.platform] || it.platform)),
          h('td', { class: 'num' }, `${fmtNum(it.size / 1024 / 1024, 1)} MB`),
          h('td', { class: 'dim' }, fmtAgo(it.mtime)),
          h('td', { class: 'mono dim', style: { fontSize: '11px' } }, it.sha256 ? it.sha256.slice(0, 12) + '…' : '—'),
          h('td', {}, h('div', { class: 'btn-row' },
            h('button', { class: 'btn btn-sm btn-primary', onclick: () => pushDialog(it) }, '下发升级'),
            h('button', { class: 'btn btn-sm btn-danger', onclick: () => removePackage(it) }, '删除'),
          )),
        ))),
      ));
      wrap.appendChild(card);
    }
    return wrap;
  }

  function minerName(id) {
    const m = (data.status && data.status.packages?.miner || []).find((x) => x.id === id);
    return m ? m.id : id;
  }

  async function removePackage(it) {
    const ok = await confirmDialog({ title: '删除升级包', message: `删除 ${it.kind}/${it.id}@${it.version}？已安装的矿机不受影响。`, okText: '删除' });
    if (!ok) return;
    try { await api.deleteUpdate(it.kind, it.id, it.version); toast('已删除', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); }
  }

  function pushDialog(pkg = null) {
    // 优先用全局 store；直接打开本页时 store 可能还没加载，退回接口给的矿机列表
    const storeRigs = store.get().rigs || [];
    const rigs = storeRigs.length
      ? storeRigs.map((r) => ({ id: r.id, name: r.name, coin: r.coin, online: r.online }))
      : (data.status?.rigs || []).map((r) => ({ id: r.id, name: r.name, coin: r.coin, online: r.online }));
    const body = h('div', {});
    const kinds = pkg ? [pkg.kind] : ['miner', 'agent', 'system'];
    let result = null;
    const kindSel = h('select', { class: 'select' },
      ...kinds.map((k) => h('option', { value: k, selected: pkg ? pkg.kind === k : k === 'miner' }, KIND_LABEL[k])));
    const pkgSel = h('select', { class: 'select' });
    const fillPkgs = () => {
      const kind = kindSel.value;
      const list = (data.status?.packages?.[kind] || []);
      clear(pkgSel);
      for (const p of list) pkgSel.appendChild(h('option', { value: `${p.id}@${p.version}`, selected: pkg && pkg.id === p.id && pkg.version === p.version }, `${p.id} v${p.version}`));
      if (!list.length) pkgSel.appendChild(h('option', { value: '' }, '（没有可用升级包）'));
    };
    kindSel.addEventListener('change', fillPkgs);
    fillPkgs();

    const checks = rigs.map((r) => {
      const cb = h('input', { type: 'checkbox', checked: !pkg, style: { width: '17px', height: '17px', accentColor: 'var(--accent)' } });
      return { rig: r, cb, el: h('label', { class: 'flex', style: { padding: '5px 0', cursor: 'pointer', gap: '10px' } }, cb, h('span', { style: { flex: '1' } }, r.name), coinTag(r.coin), r.online ? h('span', { class: 'badge badge-ok' }, '在线') : h('span', { class: 'badge badge-muted' }, '离线')) };
    });

    body.append(
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', {}, '升级类型'), kindSel),
        h('div', { class: 'field' }, h('label', {}, '升级包'), pkgSel),
      ),
      h('div', { class: 'field' }, h('label', {}, '目标矿机（不选=全部）'),
        h('div', { style: { maxHeight: '220px', overflow: 'auto' } }, ...checks.map((c) => c.el))),
      h('div', { class: 'hint' }, '升级过程会下载→校验 sha256→原子替换→重启矿工；失败可回滚到上一版本。'),
    );
    result = openModal({
      title: '下发升级',
      wide: true,
      body,
      footer: h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => result.close() }, '取消'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const [targetId, version] = (pkgSel.value || '').split('@');
            if (!kindSel.value || !targetId) return toast('没有可用的升级包', 'err');
            const ids = checks.filter((c) => c.cb.checked).map((c) => c.rig.id);
            try {
              const r = await api.pushUpdate({ kind: kindSel.value, targetId, version, rigIds: ids });
              toast(`已下发 ${r.queued} 台矿机`, 'ok');
              result.close();
              tab = 'jobs';
              await load();
            } catch (e) { toast(e.message, 'err'); }
          },
        }, '开始升级'),
      ),
    });
  }

  // ───────── 矿机版本 ─────────
  function rigsView() {
    const rigs = data.status?.rigs || [];
    const latestAgent = data.agentVersion;
    const latestMiner = {};
    for (const p of data.status?.packages?.miner || []) {
      const cur = latestMiner[p.id];
      if (!cur || cmp(cur, p.version) < 0) latestMiner[p.id] = p.version;
    }
    const card = h('div', { class: 'card pad-0' });
    card.appendChild(h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, '矿机'), h('th', {}, '系统'), h('th', {}, '采集端'), h('th', {}, '挖矿程序'), h('th', {}, '状态'), h('th', {}, ''))),
      h('tbody', {}, ...rigs.map((r) => {
        const miners = Object.entries(r.miners || {});
        const behind = miners.filter(([id, v]) => latestMiner[id] && cmp(v, latestMiner[id]) < 0);
        const agentBehind = r.agent && cmp(r.agent, latestAgent) < 0;
        return h('tr', {},
          h('td', { style: { fontWeight: '600' } }, h('a', { href: `#/rig/${r.id}` }, r.name)),
          h('td', { class: 'dim' }, r.os || '—'),
          h('td', { class: 'mono' }, r.agent ? `v${r.agent}` : '—', agentBehind ? h('span', { class: 'badge badge-warn', style: { marginLeft: '6px' } }, '可升级') : null),
          h('td', { class: 'mono' }, miners.length ? miners.map(([id, v]) => `${id} v${v}`).join('、') : '—'),
          h('td', {}, !r.online ? h('span', { class: 'badge badge-muted' }, '离线')
            : behind.length || agentBehind ? h('span', { class: 'badge badge-warn' }, '有更新') : h('span', { class: 'badge badge-ok' }, '最新')),
          h('td', {}, h('div', { class: 'btn-row' },
            behind.length ? h('button', { class: 'btn btn-sm', onclick: () => pushTo([r.id], 'miner', behind[0][0], latestMiner[behind[0][0]]) }, '升级矿工') : null,
            agentBehind ? h('button', { class: 'btn btn-sm', onclick: () => pushAgent(r.id) }, '升级采集端') : null,
          )),
        );
      })),
    ));
    return card;
  }

  async function pushTo(ids, kind, targetId, version) {
    try {
      const r = await api.pushUpdate({ kind, targetId, version, rigIds: ids });
      toast(`已下发 ${r.queued} 台`, 'ok');
      tab = 'jobs';
      await load();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function pushAgent(rigId) {
    try {
      const r = await api.pushUpdate({ kind: 'agent', rigIds: [rigId] });
      toast(`已下发 ${r.queued} 台`, 'ok');
      tab = 'jobs';
      await load();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ───────── 升级记录 ─────────
  function jobsView() {
    const jobs = data.jobs || [];
    if (!jobs.length) return h('div', { class: 'card' }, h('div', { class: 'empty' }, h('p', {}, '还没有升级记录')));
    return h('div', { class: 'card pad-0' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, '时间'), h('th', {}, '矿机'), h('th', {}, '类型'), h('th', {}, '目标'), h('th', {}, '版本'), h('th', {}, '进度'), h('th', {}, '状态'), h('th', {}, '信息'))),
      h('tbody', {}, ...jobs.map((j) => h('tr', {},
        h('td', { class: 'dim mono', style: { fontSize: '11.5px' } }, new Date(j.created_at).toLocaleString('zh-CN', { hour12: false })),
        h('td', {}, j.rig_name || '—'),
        h('td', {}, KIND_LABEL[j.kind] || j.kind),
        h('td', { class: 'mono' }, j.target_id || '—'),
        h('td', { class: 'mono dim' }, j.from_version ? `${j.from_version} → ${j.to_version}` : j.to_version || '—'),
        h('td', { style: { minWidth: '120px' } }, h('div', { class: 'bar' }, h('i', { style: { width: `${j.progress || 0}%` } })),
          h('span', { class: 'dim', style: { fontSize: '11px' } }, `${j.progress || 0}%`)),
        h('td', {}, jobBadge(j.status)),
        h('td', { class: 'dim', style: { fontSize: '12px', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis' } }, j.message || ''),
      ))),
    ));
  }

  function jobBadge(s) {
    if (s === 'ok') return h('span', { class: 'badge badge-ok' }, '成功');
    if (s === 'error') return h('span', { class: 'badge badge-danger' }, '失败');
    if (s === 'running') return h('span', { class: 'badge badge-info' }, '进行中');
    return h('span', { class: 'badge badge-muted' }, '等待中');
  }

  // ───────── 制作升级包 ─────────
  function howtoView() {
    return h('div', { class: 'card' },
      h('div', { class: 'card-title mb-14' }, '如何制作升级包'),
      h('p', { class: 'muted', style: { fontSize: '13px', marginTop: 0 } },
        '把新版挖矿程序打包成 tar.gz，上传后在「升级包」页一键下发；采集端会校验、原子替换并重启矿工，旧版本保留可回滚。'),
      h('div', { class: 'logview' },
        `# 1. 打包矿工（Windows 版）\n` +
        `mkdir -p pkg/xmrig-6.26\n` +
        `cp xmrig.exe pkg/xmrig-6.26/\n` +
        `tar -czf xmrig-6.26-win64.tar.gz -C pkg xmrig-6.26\n\n` +
        `# 2. 上传时填写：\n` +
        `#   类型=挖矿程序  名称=xmrig  版本=6.26.0  平台=win32\n\n` +
        `# 3. Linux 版同理，平台选 linux\n` +
        `# 4. 采集端自升级：类型=采集端 名称=agent 平台=linux/win32\n` +
        `#    包内容需包含 agent/ 与 shared/ 目录\n\n` +
        `# 5. 系统组件（如驱动）：包内放 install.sh / install.ps1\n` +
        `#    脚本可用环境变量：MM_PACKAGE_DIR / MM_BACKUP_DIR / MM_VERSION`),
      h('div', { class: 'hint mt-14' }, '也可以用命令行直接传到 upgrades 目录：updates/miner/<id>/<version>/<file>.tar.gz + manifest.json'),
    );
  }

  // ───────── 上传 ─────────
  function uploadDialog() {
    if (uploading) return;
    const kind = h('select', { class: 'select' }, h('option', { value: 'miner' }, '挖矿程序'), h('option', { value: 'agent' }, '采集端'), h('option', { value: 'system' }, '系统组件'));
    const id = h('input', { class: 'input', placeholder: '例如 xmrig / peakminer / agent', value: 'xmrig' });
    const version = h('input', { class: 'input', placeholder: '例如 6.26.0' });
    const platform = h('select', { class: 'select' }, h('option', { value: 'win32' }, 'Windows'), h('option', { value: 'linux' }, 'Linux'), h('option', { value: 'any' }, '通用'));
    const notes = h('textarea', { class: 'textarea', rows: 2, placeholder: '更新说明（可选）' });
    const file = h('input', { type: 'file', accept: '.tar.gz,.tgz,.zip', style: { display: 'none' } });
    const fileLabel = h('div', { class: 'logview', style: { maxHeight: '60px' } }, '未选择文件');
    const pick = h('button', { class: 'btn', onclick: () => file.click() }, '选择文件');
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (!f) return;
      fileLabel.textContent = `${f.name}（${fmtNum(f.size / 1024 / 1024, 1)} MB）`;
      if (!version.value) {
        const m = f.name.match(/(\d+\.\d+(?:\.\d+)?)/);
        if (m) version.value = m[1];
      }
    });
    const bar = h('div', { class: 'bar', style: { marginTop: '8px', display: 'none' } }, h('i', { style: { width: '0%' } }));
    const progress = (...children) => h('div', { style: { marginTop: '8px' } }, ...children);
    const body = h('div', {},
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', {}, '类型'), kind),
        h('div', { class: 'field' }, h('label', {}, '名称 / ID'), id),
      ),
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', {}, '版本号'), version),
        h('div', { class: 'field' }, h('label', {}, '平台'), platform),
      ),
      h('div', { class: 'field' }, h('label', {}, '升级包（.tar.gz / .zip）'), pick, fileLabel),
      h('div', { class: 'field' }, h('label', {}, '更新说明'), notes),
      bar,
    );
    const modal = openModal({
      title: '上传升级包',
      wide: true,
      body,
      footer: h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => modal.close() }, '取消'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async (e) => {
            const f = file.files?.[0];
            if (!f) return toast('请选择文件', 'err');
            if (!version.value.trim()) return toast('请填写版本号', 'err');
            const btn = e.target;
            btn.disabled = true;
            uploading = true;
            bar.style.display = '';
            const fd = new FormData();
            fd.append('kind', kind.value);
            fd.append('id', id.value.trim());
            fd.append('version', version.value.trim());
            fd.append('platform', platform.value);
            fd.append('notes', notes.value);
            fd.append('file', f, f.name);
            try {
              const xhr = new XMLHttpRequest();
              xhr.open('POST', '/api/updates/upload');
              xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) bar.firstChild.style.width = `${Math.round((ev.loaded / ev.total) * 100)}%`; };
              await new Promise((resolve, reject) => {
                xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(JSON.parse(xhr.responseText || '{}').error || `HTTP ${xhr.status}`)));
                xhr.onerror = () => reject(new Error('上传失败'));
                xhr.send(fd);
              });
              toast('上传成功', 'ok');
              modal.close();
              await load();
            } catch (err) {
              toast(err.message, 'err');
            } finally {
              btn.disabled = false;
              uploading = false;
            }
          },
        }, '上传'),
      ),
    });
  }

  const unsub = realtime.on('update.progress', () => {
    if (tab !== 'jobs') return;
    load().catch(() => {});
  });
  load().catch((e) => {
    clear(el);
    el.appendChild(h('div', { class: 'empty' }, h('p', {}, `加载失败：${e.message}`)));
  });
  return () => unsub();
}

function cmp(a, b) {
  const pa = String(a || '0').split(/[.\-+]/).map((x) => Number(x) || 0);
  const pb = String(b || '0').split(/[.\-+]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
