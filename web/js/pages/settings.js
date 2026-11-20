// 设置页：面板 / 采集端 / 通知 / 安全 / 数据
import { h, clear, fmtTime, fmtNum, fmtDuration, download } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { toast } from '../realtime.js';
import { pageHeader, confirmDialog, formDialog } from '../components.js';

export function SettingsPage(root) {
  const el = h('div');
  root.appendChild(el);
  let settings = null;
  let server = null;

  async function load() {
    const [s, srv] = await Promise.all([api.settings(), api.server().catch(() => null)]);
    settings = normalizeSettings(s.settings || {});
    server = srv;
    render();
  }

  function normalizeSettings(s) {
    const n = s.notifications || {};
    return {
      ...s,
      agentAutoRegister: s.agentAutoRegister !== false,
      heartbeatSec: s.heartbeatSec ?? 5,
      offlineAfterSec: s.offlineAfterSec ?? 45,
      siteName: s.siteName || '矿机监控中心',
      publicUrl: s.publicUrl || '',
      notifications: {
        telegram: { botToken: n.telegram?.botToken || '', chatId: n.telegram?.chatId || '' },
        discord: { webhookUrl: n.discord?.webhookUrl || '' },
        webhook: { url: n.webhook?.url || '' },
      },
    };
  }

  function render() {
    clear(el);
    el.appendChild(pageHeader('设置', '面板、采集端、通知与安全'));
    const s = settings;
    const general = section('基础设置', [
      field('面板名称', input(s.siteName, (v) => { s.siteName = v; })),
      field('服务器公网地址', input(s.publicUrl, (v) => { s.publicUrl = v; }), '用于生成矿机安装脚本；留空则用当前访问地址'),
    ]);
    const agent = section('采集端', [
      toggle('允许采集端自动注册', s.agentAutoRegister, (v) => { s.agentAutoRegister = v; }, '开启后新矿机部署后自动出现在列表（推荐）'),
      field('心跳间隔（秒）', numberInput(s.heartbeatSec, (v) => { s.heartbeatSec = v; }), '采集端上报遥测的频率，默认 5 秒'),
      field('离线判定（秒）', numberInput(s.offlineAfterSec, (v) => { s.offlineAfterSec = v; }), '超过该时间未心跳视为离线'),
    ]);
    const notif = section('通知', [
      subTitle('Telegram'),
      h('div', { class: 'grid-2' },
        field('Bot Token', input(s.notifications?.telegram?.botToken || '', (v) => { s.notifications.telegram.botToken = v; }), '从 @BotFather 获取'),
        field('Chat ID', input(s.notifications?.telegram?.chatId || '', (v) => { s.notifications.telegram.chatId = v; })),
      ),
      subTitle('Discord'),
      field('Webhook URL', input(s.notifications?.discord?.webhookUrl || '', (v) => { s.notifications.discord.webhookUrl = v; })),
      subTitle('通用 Webhook'),
      field('URL', input(s.notifications?.webhook?.url || '', (v) => { s.notifications.webhook.url = v; }), 'POST JSON：{message, rule, rig, value, severity}'),
      h('div', { class: 'btn-row mt-8' },
        ...['telegram', 'discord', 'webhook'].map((c) => h('button', {
          class: 'btn btn-sm',
          onclick: async (e) => {
            const label = { telegram: 'Telegram', discord: 'Discord', webhook: 'Webhook' }[c];
            e.target.disabled = true;
            try { await api.testNotification(c); toast(`${label} 测试成功`, 'ok'); } catch (err) { toast(err.message, 'err'); }
            e.target.disabled = false;
          },
        }, `测试 ${c === 'telegram' ? 'Telegram' : c === 'discord' ? 'Discord' : 'Webhook'}`)),
      ),
    ]);
    const security = section('安全', [
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: changePassword }, '修改管理员密码'),
      ),
      h('div', { class: 'hint mt-8' }, '提示：服务器建议放在内网或使用反向代理 + HTTPS；矿机密钥泄露后可在矿机详情页重置。'),
    ]);
    const dataCard = section('数据与备份', [
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: backup }, '导出备份 JSON'),
        h('button', { class: 'btn', onclick: restore }, '从备份恢复'),
      ),
      h('div', { class: 'hint mt-8' }, '备份包含矿机列表、飞行表、钱包、告警规则与设置（包含密钥，请妥善保管）。'),
    ]);
    const about = section('关于', [
      h('div', { class: 'kv' },
        h('span', { class: 'k' }, '版本'), h('span', { class: 'v' }, `v${server?.version || '1.0.0'}`),
        h('span', { class: 'k' }, 'Node.js'), h('span', { class: 'v' }, server?.node || '—'),
        h('span', { class: 'k' }, '服务器运行'), h('span', { class: 'v' }, server ? fmtDuration(server.uptimeSec) : '—'),
        h('span', { class: 'k' }, '内存占用'), h('span', { class: 'v' }, server ? `${server.memoryMb} MB` : '—'),
        h('span', { class: 'k' }, '数据库大小'), h('span', { class: 'v' }, server?.dbSizeMb != null ? `${server.dbSizeMb} MB` : '—'),
        h('span', { class: 'k' }, '矿机数量'), h('span', { class: 'v' }, server ? `${server.rigs}` : '—'),
      ),
    ]);
    el.append(general, agent, notif, security, dataCard, about);

    // 保存按钮固定在顶部
    el.prepend(h('div', { class: 'flex-between mb-14' },
      h('div', { class: 'dim', style: { fontSize: '12.5px' } }, '修改后点击右侧保存'),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn btn-primary',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const r = await api.saveSettings(settings);
              settings = r.settings;
              toast('设置已保存', 'ok');
            } catch (err) { toast(err.message, 'err'); }
            e.target.disabled = false;
          },
        }, '保存设置'),
      ),
    ));

    function section(title, children) {
      return h('div', { class: 'card settings-section' },
        h('div', { class: 'card-title mb-14' }, title),
        ...children,
      );
    }
    function subTitle(t) {
      return h('div', { style: { fontWeight: '600', fontSize: '12.5px', color: 'var(--text-2)', margin: '4px 0 8px' } }, t);
    }
    function field(label, inp, hint) {
      return h('div', { class: 'field' }, h('label', {}, label), inp, hint ? h('div', { class: 'hint' }, hint) : null);
    }
    function input(value, set) {
      const i = h('input', { class: 'input', value: value ?? '', oninput: (e) => set(e.target.value) });
      return i;
    }
    function numberInput(value, set) {
      return h('input', { class: 'input', type: 'number', value: value ?? '', oninput: (e) => set(Number(e.target.value) || 0) });
    }
    function toggle(label, value, set, hint) {
      const cb = h('input', { type: 'checkbox', checked: !!value, style: { width: '18px', height: '18px', accentColor: 'var(--accent)' }, onchange: (e) => set(e.target.checked) });
      return h('div', { class: 'field' },
        h('label', { class: 'flex', style: { gap: '9px', cursor: 'pointer' } }, cb, label),
        hint ? h('div', { class: 'hint' }, hint) : null,
      );
    }
  }

  async function changePassword() {
    const values = await formDialog({
      title: '修改管理员密码',
      fields: [
        { name: 'oldPassword', label: '当前密码', type: 'password', required: true },
        { name: 'newPassword', label: '新密码（至少 8 位）', type: 'password', required: true },
        { name: 'confirm', label: '确认新密码', type: 'password', required: true },
      ],
      onSubmit: async (v) => {
        if (v.newPassword !== v.confirm) throw new Error('两次输入的新密码不一致');
        if (v.newPassword.length < 8) throw new Error('新密码至少 8 位');
        await api.changePassword(v.oldPassword, v.newPassword);
        toast('密码已修改', 'ok');
      },
    });
  }

  async function backup() {
    try {
      const data = await api.backup();
      download(`miner-monitor-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
      toast('备份已导出', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  function restore() {
    const file = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      const ok = await confirmDialog({ title: '恢复备份', message: '将把备份中的矿机导入当前系统（同名矿机会跳过）。继续？', okText: '导入' });
      if (!ok) return;
      try {
        const text = await f.text();
        const data = JSON.parse(text);
        const r = await api.restore(data);
        toast(`已恢复 ${r.restored} 台矿机`, 'ok');
        const { rigs } = await api.rigs();
        store.setRigs(rigs);
      } catch (e) { toast(`恢复失败：${e.message}`, 'err'); }
    });
    document.body.appendChild(file);
    file.click();
    setTimeout(() => file.remove(), 1000);
  }

  load().catch((e) => {
    clear(el);
    el.appendChild(h('div', { class: 'empty' }, h('p', {}, `加载失败：${e.message}`)));
  });
  return () => {};
}
