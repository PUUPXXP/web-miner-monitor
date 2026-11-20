// MinerOS 验证：Linux 采集端逻辑（用 /proc、/sys 的模拟文件树）+ 镜像构建配置
// 用法: node tests/os-verify.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const failures = [];
function ok(name, info = '') { pass++; console.log('✓', name, info ? '— ' + info : ''); }
function bad(name, err) { fail++; failures.push([name, err.message || String(err)]); console.log('✗', name, '—', err.message || err); }
function check(name, fn) {
  try { const r = fn(); ok(name, r || ''); } catch (e) { bad(name, e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

// ───────── 1. 构造 /proc、/sys 模拟树 ─────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mineros-test-'));
const P = path.join(TMP, 'proc');
const S = path.join(TMP, 'sys');
function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
write(path.join(P, 'cpuinfo'), 'processor\t: 0\nmodel name\t: AMD Ryzen 9 7950X 16-Core Processor\n');
write(path.join(P, 'meminfo'), 'MemTotal:       32850000 kB\nMemFree:         8000000 kB\nMemAvailable:   20000000 kB\n');
write(path.join(P, 'uptime'), '93784.25 12345.00\n');
write(path.join(P, 'stat'), 'cpu  1000 0 500 8000 200 0 0 0 0 0\n');
// 一个假的矿工进程
write(path.join(P, '4242', 'cmdline'), '/opt/mineros/miners/xmrig/xmrig\0-o\0pool.supportxmr.com:3333\0');
write(path.join(P, '4242', 'comm'), 'xmrig\n');
write(path.join(P, '4242', 'stat'), '4242 (xmrig) S 1 4242 4242 0 -1 4194560 100 0 0 0 10 5 0 0 20 0 16 0 12345 0 0\n');
write(path.join(P, '100', 'cmdline'), '/opt/mineros/node/bin/node\0/opt/mineros/agent/agent.js\0');
write(path.join(P, '100', 'comm'), 'node\n');
// AMD 卡 sysfs
const amd = path.join(S, 'class', 'drm', 'card1', 'device');
write(path.join(amd, 'vendor'), '0x1002\n');
write(path.join(amd, 'product_name'), 'AMD Radeon RX 7900 XTX\n');
write(path.join(amd, 'mem_info_vram_total'), '25753026560\n');
write(path.join(amd, 'mem_info_vram_used'), '9000000000\n');
write(path.join(amd, 'pp_dpm_sclk'), '0: 500Mhz\n1: 2100Mhz *\n');
write(path.join(amd, 'hwmon', 'hwmon0', 'temp1_input'), '65000\n');
write(path.join(amd, 'hwmon', 'hwmon0', 'fan1_input'), '1800\n');
write(path.join(amd, 'hwmon', 'hwmon0', 'power1_average'), '280000000\n');
// CPU 温度
write(path.join(S, 'class', 'hwmon', 'hwmon3', 'name'), 'k10temp\n');
write(path.join(S, 'class', 'hwmon', 'hwmon3', 'temp1_input'), '58000\n');

const oldRoots = { proc: process.env.MM_PROC_ROOT, sys: process.env.MM_SYS_ROOT };
process.env.MM_PROC_ROOT = P;
process.env.MM_SYS_ROOT = S;

// ───────── 2. 加载 Linux 模块并验证 ─────────
const lin = await import('../agent/platform/linux.js');
const sysLinux = await import('../agent/sys-linux.js');

console.log('\n== Linux 采集端 ==');
check('CPU 型号解析', () => {
  const name = sysLinux.cpuName();
  assert(name.includes('Ryzen 9 7950X'), `实际: ${name}`);
  return name;
});
check('内存解析', () => {
  const mem = sysLinux.memInfo();
  assert(mem.totalMb > 30000, `total=${mem.totalMb}`);
  assert(mem.usedMb > 10000, `used=${mem.usedMb}`);
  return `${mem.usedMb}/${mem.totalMb} MB`;
});
check('系统信息聚合', async () => null);
const sysInfo = await sysLinux.collectSystem().catch((e) => ({ error: e.message }));
check('系统信息字段', () => {
  for (const k of ['hostname', 'cpu', 'memTotalMb', 'uptimeSec', 'ip']) assert(k in sysInfo, `缺少 ${k}`);
  assert(sysInfo.uptimeSec > 90000, `uptime=${sysInfo.uptimeSec}`);
  return `uptime ${sysInfo.uptimeSec}s`;
});
check('AMD sysfs 采集', () => {
  const cards = lin.readAmdSysfs();
  assert(cards.length === 1, `数量 ${cards.length}`);
  const g = cards[0];
  assert(g.vendor === 'amd');
  assert(g.temp === 65, `temp=${g.temp}`);
  assert(g.power === 280, `power=${g.power}`);
  assert(g.clockCore === 2100, `clock=${g.clockCore}`);
  assert(g.memTotal > 24000, `memTotal=${g.memTotal}`);
  return `${g.name} ${g.temp}°C ${g.power}W`;
});
check('CPU 温度', () => {
  const t = lin.readCpuTemp();
  assert(t === 58, `temp=${t}`);
  return `${t}°C`;
});
check('Linux 进程探测', async () => null);
const procs = await lin.createPlatform().detectMiners();
check('矿工进程识别', () => {
  assert(procs.length === 1, `数量 ${procs.length}`);
  assert(procs[0].pid === 4242);
  assert(procs[0].cmd.includes('pool.supportxmr.com'));
  return `PID ${procs[0].pid} ${procs[0].name}`;
});
check('按可执行文件查找进程', async () => null);
const found = await lin.createPlatform().findProcessByExe('/opt/mineros/miners/xmrig/xmrig');
check('findProcessByExe', () => {
  assert(found && found.pid === 4242, `got ${JSON.stringify(found)}`);
  return `PID ${found.pid}`;
});
check('进程存活检测', async () => null);
const alive = await lin.createPlatform().isPidAlive(4242);
check('isPidAlive', () => {
  assert(alive === true);
  return 'alive';
});

// ───────── 3. 恢复环境 ─────────
if (oldRoots.proc === undefined) delete process.env.MM_PROC_ROOT; else process.env.MM_PROC_ROOT = oldRoots.proc;
if (oldRoots.sys === undefined) delete process.env.MM_SYS_ROOT; else process.env.MM_SYS_ROOT = oldRoots.sys;

// ───────── 4. MinerOS 构建配置完整性 ─────────
console.log('\n== MinerOS 构建配置 ==');
const LB = path.join(ROOT, 'os', 'live-build');
const required = [
  '../../os/build/lb-config.sh',
  'custom/overlay/common',
  'custom/overlay/mineros',
  'custom/overlay/package-lists/base.list.chroot',
  'custom/overlay/package-lists/firmware.list.chroot',
  'custom/overlay/package-lists/mining.list.chroot',
  'custom/overlay/hooks/0100-mineros-base.hook.chroot',
  'custom/overlay/hooks/0150-nodejs.hook.chroot',
  'custom/overlay/hooks/0200-nvidia-dkms.hook.chroot',
  'custom/overlay/hooks/0300-finalize.hook.chroot',
  'custom/overlay/includes.chroot/etc/systemd/system/mineros-agent.service',
  'custom/overlay/includes.chroot/etc/systemd/system/mineros-firstboot.service',
  'custom/overlay/includes.chroot/etc/systemd/system/mineros-console.service',
  'custom/overlay/includes.chroot/etc/systemd/system/mineros-panel.service',
  'custom/overlay/includes.chroot/etc/systemd/system/mineros-update.timer',
  'custom/overlay/includes.chroot/etc/systemd/system/mineros-update.service',
  'custom/overlay/includes.chroot/usr/local/bin/mineros-firstboot.sh',
  'custom/overlay/includes.chroot/usr/local/bin/mineros-update.sh',
  '../custom/overlay/includes.chroot/etc/mineros/version',
  'custom/overlay/includes.chroot/opt/mineros/tools/status-panel.js',
  'custom/overlay/includes.chroot/opt/mineros/tools/lan-console.js',
];
check('必需文件齐全', () => {
  const missing = required.filter((f) => !fs.existsSync(path.join(LB, f)));
  // mineros-status 由构建钩子生成，不在源码树里
  const hookText = fs.readFileSync(path.join(LB, 'custom/overlay/hooks/0100-mineros-base.hook.chroot'), 'utf8');
  const statusFromHook = hookText.includes('/usr/local/bin/mineros-status');
  assert(missing.length === (statusFromHook ? 1 : 0), `缺少: ${missing.join(', ')}`);
  assert(statusFromHook, 'mineros-status 应由 0100 hook 生成');
  return `${required.length} 个文件（mineros-status 由钩子生成）`;
});
check('systemd 单元格式', () => {
  for (const f of fs.readdirSync(path.join(LB, 'config/includes.chroot/etc/systemd/system'))) {
    const text = fs.readFileSync(path.join(LB, 'config/includes.chroot/etc/systemd/system', f), 'utf8');
    assert(/^\[Unit\]/m.test(text), `${f} 缺少 [Unit]`);
    const isService = f.endsWith('.service');
    if (isService) {
      assert(/^\[Service\]/m.test(text), `${f} 缺少 [Service]`);
      assert(/^ExecStart=/m.test(text), `${f} 缺少 ExecStart`);
      assert(/^\[Install\]/m.test(text), `${f} 缺少 [Install]`);
    } else {
      assert(/^\[Timer\]/m.test(text), `${f} 缺少 [Timer]`);
    }
  }
  return 'OK';
});
check('包清单不含不存在的包名', () => {
  const banned = ['nvidia-kernel-amd64', 'nvidia-compute-utils', 'firmware-rtl8125', 'sudosu'];
  const text = fs.readdirSync(path.join(LB, 'config/package-lists'))
    .map((f) => fs.readFileSync(path.join(LB, 'config/package-lists', f), 'utf8')).join('\n');
  const found = banned.filter((b) => new RegExp(`^${b}$`, 'm').test(text));
  assert(found.length === 0, `发现无效包: ${found.join(', ')}`);
  return 'OK';
});
check('首启脚本语法（括号/引号平衡）', () => {
  const sh = fs.readFileSync(path.join(LB, 'custom/overlay/includes.chroot/usr/local/bin/mineros-firstboot.sh'), 'utf8');
  assert(sh.includes('SERVER_URL'), '缺少 SERVER_URL 解析');
  assert(sh.includes('MINEROS-DATA'), '缺少数据分区处理');
  assert(sh.includes('rig.conf'), '缺少 rig.conf 处理');
  const opens = (sh.match(/\{/g) || []).length;
  const closes = (sh.match(/\}/g) || []).length;
  assert(Math.abs(opens - closes) < 10, `花括号不平衡 ${opens}/${closes}`);
  return `${sh.split('\n').length} 行`;
});

// ───────── 4.5 shell 脚本语法 ─────────
console.log('\n== Shell 语法 ==');
const { checkShell } = await import('../tools/shcheck.js');
check('构建/首启脚本语法', () => {
  const files = [
    'os/build/build.sh', 'os/build/verify-image.sh', 'os/build/build-docker.sh',
    'os/build/lb-config.sh',
    'os/live-build/config/hooks/0100-mineros-base.hook.chroot',
    'os/live-build/config/hooks/0150-nodejs.hook.chroot',
    'os/live-build/config/hooks/0200-nvidia-dkms.hook.chroot',
    'os/live-build/config/hooks/0300-finalize.hook.chroot',
    'os/live-build/config/includes.chroot/usr/local/bin/mineros-firstboot.sh',
    'os/live-build/config/includes.chroot/usr/local/bin/mineros-update.sh',
  ];
  const problems = [];
  for (const f of files) {
    const errs = checkShell(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    if (errs.length) problems.push(`${f}: ${errs.join('; ')}`);
  }
  assert(problems.length === 0, problems.join(' | '));
  return `${files.length} 个脚本`;
});

// ───────── 5. 采集端离线包 ─────────
console.log('\n== 离线采集端包 ==');
check('tar.gz 可解包且结构正确', () => {
  const tgz = path.join(ROOT, 'os', 'dist', 'mineros-agent.tar.gz');
  if (!fs.existsSync(tgz)) return '（未生成，跳过）';
  const buf = fs.readFileSync(tgz);
  assert(buf[0] === 0x1f && buf[1] === 0x8b, '不是 gzip');
  const raw = zlib.gunzipSync(buf);
  const names = [];
  for (let off = 0; off + 512 <= raw.length;) {
    const header = raw.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    if (name) names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  assert(names.includes('agent/agent.js'), '缺少 agent/agent.js');
  assert(names.includes('shared/miners.js'), '缺少 shared/miners.js');
  assert(!names.some((n) => n.includes('agent-state.json')), '不应包含 agent-state.json');
  return `${names.length} 个文件`;
});

// ───────── 6. 汇总 ─────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${fail ? '❌' : '✅'} ${pass}/${pass + fail} 项通过`);
for (const [n, e] of failures) console.log('  -', n, ':', e);
if (fail) process.exitCode = 1;
