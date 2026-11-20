// 采集端安装包：把 agent 运行所需文件打包为 zip，便于在矿机上用一条命令下载安装
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 生成 zip（deflate，UTF-8 文件名用通用 flag 0x0800） */
export function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data, { level: 7 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

const REQUIRED = ['agent.js', 'gpu.js', 'miner.js', 'sys.js', 'package.json'];

export function buildAgentZip(projectRoot) {
  const agentDir = path.join(projectRoot, 'agent');
  const sharedDir = path.join(projectRoot, 'shared');
  const files = {};
  for (const f of REQUIRED) {
    const p = path.join(agentDir, f);
    if (!fs.existsSync(p)) continue;
    files[`agent/${f}`] = fs.readFileSync(p);
  }
  for (const f of fs.readdirSync(sharedDir)) {
    if (f.endsWith('.js')) files[`shared/${f}`] = fs.readFileSync(path.join(sharedDir, f));
  }
  return makeZip(files);
}

/** 生成 Windows 一键安装脚本（PowerShell） */
export function installScript({ baseUrl, token, rigId, name }) {
  const safeBase = baseUrl.replace(/\/+$/, '');
  return `# ============================================================
#  矿机监控采集端 一键安装（Windows / PowerShell 管理员）
#  矿机: ${name || rigId}
# ============================================================
$ErrorActionPreference = 'Stop'
$Server  = '${safeBase}'
$RigId   = '${rigId}'
$Token   = '${token}'
$Install = 'C:\\ProgramData\\MinerMonitor'
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $NodeExe) {
  Write-Host "[1/4] 未检测到 Node.js，正在下载官方 LTS ..." -ForegroundColor Cyan
  $msi = Join-Path $env:TEMP 'node-lts.msi'
  Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi' -OutFile $msi -UseBasicParsing
  Start-Process msiexec.exe -ArgumentList "/i \`"$msi\`" /qn ADDLOCAL=ALL" -Wait
  $NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $NodeExe) { throw 'Node.js 安装失败，请手动安装后重试：https://nodejs.org/' }
}

Write-Host "[2/4] 下载采集端到 $Install ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Install | Out-Null
$zip = Join-Path $env:TEMP 'miner-agent.zip'
Invoke-WebRequest -Uri "$Server/api/agent/bundle" -OutFile $zip -UseBasicParsing -Headers @{ 'x-rig-token' = $Token }
if (Test-Path (Join-Path $Install 'agent')) { Remove-Item -Recurse -Force (Join-Path $Install 'agent') }
if (Test-Path (Join-Path $Install 'shared')) { Remove-Item -Recurse -Force (Join-Path $Install 'shared') }
Expand-Archive -Path $zip -DestinationPath $Install -Force
if (-not (Test-Path (Join-Path $Install 'agent\\agent.js'))) { throw '解压失败：未找到 agent/agent.js' }

Write-Host "[3/4] 写入配置 ..." -ForegroundColor Cyan
$cfg = [ordered]@{
  serverUrl = $Server
  token     = $Token
  rigId     = $RigId
  name      = '${(name || '').replace(/'/g, "''")}'
  intervalSec = 5
  allowUpdate = $true
}
$cfg | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $Install 'config.json') -Encoding UTF8

Write-Host "[4/4] 注册开机自启计划任务 ..." -ForegroundColor Cyan
$taskName = 'MinerMonitorAgent'
$action = New-ScheduledTaskAction -Execute $NodeExe -Argument "\\"$Install\\agent\\agent.js\\" --config \\"$Install\\config.json\\"" -WorkingDirectory $Install
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "✅ 安装完成！采集端已启动，约 10 秒后可在控制台看到该矿机。" -ForegroundColor Green
Write-Host "   配置文件: $Install\\config.json"
Write-Host "   查看日志: $Install\\logs\\agent.log"
Write-Host "   卸载: Unregister-ScheduledTask -TaskName $taskName -Confirm:\$false"
`;
}
