<#
.SYNOPSIS
  Provision a MinerOS USB drive: create a FAT32 data partition and write rig.conf,
  an optional offline agent bundle and optional miner archives.

.DESCRIPTION
  Run after flash-usb.ps1 (or on any MinerOS USB that already boots).

  The image itself only contains the OS. This script adds an extra FAT32 partition
  labelled MINEROS-DATA at the end of the USB. MinerOS mounts that partition on boot
  and uses it for /etc/mineros (config), /var/lib/mineros (state) and
  /opt/mineros/miners (miners), so re-flashing the OS later will not lose them.

  Examples (Administrator PowerShell):
    .\provision-usb.ps1 -DriveNumber 2 -Server http://192.168.1.10:8787 -RigName A-01
    .\provision-usb.ps1 -DriveNumber 2 -RigConf .\rig-A01.conf
    .\provision-usb.ps1 -DriveNumber 2 -Server http://... -Bundle .\mineros-agent.tar.gz
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$DriveNumber,
  [string]$Server,
  [string]$RigName = 'mineros',
  [string]$Token = '',
  [string]$RigId = '',
  [string]$RigConf,
  [string]$Bundle,
  [string]$MinersDir,
  [int]$DataSizeMb = 4096,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Run PowerShell as Administrator.' }

$disk = Get-Disk -Number $DriveNumber -ErrorAction SilentlyContinue
if (-not $disk) { Fail "Disk #$DriveNumber not found." }
if ($disk.BusType -ne 'USB') { Fail "Disk #$DriveNumber is not a USB disk (BusType=$($disk.BusType)). Refusing." }
if ($disk.IsSystem -or $disk.IsBoot) { Fail 'Refusing to touch the system disk.' }
if (-not $Force) {
  Write-Host "Disk #$($disk.Number) $($disk.FriendlyName) $([math]::Round($disk.Size/1GB,1)) GB"
  $answer = Read-Host 'Create/extend MINEROS-DATA partition on this disk? (YES)'
  if ($answer -ne 'YES') { Fail 'Cancelled.' }
}

# ---------- ensure a data partition exists ----------
$existing = Get-Partition -DiskNumber $DriveNumber -ErrorAction SilentlyContinue | Where-Object { $_.Type -eq 'Basic' } | Select-Object -Last 1
$existingVol = $null
if ($existing) { $existingVol = Get-Volume -Partition $existing -ErrorAction SilentlyContinue }
$partitions = @(Get-Partition -DiskNumber $DriveNumber)
$last = $partitions | Sort-Object Offset | Select-Object -Last 1
$freeMb = [math]::Floor(($disk.Size - ($last.Offset + $last.Size)) / 1MB)

if ($existingVol -and $existingVol.FileSystemLabel -eq 'MINEROS-DATA' -and $existingVol.DriveLetter) {
  Write-Step "Reusing existing MINEROS-DATA partition ($($existingVol.DriveLetter):)"
  $driveLetter = $existingVol.DriveLetter
} elseif ($freeMb -lt 512) {
  Write-Host "No free space after the last partition ($freeMb MB)." -ForegroundColor Yellow
  if ($existingVol -and $existingVol.DriveLetter) {
    Write-Host "Using existing partition $($existingVol.DriveLetter):" -ForegroundColor Yellow
    $driveLetter = $existingVol.DriveLetter
  } else {
    Fail 'No room for a data partition. Use a larger USB drive (16 GB+).'
  }
} else {
  $sizeMb = [math]::Min($DataSizeMb, $freeMb - 8)
  if ($sizeMb -lt 256) { Fail "Not enough free space ($freeMb MB free)." }
  Write-Step "Creating MINEROS-DATA partition ($sizeMb MB)..."
  $offset = $last.Offset + $last.Size
  $newPart = New-Partition -DiskNumber $DriveNumber -Offset $offset -Size ($sizeMb * 1MB) -ErrorAction Stop
  if (-not $newPart) { Fail 'Failed to create partition.' }
  Write-Step 'Formatting as FAT32...'
  Format-Volume -Partition $newPart -FileSystem FAT32 -NewFileSystemLabel 'MINEROS-DATA' -Confirm:$false -Force | Out-Null
  Start-Sleep -Seconds 2
  $vol = Get-Volume -Partition $newPart -ErrorAction SilentlyContinue
  $driveLetter = $vol.DriveLetter
  if (-not $driveLetter) {
    $driveLetter = (68..90 | ForEach-Object { [char]$_ } | Where-Object { -not (Test-Path "${_}:\") } | Select-Object -First 1)
    $newPart | Set-Partition -NewDriveLetter $driveLetter
    Start-Sleep -Seconds 1
  }
  Write-Host "   -> ${driveLetter}:" -ForegroundColor Green
}

$root = "${driveLetter}:\"

# ---------- rig.conf ----------
if ($RigConf) {
  if (-not (Test-Path $RigConf)) { Fail "rig.conf not found: $RigConf" }
  Copy-Item $RigConf (Join-Path $root 'rig.conf') -Force
  Write-Host "   rig.conf copied" -ForegroundColor Green
} elseif ($Server) {
  $s = $Server
  if (-not $s.StartsWith('http://') -and -not $s.StartsWith('https://')) { $s = "http://$s" }
  $s = $s.TrimEnd('/')
  $lines = @('# MinerOS rig.conf', "SERVER_URL=$s", "RIG_NAME=$RigName", 'ALLOW_REBOOT=true', 'ALLOW_RUN=true')
  if ($Token) { $lines += "RIG_PASSWD=$Token" }
  if ($RigId) { $lines += "RIG_ID=$RigId" }
  Set-Content -Path (Join-Path $root 'rig.conf') -Value ($lines -join "`r`n") -Encoding ASCII
  Write-Host "   rig.conf written (SERVER_URL=$s)" -ForegroundColor Green
}

# ---------- offline agent bundle ----------
if ($Bundle) {
  if (-not (Test-Path $Bundle)) { Fail "Bundle not found: $Bundle" }
  Copy-Item $Bundle (Join-Path $root 'mineros-agent.tar.gz') -Force
  Write-Host '   offline agent bundle copied' -ForegroundColor Green
}

# ---------- miners ----------
if ($MinersDir) {
  if (-not (Test-Path $MinersDir)) { Fail "Miners directory not found: $MinersDir" }
  $target = Join-Path $root 'miners'
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Copy-Item (Join-Path $MinersDir '*') $target -Recurse -Force
  Write-Host '   miners copied' -ForegroundColor Green
}

Write-Host ''
Write-Host 'DONE' -ForegroundColor Green
Write-Host "Data partition: ${driveLetter}: (label MINEROS-DATA)"
Write-Host 'MinerOS will mount it on boot and keep config/state/miners across re-flashes.'
