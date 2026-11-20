# 启动服务端（Windows）
# 用法：双击 run-server.bat，或在 PowerShell 里执行 .\start-server.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host "未检测到 Node.js。请先安装 Node.js 22.5+（https://nodejs.org/）。" -ForegroundColor Red
  exit 1
}
$ver = & $node -e "process.stdout.write(process.versions.node)"
Write-Host "Node.js $ver" -ForegroundColor DarkGray

# 可选：从 config.json 读取配置
if (Test-Path ".\config.json") { Write-Host "使用 config.json 配置" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "  ⛏  矿机监控中心" -ForegroundColor Cyan
Write-Host "  启动后请用浏览器打开控制台地址" -ForegroundColor DarkGray
Write-Host ""

& $node server/app.js
