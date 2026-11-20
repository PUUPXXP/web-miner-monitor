# 矿工下载助手（Windows PowerShell，管理员可选）
# 从 GitHub Releases 下载常用矿工到一个目录，并按采集端约定放置：
#   <目标目录>\<矿工ID>\<可执行文件>
# 用法:
#   .\miner-download.ps1 -Dest "C:\ProgramData\MinerMonitor\miners" -Miner xmrig,peakminer
#   .\miner-download.ps1 -Dest "C:\ProgramData\MinerMonitor\miners" -Miner all
param(
  [string]$Dest = "C:\ProgramData\MinerMonitor\miners",
  [string[]]$Miner = @("xmrig"),
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# 与 shared/miners.js 中 MINERS 保持一致
$Catalog = @{
  "xmrig"       = @{ Name = "XMRig";        Version = "6.26.0"; Url = "https://github.com/xmrig/xmrig/releases/download/v6.26.0/xmrig-6.26.0-windows-x64.zip";                             Exe = "xmrig.exe" }
  "peakminer"   = @{ Name = "PeakMiner";    Version = "2.20.9"; Url = "https://github.com/peakminer/peakminer/releases/download/v2.20.9/peakminer-2.20.9-windows-x86_64.zip";         Exe = "peakminer.exe" }
  "srbminer"    = @{ Name = "SRBMiner-MULTI"; Version = "3.8.9"; Url = "https://github.com/doktor83/SRBMiner-Multi/releases/download/3.8.9/SRBMiner-Multi-3-8-9-win64.zip";          Exe = "SRBMiner-MULTI.exe" }
  "onezerominer"= @{ Name = "OneZeroMiner"; Version = "1.8.6"; Url = "https://github.com/OneZeroMiner/onezerominer/releases/download/v1.8.6/onezerominer-win64-1.8.6.zip";            Exe = "onezerominer.exe" }
  "bzminer"     = @{ Name = "bzMiner";      Version = "100.81"; Url = "https://github.com/bzminer/bzminer/releases/download/v100.81/bzminer_v100.81_windows.zip";                      Exe = "bzminer.exe" }
  "wildrig"     = @{ Name = "WildRig Multi"; Version = "0.50.9"; Url = "https://github.com/andru-kun/wildrig-multi/releases/download/0.50.9/wildrig-multi-windows-0.50.9.zip";        Exe = "wildrig.exe" }
}

if ($Miner -contains "all") { $Miner = $Catalog.Keys }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Write-Host "目标目录: $Dest" -ForegroundColor Cyan

foreach ($id in $Miner) {
  $m = $Catalog[$id]
  if (-not $m) { Write-Host "未知矿工: $id（可选: $($Catalog.Keys -join ', ')）" -ForegroundColor Yellow; continue }
  $dir = Join-Path $Dest $id
  $exe = Join-Path $dir $m.Exe
  if ((Test-Path $exe) -and -not $Force) {
    Write-Host "跳过 $($m.Name)（已存在 $exe）" -ForegroundColor DarkGray
    continue
  }
  Write-Host "下载 $($m.Name) v$($m.Version) ..." -ForegroundColor Cyan
  $zip = Join-Path $env:TEMP "$id.zip"
  try {
    Invoke-WebRequest -Uri $m.Url -OutFile $zip -UseBasicParsing
  } catch {
    Write-Host "  下载失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  请手动下载: $($m.Url)" -ForegroundColor Yellow
    continue
  }
  $tmp = Join-Path $env:TEMP "$id-extract"
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # 把解压出的文件（可能是单层子目录）合并到目标目录
  $root = Get-ChildItem $tmp | Select-Object -First 1
  if ($root -and $root.PSIsContainer) { Get-ChildItem $root.FullName | Copy-Item -Destination $dir -Recurse -Force }
  else { Get-ChildItem $tmp | Copy-Item -Destination $dir -Recurse -Force }
  Remove-Item -Recurse -Force $tmp, $zip -ErrorAction SilentlyContinue
  if (Test-Path (Join-Path $dir $m.Exe)) {
    Write-Host "  ✓ $($m.Name) -> $(Join-Path $dir $m.Exe)" -ForegroundColor Green
  } else {
    Write-Host "  ! 未找到 $($m.Exe)，请检查压缩包内容" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "完成。在飞行表中把矿工路径设为对应 exe，或保持默认（采集端会自动找 miners\<矿工ID>\<exe>）。" -ForegroundColor Green
