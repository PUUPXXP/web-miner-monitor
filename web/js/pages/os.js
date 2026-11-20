// MinerOS 系统镜像页面
import { h, clear, fmtAgo, fmtNum, coinTag, statusBadge } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { toast } from '../realtime.js';
import { pageHeader, openModal } from '../components.js';

export function OsPage(root) {
  const el = h('div');
  root.appendChild(el);
  let data = null;

  async function load() {
    data = await api.os();
    render();
  }

  function render() {
    if (!data) {
      clear(el);
      el.appendChild(h('div', { class: 'skeleton', style: { height: '200px' } }));
      return;
    }
    clear(el);
    el.appendChild(pageHeader('MinerOS 系统镜像', '可装到 U 盘、像 Hive OS 一样即插即跑的矿机 Linux', [
      h('button', { class: 'btn btn-sm', onclick: load }, '↻ 刷新'),
      h('a', { class: 'btn btn-sm btn-primary', href: '#/updates' }, '⬆ 在线升级'),
    ]));
    el.appendChild(imageCard());
    el.appendChild(upgradeCard());
    el.appendChild(provisionCard());
    el.appendChild(howToCard());
    if (!data.available) el.appendChild(buildGuideCard());
  }

  function imageCard() {
    const d = data;
    return h('div', { class: 'card mb-20' },
      h('div', { class: 'flex-between', style: { flexWrap: 'wrap', gap: '12px' } },
        h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center' } },
          h('div', { style: { fontSize: '34px' } }, '💿'),
          h('div', {},
            h('div', { style: { fontSize: '17px', fontWeight: '700' } }, `MinerOS ${d.version}`, h('span', { class: 'badge badge-accent', style: { marginLeft: '8px' } }, 'Debian 12')),
            h('div', { class: 'dim', style: { fontSize: '12.5px' } }, d.base || 'Debian 12 bookworm amd64'),
            h('div', { class: 'dim', style: { fontSize: '12px', marginTop: '2px' } },
              d.available
                ? `镜像 ${d.file} · ${fmtNum(d.size / 1024 / 1024, 0)} MB · 构建于 ${fmtAgo(d.builtAt)}`
                : '尚未构建镜像（可先下载离线采集端与 rig.conf）'),
          ),
        ),
        h('div', { class: 'btn-row' },
          d.available
            ? h('a', { class: 'btn btn-primary', href: '/api/os/download', download: '' }, '⬇ 下载 ISO')
            : null,
          h('a', { class: 'btn', href: '/api/os/agent.tar.gz', download: '' }, '⬇ 离线采集端包'),
          d.available ? h('a', { class: 'btn', href: '/api/os/sha256', target: '_blank' }, 'SHA256') : null,
        ),
      ),
      h('div', { class: 'mt-14 flex', style: { gap: '18px', flexWrap: 'wrap', fontSize: '12.5px', color: 'var(--text-2)' } },
        chip('BIOS + UEFI 双启动'),
        chip('U 盘即插即跑'),
        chip('NVIDIA 驱动内置'),
        chip('数据分区持久化'),
        chip('首启自动注册'),
        chip('每 6 小时自动更新采集端'),
      ),
      d.available && d.sha256 ? h('div', { class: 'logview mt-14', style: { maxHeight: '60px' } }, `sha256: ${d.sha256}`) : null,
    );
  }

  function chip(text) {
    return h('span', { class: 'badge badge-muted', style: { fontSize: '11.5px' } }, text);
  }

  /** 在线升级：组件级热更新（不用重装 U 盘）+ 整镜像重刷入口 */
  function upgradeCard() {
    const rigs = (data.rigs || []).filter((r) => (r.os || r.os_info || '').includes('MinerOS') || r.osImageVersion);
    const online = rigs.filter((r) => r.online);
    const outdated = rigs.filter((r) => r.agentVersion && data.agentVersion && cmpVersion(r.agentVersion, data.agentVersion) < 0);
    return h('div', { class: 'card mb-20' },
      h('div', { class: 'card-title' }, h('span', {}, '在线升级'), h('div', { class: 'spacer' }),
        h('span', { class: 'badge badge-accent' }, '免重装')),
      h('div', { class: 'muted', style: { fontSize: '13px', lineHeight: '1.8', marginBottom: '12px' } },
        '矿机跑起来以后再换系统，不用拔 U 盘重刷：',
        h('b', {}, '采集端、挖矿程序、驱动/系统组件'),
        '都可以在「在线升级中心」选版本一键下发，矿机自己下载、校验 SHA256、原子替换、重启矿工，旧版本保留可回滚。',
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '14px' } },
        miniStat('MinerOS 矿机', `${rigs.length} 台`, `${online.length} 台在线`),
        miniStat('采集端版本', `v${data.agentVersion || '-'}`, `${outdated.length} 台待升级`),
        miniStat('镜像版本', `v${data.version || '-'}`, data.available ? '服务器已就绪' : '未构建'),
      ),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn btn-primary btn-sm', href: '#/updates' }, '打开在线升级中心'),
        outdated.length ? h('button', {
          class: 'btn btn-sm',
          onclick: async () => {
            try {
              const r = await api.pushUpdate({ kind: 'agent', rigIds: outdated.map((x) => x.id) });
              toast(`已下发采集端升级：${r.queued} 台`, 'ok');
            } catch (e) { toast(e.message, 'err'); }
          },
        }, `升级 ${outdated.length} 台采集端`) : null,
        data.available ? h('button', {
          class: 'btn btn-sm',
          onclick: () => showReflash(),
        }, '整镜像重刷说明') : null,
      ),
    );
  }

  function miniStat(label, value, sub) {
    return h('div', { style: { padding: '12px 14px', borderRadius: '10px', background: 'var(--bg-2)', border: '1px solid var(--border)' } },
      h('div', { class: 'dim', style: { fontSize: '11.5px' } }, label),
      h('div', { style: { fontSize: '19px', fontWeight: '700', margin: '2px 0' } }, value),
      h('div', { class: 'dim', style: { fontSize: '11.5px' } }, sub));
  }

  function showReflash() {
    openModal({
      title: '整镜像重刷（大版本升级用）',
      wide: true,
      body: h('div', {},
        h('p', { class: 'muted', style: { marginTop: 0, fontSize: '13px' } },
          '小的版本更新直接走「在线升级中心」即可。只有内核、内核驱动这类底层变化，才需要换整镜像：'),
        h('div', { class: 'logview' },
          '# 1. 控制台下载新 ISO\n' +
          '#    「系统镜像」页 → 下载 ISO\n\n' +
          '# 2. Windows 上重刷 U 盘（会自动保留 U 盘里的 rig.conf）\n' +
          '.\\os\\tools\\flash-usb.ps1 -Iso .\\os\\dist\\mineros-1.0.0-amd64.iso -KeepConfig\n\n' +
          '# 3. 矿机关机 → 插 U 盘 → 开机\n' +
          '#    数据分区 MINEROS-DATA 会自动挂载，矿机身份/配置/矿工版本都保留\n\n' +
          '# 4. 老 U 盘可以留着做应急备用盘'),
        h('div', { class: 'hint mt-14' }, '矿机身份、飞行表绑定、已安装的矿工版本都在数据分区 / 服务器上，重刷不会丢。'),
      ),
      footer: h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => document.querySelector('.modal-backdrop')?.remove() }, '知道了')),
    });
  }

  function cmpVersion(a, b) {
    const pa = String(a || '0').split(/[.\-+]/).map((x) => Number(x) || 0);
    const pb = String(b || '0').split(/[.\-+]/).map((x) => Number(x) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function provisionCard() {
    const rigs = data.rigs || [];
    const base = data.defaultServerUrl || location.origin;
    const card = h('div', { class: 'card pad-0 mb-20' });
    card.appendChild(h('div', { class: 'card-title', style: { padding: '16px 18px 12px' } },
      h('span', {}, '为矿机生成 U 盘配置（rig.conf）'),
      h('div', { class: 'spacer' }),
      h('span', { class: 'dim', style: { fontSize: '12px' } }, `服务器地址：${base}`),
    ));
    if (!rigs.length) {
      card.appendChild(h('div', { class: 'empty', style: { padding: '26px' } }, h('p', {}, '还没有矿机，先在「矿机」里添加。')));
      return card;
    }
    card.appendChild(h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, '矿机'), h('th', {}, '币种'), h('th', {}, '系统'), h('th', {}, '采集端'), h('th', {}, '状态'), h('th', {}, ''))),
      h('tbody', {}, ...rigs.map((r) => h('tr', {},
        h('td', { style: { fontWeight: '600' } }, h('a', { href: `#/rig/${r.id}` }, r.name)),
        h('td', {}, coinTag(r.coin)),
        h('td', { class: 'dim' }, r.os || '—'),
        h('td', { class: 'dim mono' }, r.agentVersion ? `v${r.agentVersion}` : '—'),
        h('td', {}, r.online ? h('span', { class: 'badge badge-ok' }, '在线') : h('span', { class: 'badge badge-muted' }, '离线')),
        h('td', {}, h('div', { class: 'btn-row' },
          h('a', { class: 'btn btn-sm', href: `/api/os/rig-conf/${r.id}`, download: '' }, '下载 rig.conf'),
          h('button', { class: 'btn btn-sm', onclick: () => showRigConf(r) }, '查看'),
        )),
      ))),
    ));
    return card;
  }

  async function showRigConf(rig) {
    try {
      const text = await (await fetch(`/api/os/rig-conf/${rig.id}`)).text();
      const modal = openModal({
        title: `rig.conf · ${rig.name}`,
        body: h('div', {},
          h('p', { class: 'muted', style: { marginTop: 0 } }, '把这个文件放到 U 盘根目录（或 FAT32 数据分区），MinerOS 首次启动会自动读取。'),
          h('div', { class: 'logview' }, text),
        ),
        footer: h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => { navigator.clipboard?.writeText(text); toast('已复制', 'ok'); } }, '复制'),
          h('button', { class: 'btn btn-primary', onclick: () => modal.close() }, '关闭'),
        ),
      });
    } catch (e) { toast(e.message, 'err'); }
  }

  function howToCard() {
    return h('div', { class: 'card mb-20' },
      h('div', { class: 'card-title mb-14' }, '三步装到 U 盘'),
      h('ol', { style: { margin: 0, paddingLeft: '20px', fontSize: '13px', color: 'var(--text-2)', lineHeight: '2' } },
        h('li', {}, '下载 ISO（或在本机 Linux/WSL2 用 ', h('code', {}, 'os/build/build.sh'), ' 自行构建）'),
        h('li', {}, 'Windows 管理员 PowerShell 运行 ', h('code', {}, 'os\\tools\\flash-usb.ps1 -Iso <ISO路径>'),
          '，选择 U 盘后自动烧录（会清空 U 盘）'),
        h('li', {}, '下载对应矿机的 rig.conf 放到 U 盘根目录，插到矿机从 U 盘启动'),
      ),
      h('div', { class: 'mt-14 dim', style: { fontSize: '12.5px' } },
        '首次启动约 30 秒：读取 rig.conf → 注册矿机 → 下载并启动矿工 → 屏幕显示 IP。也可以只烧 ISO、不写 rig.conf，让矿机自动注册到「待分组」。'),
    );
  }

  function buildGuideCard() {
    return h('div', { class: 'card', style: { borderColor: 'rgba(255,176,32,.3)' } },
      h('div', { class: 'card-title mb-14' }, '⚠ 还没有构建 ISO'),
      h('p', { class: 'muted', style: { marginTop: 0, fontSize: '13px' } },
        '镜像必须在 Linux 环境构建（Debian/Ubuntu/WSL2/Docker）。Windows 上一键：'),
      h('div', { class: 'logview' },
        'os\\tools\\build.ps1\n\n# 首次准备（管理员 PowerShell）\nwsl --install -d Ubuntu\n# Ubuntu 里执行一次：\nsudo apt update && sudo apt install -y live-build debootstrap xorriso mtools dosfstools squashfs-tools \\\n  syslinux syslinux-common isolinux grub-pc-bin grub-efi-amd64-bin rsync curl wget gnupg xz-utils zstd parted\n\n# 构建（约 20-40 分钟）\nos\\tools\\build.ps1'),
      h('div', { class: 'dim mt-14', style: { fontSize: '12px' } },
        '构建完成后刷新本页即可看到 ISO 下载与 SHA256。详细信息见 docs/MinerOS镜像说明.md'),
    );
  }

  load().catch((e) => {
    clear(el);
    el.appendChild(h('div', { class: 'empty' }, h('p', {}, `加载失败：${e.message}`)));
  });
  return () => {};
}
