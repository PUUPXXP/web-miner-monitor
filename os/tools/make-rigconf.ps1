<#
.SYNOPSIS
  Create a rig.conf file for MinerOS USB provisioning.

.DESCRIPTION
  rig.conf is read on first boot from the USB drive. It tells the rig which
  server to join and which rig identity/key to use (Hive OS style).

  Examples:
    .\make-rigconf.ps1 -Server http://192.168.1.10:8787 -RigName A-01 -Out .\os\dist\rig-A01.conf
    .\make-rigconf.ps1 -Server http://... -Token rig_xxx -RigId abc123 -Out rig.conf

  Note: leave -Token empty to let the agent auto-register (enable auto register
  in the web console first).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$RigName = 'mineros',
  [string]$Token = '',
  [string]$RigId = '',
  [string]$Out = '.\rig.conf',
  [string]$AllowReboot = 'true',
  [string]$AllowRun = 'true',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $Server.StartsWith('http://') -and -not $Server.StartsWith('https://')) {
  $Server = "http://$Server"
}
$Server = $Server.TrimEnd('/')

if (Test-Path $Out -and -not $Force) {
  $answer = Read-Host "$Out already exists. Overwrite? (y/N)"
  if ($answer -notmatch '^[Yy]') { Write-Host 'Cancelled.'; exit 0 }
}

$lines = @(
  '# MinerOS rig.conf -- written by make-rigconf.ps1',
  "# $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
  'SERVER_URL=' + $Server,
  'RIG_NAME=' + $RigName,
  'ALLOW_REBOOT=' + $AllowReboot,
  'ALLOW_RUN=' + $AllowRun
)
if ($Token) { $lines += 'RIG_PASSWD=' + $Token }
if ($RigId) { $lines += 'RIG_ID=' + $RigId }

$dir = Split-Path -Parent $Out
if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
Set-Content -Path $Out -Value ($lines -join "`r`n") -Encoding ASCII

Write-Host "rig.conf written: $Out" -ForegroundColor Green
Get-Content $Out | ForEach-Object { Write-Host "  $_" }
Write-Host ''
Write-Host 'Copy it to the USB root (flash-usb.ps1 -RigConf does this automatically).'
