#!/usr/bin/env node
// MinerOS 本地 Web 控制台（http://<矿机IP>:4000）
// - 查看状态、GPU、矿工日志
// - 重启/停止采集端与矿工
// - 配置 WiFi / 有线网络（NetworkManager）
// - 重启/关机
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { URL } from 'node:url';

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 4000;
})();
const CONFIG = process.env.MM_CONFIG || '/etc/mineros/agent.json';
const LOG = '/var/log/mineros/agent.log';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function read(p, d = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return d; }
}
function cmd(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || ''), code: err?.code ?? 0 });
    });
  });
}

function gpuInfo() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=index,name,temperature.gpu,fan.speed,utilization.gpu,power.draw,power.limit,clocks.sm,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve([]);
      resolve(stdout.trim().split(/\r?\n/).map((l) => {
        const f = l.split(',').map((s) => s.trim());
        return { index: f[0], name: f[1], temp: f[2], fan: f[3], util: f[4], power: f[5], limit: f[6], clock: f[7], memUsed: f[8], memTotal: f[9] };
      }));
    });
  });
}

function minerProcess() {
  const pids = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x));
  for (const pid of pids) {
    const cmdline = read(`/proc/${pid}/cmdline`).split('\0').filter(Boolean).join(' ');
    if (/agent\.js|lan-console|status-panel/.test(cmdline)) continue;
    if (/(xmrig|peakminer|srbminer|bzminer|onezerominer|wildrig|teamredminer|gminer)/i.test(cmdline)) {
      return { pid: Number(pid), cmd: cmdline };
    }
  }
  return null;
}

function ipList() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4') out.push({ name, address: i.address, internal: i.internal });
    }
  }
  return out;
}

async function networkInfo() {
  const wifi = await cmd('nmcli', ['-t', '-f', 'ACTIVE,SSID,SIGNAL', 'dev', 'wifi'], 5000);
  return {
    interfaces: ipList(),
    wifi: wifi.ok ? wifi.out.trim().split('\n').filter(Boolean).slice(0, 20).map((l) => {
      const [active, ssid, signal] = l.split(':');
      return { active: active === 'yes', ssid, signal: Number(signal) };
    }) : [],
  };
}

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MinerOS · 本地控制台</title>
<style>
:root{--bg:#0b0d12;--panel:#151924;--bd:#262d40;--tx:#e8ecf6;--muted:#8b96ad;--ok:#27d17c;--warn:#ffb020;--err:#ff4d67;--accent:#7c5cff}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 400px at 90% -10%,rgba(124,92,255,.18),transparent 60%),var(--bg);color:var(--tx);font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui;padding:18px;max-width:900px;margin:0 auto}
h1{font-size:19px;margin:0 0 2px}.sub{color:var(--muted);font-size:12px;margin-bottom:16px}
.card{background:linear-gradient(180deg,#1b2030,#151924);border:1px solid var(--bd);border-radius:14px;padding:14px 16px;margin-bottom:14px}
.row{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)}.row:last-child{border:0}
.k{color:var(--muted)}.mono{font-family:Consolas,monospace;font-variant-numeric:tabular-nums}
.badge{padding:1px 8px;border-radius:99px;font-size:11px;font-weight:600}.ok{background:rgba(39,209,124,.15);color:var(--ok)}.err{background:rgba(255,77,103,.15);color:var(--err)}
table{width:100%;border-collapse:collapse;font-size:12.5px}th{color:var(--muted);text-align:left;font-weight:600;padding:6px 8px;border-bottom:1px solid var(--bd)}td{padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.04)}
.btn{background:#232a3d;border:1px solid #323a52;color:var(--tx);border-radius:9px;padding:7px 12px;font-size:13px;cursor:pointer;margin:0 6px 6px 0}
.btn:hover{background:#2c3549}.btn.primary{background:linear-gradient(135deg,#7c5cff,#6a4bff);border-color:transparent}
.btn.danger{background:rgba(255,77,103,.14);border-color:rgba(255,77,103,.35);color:var(--err)}
.log{background:#0a0c11;border:1px solid var(--bd);border-radius:10px;padding:10px;font:11.5px/1.55 Consolas,monospace;max-height:260px;overflow:auto;white-space:pre-wrap;color:#b9c2d6}
input{background:#0e1119;border:1px solid #323a52;color:var(--tx);border-radius:8px;padding:7px 10px;font-size:13px;width:100%}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:600px){.grid{grid-template-columns:1fr}}
a{color:#9d7bff}
</style></head><body>
<h1>⛏ MinerOS 本地控制台</h1>
<div class="sub" id="sub">加载中…</div>
<div class="card" id="status"></div>
<div class="card"><b>GPU</b><div id="gpus" style="margin-top:8px"></div></div>
<div class="card"><b>网络</b><div id="net" style="margin-top:8px"></div>
  <div class="grid" style="margin-top:12px">
    <div><input id="ssid" placeholder="WiFi 名称（SSID）"></div>
    <div><input id="psk" type="password" placeholder="WiFi 密码"></div>
  </div>
  <button class="btn primary" onclick="joinWifi()">连接 WiFi</button>
  <span id="wifiMsg" class="sub"></span>
</div>
<div class="card"><b>操作</b><div style="margin-top:10px">
  <button class="btn" onclick="act('restart-agent')">重启采集端</button>
  <button class="btn" onclick="act('restart-miner')">重启矿工</button>
  <button class="btn danger" onclick="act('reboot')">重启矿机</button>
  <button class="btn danger" onclick="act('shutdown')">关机</button>
</div></div>
<div class="card"><b>采集端日志</b><div class="log" id="log">加载中…</div></div>
<div class="sub">MinerOS 1.0.0 · 完整管理请访问服务器控制台</div>
<script>
async function j(u,o){const r=await fetch(u,o);return r.json()}
async function refresh(){
  try{
    const s=await j('/api/status');
    document.getElementById('sub').textContent=s.hostname+' · '+s.os+' · 运行 '+s.uptime;
    const st=document.getElementById('status');
    st.innerHTML=[
      ['矿机名称',s.name],['服务器',s.serverUrl],['注册状态',s.registered?'<span class="badge ok">已注册</span>':'<span class="badge err">未注册</span>'],
      ['IP 地址',s.ips.map(i=>i.address).join(', ')],['CPU 温度',s.cpuTemp!=null?s.cpuTemp+'°C':'—'],
      ['内存',s.memUsed+' / '+s.memTotal+' GB'],['根分区',s.diskFree+' GB 可用 / '+s.diskTotal+' GB'],
      ['矿工',s.miner?('<span class="badge ok">运行中</span> PID '+s.miner.pid):'<span class="badge err">未运行</span>'],
    ].map(([k,v])=>'<div class="row"><span class="k">'+k+'</span><span class="mono">'+v+'</span></div>').join('');
    document.getElementById('gpus').innerHTML=s.gpus.length
      ? '<table><tr><th>#</th><th>型号</th><th>温度</th><th>风扇</th><th>利用率</th><th>功耗</th><th>显存</th></tr>'+
        s.gpus.map(g=>'<tr><td>'+g.index+'</td><td>'+g.name+'</td><td>'+g.temp+'°C</td><td>'+g.fan+'%</td><td>'+g.util+'%</td><td>'+g.power+'/'+g.limit+'W</td><td>'+g.memUsed+'/'+g.memTotal+' MB</td></tr>').join('')+'</table>'
      : '<span class="k">未检测到 NVIDIA 显卡</span>';
    document.getElementById('net').innerHTML=s.net.ips.map(i=>'<div class="row"><span class="k">'+i.name+'</span><span class="mono">'+i.address+'</span></div>').join('')+
      (s.net.wifi.length?'<div class="sub" style="margin-top:6px">可用 WiFi：'+s.net.wifi.map(w=>w.ssid+' ('+w.signal+'%)').join(' · ')+'</div>':'');
    document.getElementById('log').textContent=s.logTail.join('\\n');
  }catch(e){document.getElementById('sub').textContent='连接失败: '+e.message}
}
async function act(a){ if(!confirm('确定执行 '+a+' ？')) return; const r=await j('/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:a})}); alert(r.message||'已执行'); setTimeout(refresh,2000); }
async function joinWifi(){
  const ssid=document.getElementById('ssid').value, psk=document.getElementById('psk').value;
  const r=await j('/api/wifi',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ssid,psk})});
  document.getElementById('wifiMsg').textContent=r.message||'';
}
refresh(); setInterval(refresh,5000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, obj, type = 'application/json') => {
    const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
    res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };

  if (req.method === 'GET' && url.pathname === '/') return send(200, HTML, 'text/html');

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const cfg = readJson(CONFIG) || {};
    const state = readJson('/var/lib/mineros/agent-state.json') || {};
    const gpus = await gpuInfo();
    const net = await networkInfo();
    const mem = os.totalmem();
    const free = os.freemem();
    const stat = (() => {
      try {
        const t = fs.statfsSync('/');
        return { total: (Number(t.blocks) * Number(t.bsize)) / 1e9, free: (Number(t.bavail) * Number(t.bsize)) / 1e9 };
      } catch { return { total: 0, free: 0 }; }
    })();
    const cpuTemp = (() => {
      for (const h of fs.existsSync('/sys/class/hwmon') ? fs.readdirSync('/sys/class/hwmon') : []) {
        if (!/k10temp|coretemp|zenpower/i.test(read(`/sys/class/hwmon/${h}/name`))) continue;
        for (const f of fs.readdirSync(`/sys/class/hwmon/${h}`)) {
          if (!/^temp\d+_input$/.test(f)) continue;
          const v = Number(read(`/sys/class/hwmon/${h}/${f}`));
          if (v > 0) return Math.round(v / 1000);
        }
      }
      return null;
    })();
    const up = Number(read('/proc/uptime', '0').split(' ')[0]) || 0;
    const logLines = read(LOG).split('\n').filter(Boolean);
    return send(200, {
      hostname: os.hostname(),
      name: cfg.name || os.hostname(),
      os: 'MinerOS 1.0.0',
      serverUrl: cfg.serverUrl || '',
      registered: !!state.token,
      uptime: `${Math.floor(up / 86400)}天${Math.floor((up % 86400) / 3600)}小时${Math.floor((up % 3600) / 60)}分`,
      ips: ipList(),
      cpuTemp,
      memUsed: (mem - free) / 1e9, memTotal: mem / 1e9,
      diskFree: stat.free, diskTotal: stat.total,
      gpus,
      miner: minerProcess(),
      net,
      logTail: logLines.slice(-30),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/action') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let action = '';
      try { action = JSON.parse(body || '{}').action; } catch { /* ignore */ }
      const map = {
        'restart-agent': ['systemctl', ['restart', 'mineros-agent.service'], '采集端已重启'],
        'restart-miner': ['systemctl', ['restart', 'mineros-agent.service'], '已请求采集端重启矿工'],
        reboot: ['systemctl', ['reboot'], '矿机正在重启'],
        shutdown: ['systemctl', ['poweroff'], '矿机正在关机'],
      };
      const item = map[action];
      if (!item) return send(400, { error: '未知操作' });
      const r = await cmd(item[0], item[1], 5000);
      send(r.ok ? 200 : 500, { ok: r.ok, message: r.ok ? item[2] : (r.err || '执行失败') });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/wifi') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let ssid = '';
      let psk = '';
      try { ({ ssid, psk } = JSON.parse(body || '{}')); } catch { /* ignore */ }
      if (!ssid) return send(400, { message: '缺少 SSID' });
      const r = await cmd('nmcli', ['dev', 'wifi', 'connect', ssid, 'password', psk], 45000);
      send(r.ok ? 200 : 500, { message: r.ok ? `已连接 ${ssid}，IP：${ipList().map((i) => i.address).join(', ')}` : (r.err || '连接失败') });
    });
    return;
  }

  send(404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MinerOS 本地控制台: http://0.0.0.0:${PORT}`);
});
