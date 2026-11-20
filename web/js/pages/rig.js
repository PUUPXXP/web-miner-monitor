// 矿机详情页
import {
  h, clear, fmtHash, fmtPower, fmtTemp, tempClass, fmtAgo, fmtNum, fmtDuration, fmtTime,
  statusBadge, coinTag,
} from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { realtime, toast } from '../realtime.js';
import { LineChart } from '../chart.js';
import { openModal, confirmDialog, formDialog } from '../components.js';

export function RigPage(root, { params }) {
  const rigId = params[0];
  let detail = null;
  let hours = 6;
  let gpuCharts = [];
  let tab = 'monitor';
  let pollTimer = null;
  const el = h('div');
  root.appendChild(el);
  const unsub = [];

  async function load() {
    try {
      detail = await api.rig(id());
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  const id = () => rigId;

  function render() {
    if (!detail) {
      clear(el);
      el.appendChild(h('div', { class: 'skeleton', style: { height: '200px' } }));
      return;
    }
    const rig = store.get().rigMap.get(rigId) || detail.rig;
    clear(el);
    el.appendChild(header(rig));
    if (tab === 'monitor') el.appendChild(monitorTab(rig));
    else if (tab === 'history') el.appendChild(historyTab(rig));
    else if (tab === 'settings') el.appendChild(settingsTab(rig));
    else if (tab === 'events') el.appendChild(eventsTab(rig));
    else if (tab === 'install') el.appendChild(installTab(rig));
  }

  function header(rig) {
    const back = h('a', { href: '#/rigs', class: 'btn btn-sm', style: { alignSelf: 'flex-start' } }, '← 返回');
    const actions = h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-sm', onclick: () => cmd('start') }, '▶ 启动'),
      h('button', { class: 'btn btn-sm', onclick: () => cmd('stop') }, '■ 停止'),
      h('button', { class: 'btn btn-sm', onclick: () => cmd('restart') }, '↻ 重启矿工'),
      h('button', { class: 'btn btn-sm', onclick: () => cmd('reboot') }, '⏻ 重启矿机'),
      h('button', { class: 'btn btn-sm', onclick: () => cmd('sync_config') }, '⟳ 同步配置'),
      h('button', { class: 'btn btn-primary btn-sm', onclick: () => editRig(rig) }, '编辑'),
    );
    const tabs = [['monitor', '监控'], ['history', '历史曲线'], ['settings', '设置'], ['events', '事件'], ['install', '安装']];
    return h('div', { class: 'card mb-20', style: { padding: '18px 20px' } },
      h('div', { class: 'flex', style: { gap: '14px', alignItems: 'flex-start', flexWrap: 'wrap' } },
        h('div', { style: { flex: '1', minWidth: '260px' } },
          h('div', { class: 'flex', style: { gap: '10px' } },
            h('span', { class: `dot ${rig.online ? 'online pulse' : 'offline'}`, style: { marginTop: '6px' } }),
            h('h2', { style: { margin: 0, fontSize: '22px' } }, rig.name),
            statusBadge(rig),
            coinTag(rig.coin),
          ),
          h('div', { class: 'flex', style: { gap: '14px', marginTop: '6px', flexWrap: 'wrap', fontSize: '12.5px', color: 'var(--text-3)' } },
            h('span', {}, `分组：${rig.group_name || '—'}`),
            h('span', {}, `IP：${rig.agent_ip || '—'}`),
            h('span', {}, `采集端：v${rig.agent_version || '—'}`),
            h('span', {}, `最后心跳：${fmtAgo(rig.last_seen)}`),
            h('span', {}, `运行：${fmtDuration(rig.uptime_sec || 0)}`),
          ),
          h('div', { class: 'flex', style: { gap: '18px', marginTop: '12px', flexWrap: 'wrap' } },
            miniStat('算力', fmtHash(rig.total_hashrate || 0)),
            miniStat('功耗', fmtPower(rig.power_w)),
            miniStat('最高温度', fmtTemp(rig.temp_max), tempClass(rig.temp_max)),
            miniStat('GPU', String(rig.gpu_count || 0)),
            miniStat('接受 / 拒绝', `${fmtNum(rig.accepted, 0)} / ${fmtNum(rig.rejected, 0)}`),
            miniStat('看门狗重启', String(rig.watchdog_restarts || 0)),
          ),
        ),
        actions,
      ),
      h('div', { class: 'tabs', style: { marginTop: '16px', marginBottom: 0 } },
        ...tabs.map(([k, label]) => h('div', { class: `tab ${tab === k ? 'active' : ''}`, onclick: () => { tab = k; render(); } }, label)),
      ),
    );
  }

  function miniStat(label, value, cls = '') {
    return h('div', { class: 'flex-col', style: { gap: '0' } },
      h('span', { style: { fontSize: '11px', color: 'var(--text-3)' } }, label),
      h('span', { class: `mono ${cls}`, style: { fontSize: '15px', fontWeight: '600' } }, value),
    );
  }

  // ───────── 监控 ─────────
  function monitorTab(rig) {
    const live = rig.live || detail?.rig?.live || {};
    const gpus = live.gpus || [];
    const miner = live.miner || {};
    const sys = live.system || {};
    const wrap = h('div', { class: 'detail-grid' });
    const left = h('div', {});
    const right = h('div', { class: 'flex-col', style: { gap: '16px' } });

    // GPU 卡
    if (gpus.length) {
      left.appendChild(h('div', { class: 'rig-grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' } },
        ...gpus.map(gpuCard)));
    } else {
      left.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty', style: { padding: '30px' } },
        h('h3', {}, '暂无 GPU 数据'),
        h('p', {}, rig.online ? '采集端尚未上报 GPU（检查 nvidia-smi 是否可用）' : '矿机离线，等待采集端上线。'),
      )));
    }

    // 右侧：矿工信息
    right.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '矿工'),
      h('div', { class: 'kv mt-8' },
        h('span', { class: 'k' }, '状态'), h('span', { class: 'v' }, statusBadge(rig)),
        h('span', { class: 'k' }, '矿工'), h('span', { class: 'v' }, rig.miner_name || miner.name || '—'),
        h('span', { class: 'k' }, '算法'), h('span', { class: 'v' }, miner.algo || '—'),
        h('span', { class: 'k' }, '矿池'), h('span', { class: 'v ellipsis', title: rig.pool_url || '' }, rig.pool_url || miner.pool || '—'),
        h('span', { class: 'k' }, '算力'), h('span', { class: 'v' }, fmtHash(rig.total_hashrate || 0)),
        h('span', { class: 'k' }, '矿工运行'), h('span', { class: 'v' }, miner.uptimeSec ? fmtDuration(miner.uptimeSec) : '—'),
        h('span', { class: 'k' }, 'PID'), h('span', { class: 'v' }, miner.pid || '—'),
        h('span', { class: 'k' }, '最近错误'), h('span', { class: 'v', style: { color: miner.lastError ? 'var(--danger)' : 'var(--text-3)' } }, miner.lastError || '无'),
      ),
      h('div', { class: 'btn-row mt-14' },
        h('button', { class: 'btn btn-sm', onclick: () => cmd('restart') }, '重启矿工'),
        h('button', { class: 'btn btn-sm', onclick: () => cmd('apply_oc') }, '应用超频'),
        h('button', { class: 'btn btn-danger btn-sm', onclick: () => cmd('stop') }, '停止'),
      ),
    ));

    // 系统信息
    right.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '系统'),
      h('div', { class: 'kv mt-8' },
        h('span', { class: 'k' }, '操作系统'), h('span', { class: 'v ellipsis' }, sys.os || rig.os_info || '—'),
        h('span', { class: 'k' }, 'CPU'), h('span', { class: 'v ellipsis', title: sys.cpu || '' }, sys.cpu || rig.cpu_name || '—'),
        h('span', { class: 'k' }, 'CPU 占用'), h('span', { class: 'v' }, sys.cpuLoad != null ? `${sys.cpuLoad}%` : '—'),
        h('span', { class: 'k' }, '内存'), h('span', { class: 'v' }, sys.memUsedMb ? `${(sys.memUsedMb / 1024).toFixed(1)} / ${(sys.memTotalMb / 1024).toFixed(1)} GB` : '—'),
        h('span', { class: 'k' }, '磁盘'), h('span', { class: 'v' }, sys.diskFreeGb != null ? `剩余 ${sys.diskFreeGb} / ${sys.diskTotalGb} GB` : '—'),
        h('span', { class: 'k' }, '开机时长'), h('span', { class: 'v' }, sys.uptimeSec ? fmtDuration(sys.uptimeSec) : '—'),
      ),
    ));

    // 看门狗
    const wd = live.watchdog || {};
    right.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '看门狗'),
      h('div', { class: 'kv mt-8' },
        h('span', { class: 'k' }, '状态'), h('span', { class: 'v' }, wdState(wd.state)),
        h('span', { class: 'k' }, '累计重启'), h('span', { class: 'v' }, String(wd.restarts || 0)),
        h('span', { class: 'k' }, '最近重启'), h('span', { class: 'v' }, wd.lastRestartAt ? fmtAgo(wd.lastRestartAt) : '—'),
        h('span', { class: 'k' }, '原因'), h('span', { class: 'v' }, wd.reason || '—'),
      ),
    ));

    wrap.append(left, right);
    // 日志
    if (live.logs?.length) {
      wrap.appendChild(h('div', { class: 'card', style: { gridColumn: '1 / -1' } },
        h('div', { class: 'card-title' }, '矿工日志（最近 40 行）'),
        h('div', { class: 'logview mt-8' }, ...live.logs.map((l) => h('div', { class: logClass(l) }, l))),
      ));
    }
    return wrap;
  }

  function gpuCard(g) {
    const hash = fmtHash(g.hashrate || 0).split(' ');
    return h('div', { class: 'card' },
      h('div', { class: 'flex-between' },
        h('div', { style: { fontWeight: '650' } }, `GPU ${g.index}`),
        h('span', { class: 'badge badge-muted' }, g.vendor === 'amd' ? 'AMD' : 'NVIDIA'),
      ),
      h('div', { class: 'dim ellipsis', style: { fontSize: '12px', marginTop: '2px' }, title: g.name }, g.name),
      h('div', { class: 'flex', style: { alignItems: 'baseline', gap: '6px', margin: '10px 0 4px' } },
        h('span', { class: 'mono', style: { fontSize: '21px', fontWeight: '700' } }, hash[0]),
        h('span', { class: 'dim', style: { fontSize: '11px' } }, hash[1] || 'H/s'),
      ),
      h('div', { class: 'flex', style: { gap: '14px', flexWrap: 'wrap', marginTop: '8px', fontSize: '12.5px' } },
        h('span', { class: tempClass(g.temp) }, `🌡 ${g.temp != null ? Math.round(g.temp) + '°C' : '—'}`),
        h('span', {}, `⚡ ${g.power != null ? Math.round(g.power) + 'W' : '—'}`),
        h('span', {}, `🌀 ${g.fan != null ? Math.round(g.fan) + '%' : '—'}`),
        h('span', {}, `📈 ${g.util != null ? Math.round(g.util) + '%' : '—'}`),
      ),
      g.memTotal ? h('div', { class: 'mt-8' },
        h('div', { class: 'flex-between', style: { fontSize: '11px', color: 'var(--text-3)' } },
          h('span', {}, '显存'), h('span', { class: 'mono' }, `${((g.memUsed || 0) / 1024).toFixed(1)} / ${(g.memTotal / 1024).toFixed(1)} GB`)),
        h('div', { class: 'bar mt-8' }, h('i', { style: { width: `${Math.min(100, ((g.memUsed || 0) / g.memTotal) * 100)}%` } })),
      ) : null,
      h('div', { class: 'flex', style: { gap: '12px', marginTop: '10px', fontSize: '11px', color: 'var(--text-3)', fontFamily: 'var(--mono)' } },
        h('span', {}, `核 ${g.clockCore || '—'} MHz`),
        h('span', {}, `显 ${g.clockMem || '—'} MHz`),
        g.pstate != null ? h('span', {}, `P${g.pstate}`) : null,
      ),
    );
  }

  // ───────── 历史 ─────────
  function historyTab(rig) {
    const wrap = h('div', {});
    const head = h('div', { class: 'card-title mb-14' },
      h('span', {}, '历史曲线'),
      h('div', { class: 'spacer' }),
      ...[['6 小时', 6], ['24 小时', 24], ['7 天', 168]].map(([label, hrs]) =>
        h('button', { class: `btn btn-sm ${hours === hrs ? 'btn-primary' : ''}`, onclick: () => { hours = hrs; render(); } }, label)),
    );
    wrap.appendChild(head);
    const container = h('div', { class: 'flex-col', style: { gap: '16px' } });
    wrap.appendChild(container);
    setTimeout(async () => {
      gpuCharts.forEach((c) => c.destroy());
      gpuCharts = [];
      clear(container);
      try {
        const data = await api.rigHistory(rigId, hours);
        const total = data.serie || [];
        const c1 = h('div', { class: 'card' });
        c1.appendChild(h('div', { class: 'card-title' }, '整机算力 / 功耗'));
        const box = h('div');
        c1.appendChild(box);
        container.appendChild(c1);
        gpuCharts.push(new LineChart(box, {
          height: 220,
          series: [
            { key: 'hashrate', label: '算力', color: '#7c5cff', unit: ' H/s' },
            { key: 'power', label: '功耗', color: '#ffb020', unit: ' W', yAxis: 1 },
          ],
          yAxes: 2,
          points: total,
        }));
        for (const gpu of data.gpus || []) {
          const card = h('div', { class: 'card' });
          card.appendChild(h('div', { class: 'card-title' }, `GPU ${gpu.index} · ${gpu.name}`));
          const holder = h('div', { class: 'mt-8' });
          card.appendChild(holder);
          container.appendChild(card);
          gpuCharts.push(new LineChart(holder, {
            height: 190,
            series: [
              { key: 'hashrate', label: '算力', color: '#2ee6c8', unit: ' H/s' },
              { key: 'temp', label: '温度', color: '#ff7a18', unit: ' °C', yAxis: 1 },
              { key: 'fan', label: '风扇', color: '#38bdf8', unit: ' %' , yAxis: 1 },
            ],
            yAxes: 2,
            points: gpu.points,
          }));
        }
        if (!total.length && !(data.gpus || []).length) {
          container.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty', style: { padding: '30px' } }, h('p', {}, '暂无历史数据（运行一段时间后自动生成）'))));
        }
      } catch (e) {
        container.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' }, h('p', {}, `加载失败：${e.message}`))));
      }
    }, 0);
    return wrap;
  }

  // ───────── 设置 ─────────
  function settingsTab(rig) {
    const wrap = h('div', { class: 'detail-grid' });
    const form = h('div', { class: 'card' });
    form.appendChild(h('div', { class: 'card-title' }, '矿机设置'));
    const name = input('名称', rig.name);
    const group = input('分组', rig.group_name || '默认分组');
    const note = textarea('备注', rig.note || '');
    const enabled = checkbox('启用自动挖矿', rig.enabled);
    const maintenance = checkbox('维护模式（停止矿工并暂停告警）', rig.maintenance);
    const sheetSel = h('select', { class: 'select' }, h('option', { value: '' }, '不分配飞行表'));
    form.append(
      field('矿机名称', name), field('分组', group), field('备注', note),
      field('飞行表', sheetSel, '分配后采集端会自动应用对应矿工与矿池配置'),
      h('div', { class: 'flex', style: { gap: '18px', margin: '6px 0 16px' } }, labelWrap(enabled[0], enabled[1]), labelWrap(maintenance[0], maintenance[1])),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              await api.updateRig(rig.id, {
                name: name[1].value.trim(), group: group[1].value.trim(), note: note[1].value,
                enabled: enabled[0].checked, maintenance: maintenance[0].checked,
                flightSheetId: sheetSel.value || null,
              });
              toast('已保存', 'ok');
              await load();
            } catch (e) { toast(e.message, 'err'); }
          },
        }, '保存设置'),
        h('button', { class: 'btn btn-danger', onclick: () => deleteRig(rig) }, '删除矿机'),
      ),
    );
    setTimeout(async () => {
      try {
        const { flightSheets } = await api.flightSheets();
        for (const s of flightSheets) sheetSel.appendChild(h('option', { value: s.id, selected: s.id === rig.flight_sheet_id }, `${s.name} (${s.coin})`));
      } catch { /* ignore */ }
    }, 0);
    wrap.appendChild(form);

    const side = h('div', { class: 'flex-col', style: { gap: '16px' } });
    side.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '连接信息'),
      h('div', { class: 'kv mt-8' },
        h('span', { class: 'k' }, '矿机 ID'), h('span', { class: 'v' }, rig.id),
        h('span', { class: 'k' }, '接入密钥'), h('span', { class: 'v' }, rig.hasToken ? '已生成（重置后需重新安装）' : '—'),
        h('span', { class: 'k' }, '采集端版本'), h('span', { class: 'v' }, rig.agent_version || '—'),
        h('span', { class: 'k' }, '指纹'), h('span', { class: 'v ellipsis' }, rig.fingerprint || '未绑定'),
      ),
      h('div', { class: 'btn-row mt-14' },
        h('button', {
          class: 'btn btn-sm',
          onclick: async () => {
            const ok = await confirmDialog({ title: '重置密钥', message: '重置后旧采集端将无法上报，需要用新密钥重新部署。确定继续？', okText: '重置' });
            if (!ok) return;
            try {
              const r = await api.rotateToken(rig.id);
              toast(`新密钥：${r.token}`, 'ok', 12000);
              await load();
            } catch (e) { toast(e.message, 'err'); }
          },
        }, '重置密钥'),
        h('button', { class: 'btn btn-sm', onclick: () => { tab = 'install'; render(); } }, '安装采集端'),
      ),
    ));
    wrap.appendChild(side);
    return wrap;
  }

  // ───────── 事件 ─────────
  function eventsTab(rig) {
    const wrap = h('div', { class: 'card' });
    wrap.appendChild(h('div', { class: 'card-title mb-14' }, '事件与命令记录'));
    const timeline = h('div', { class: 'timeline' });
    const items = [
      ...(detail?.events || []).map((e) => ({ ts: e.ts, level: e.level, text: e.message })),
      ...(detail?.commands || []).map((c) => ({ ts: c.created_at, level: c.status === 'ok' ? 'info' : c.status === 'error' ? 'error' : 'warn', text: `命令 ${c.type}：${c.status}${c.result ? ' · ' + c.result : ''}` })),
    ].sort((a, b) => b.ts - a.ts).slice(0, 80);
    if (!items.length) wrap.appendChild(h('div', { class: 'empty' }, h('p', {}, '暂无记录')));
    for (const it of items) {
      timeline.appendChild(h('div', { class: `timeline-item ${it.level}` },
        h('span', { class: 'time' }, fmtTime(it.ts, false)),
        h('span', { class: 'rail' }),
        h('span', {}, it.text),
      ));
    }
    wrap.appendChild(timeline);
    return wrap;
  }

  // ───────── 安装 ─────────
  function installTab(rig) {
    const wrap = h('div', { class: 'card' });
    wrap.appendChild(h('div', { class: 'card-title' }, '安装 / 重新部署采集端'));
    wrap.appendChild(h('p', { class: 'muted', style: { fontSize: '13px' } },
      '在矿机上以管理员身份打开 PowerShell，执行下面的命令。脚本会自动下载采集端、写入配置并注册开机自启计划任务。'));
    const pre = h('div', { class: 'logview', style: { maxHeight: '340px' } }, '加载中…');
    wrap.appendChild(pre);
    wrap.appendChild(h('div', { class: 'btn-row mt-14' },
      h('button', { class: 'btn', onclick: () => { navigator.clipboard?.writeText(pre.textContent); toast('已复制', 'ok'); } }, '复制命令'),
      h('a', { class: 'btn', href: `/api/rigs/${rig.id}/install`, download: '' }, '下载 .ps1'),
      h('button', { class: 'btn btn-primary', onclick: () => cmd('update_agent') }, '远程更新采集端'),
    ));
    setTimeout(async () => {
      try {
        const r = await fetch(`/api/rigs/${rig.id}/install`);
        pre.textContent = await r.text();
      } catch { pre.textContent = '生成失败'; }
    }, 0);
    return wrap;
  }

  async function cmd(type) {
    const needConfirm = ['reboot', 'shutdown'].includes(type);
    if (needConfirm) {
      const ok = await confirmDialog({ title: '确认', message: `确定要${type === 'reboot' ? '重启矿机' : '关闭矿机'}吗？`, okText: '执行', danger: true });
      if (!ok) return;
    }
    try {
      const r = await api.command(rigId, type);
      toast(`命令已发送${r.status === 'queued' ? '（离线，排队中）' : ''}`, 'ok');
      setTimeout(load, 2500);
    } catch (e) { toast(e.message, 'err'); }
  }

  async function editRig(rig) {
    tab = 'settings';
    render();
  }

  async function deleteRig(rig) {
    const ok = await confirmDialog({ title: '删除矿机', message: `确定删除「${rig.name}」？历史数据将一并清除。`, okText: '删除' });
    if (!ok) return;
    try {
      await api.deleteRig(rig.id);
      toast('已删除', 'ok');
      location.hash = '#/rigs';
    } catch (e) { toast(e.message, 'err'); }
  }

  unsub.push(realtime.on('rig', (r) => {
    if (r.id !== rigId) return;
    if (detail?.rig) detail.rig = { ...detail.rig, ...r };
    render();
  }));
  unsub.push(realtime.on('command', (c) => {
    if (c.rigId !== rigId) return;
    toast(`命令${c.status === 'ok' ? '成功' : '失败'}${c.output ? '：' + c.output : ''}`, c.status === 'ok' ? 'ok' : 'err');
    load();
  }));

  load();
  pollTimer = setInterval(() => { if (!store.get().realtime) load(); }, 15_000);
  return () => { unsub.forEach((f) => f()); clearInterval(pollTimer); gpuCharts.forEach((c) => c.destroy()); };
}

// 小工具
function input(label, value) {
  const el = h('input', { class: 'input', value: value || '' });
  return [label, el];
}
function textarea(label, value) {
  const el = h('textarea', { class: 'textarea', rows: 3 });
  el.value = value || '';
  return [label, el];
}
function checkbox(label, checked) {
  return [h('input', { type: 'checkbox', checked: !!checked, style: { width: '18px', height: '18px', accentColor: 'var(--accent)' } }), label];
}
function field(label, pair, hint) {
  const inp = Array.isArray(pair) ? pair[1] : pair;
  return h('div', { class: 'field' }, h('label', {}, label), inp, hint ? h('div', { class: 'hint' }, hint) : null);
}
function labelWrap(inputEl, label) {
  return h('label', { class: 'flex', style: { gap: '8px', cursor: 'pointer', fontSize: '13px' } }, inputEl, label);
}
function wdState(s) {
  return { idle: '待机', ok: '正常监控', hot: '过热保护', restarting: '正在重启', blocked: '已暂停（重启过频）', disabled: '已禁用' }[s] || s || '—';
}
function logClass(line) {
  if (/\[error\]|error|fail|denied/i.test(line)) return 'error';
  if (/\[warn\]|warn/i.test(line)) return 'warn';
  return '';
}
