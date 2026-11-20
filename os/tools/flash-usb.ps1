<#
.SYNOPSIS
  Flash a MinerOS image to a USB drive (ERASES THE DRIVE).

.DESCRIPTION
  1. Detects removable USB disks and asks you to confirm (never touches the system disk).
  2. Verifies the ISO sha256 when a .sha256 file exists.
  3. Clears the disk and writes the image bytes directly (works for images > 4 GB).
  4. Optionally copies a rig.conf to the USB root afterwards.

  Run as Administrator:
    .\flash-usb.ps1 -Iso .\os\dist\mineros-1.0.0-amd64.iso
    .\flash-usb.ps1 -Iso ... -RigConf .\os\dist\rig-A01.conf
    .\flash-usb.ps1 -Iso ... -DriveNumber 2 -Force     # automation
    .\flash-usb.ps1 -Iso ... -KeepConfig               # upgrade: keep existing rig.conf

.NOTES
  Windows only, Administrator required. Use a USB drive of 16 GB or more.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Iso,
  [string]$RigConf,
  [int]$DriveNumber = -1,
  [switch]$Force,
  [switch]$KeepConfig
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Run PowerShell as Administrator.' }

if (-not (Test-Path $Iso)) { Fail "Image not found: $Iso" }
$isoItem = Get-Item $Iso
Write-Step ("Image: {0} ({1:N1} MB)" -f $isoItem.FullName, ($isoItem.Length / 1MB))

$shaFile = "$Iso.sha256"
if (Test-Path $shaFile) {
  Write-Step 'Verifying sha256...'
  $expected = (Get-Content $shaFile -Raw).Trim().Split(' ')[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 $Iso).Hash.ToLower()
  if ($expected -ne $actual) { Fail "sha256 mismatch. Expected $expected, got $actual" }
  Write-Host '   OK' -ForegroundColor Green
} else {
  Write-Host '   (no .sha256 file, skipping)' -ForegroundColor DarkGray
}

Write-Step 'Detecting USB disks...'
$disks = @(Get-Disk | Where-Object { $_.BusType -eq 'USB' -and -not $_.IsBoot -and -not $_.IsSystem })
if ($disks.Count -eq 0) { Fail 'No USB disk detected. Plug in the USB drive and retry.' }

Write-Host ''
Write-Host '  Removable disks:' -ForegroundColor Yellow
foreach ($d in $disks) {
  $size = [math]::Round($d.Size / 1GB, 1)
  Write-Host ("   #{0}  {1}  {2} GB  {3}" -f $d.Number, $d.FriendlyName, $size, $d.Model)
}
Write-Host ''

if ($DriveNumber -ge 0) {
  $target = $disks | Where-Object { $_.Number -eq $DriveNumber }
  if (-not $target) { Fail "Disk #$DriveNumber not found. Available: $($disks.Number -join ', ')" }
} else {
  $num = Read-Host 'Enter the disk number to flash (ALL DATA WILL BE ERASED)'
  $target = $disks | Where-Object { $_.Number -eq [int]$num }
  if (-not $target) { Fail 'Invalid disk number.' }
}

$targetSizeGb = [math]::Round($target.Size / 1GB, 1)
if ($targetSizeGb -lt 8) { Write-Host '[WARN] USB is smaller than 8 GB, 16 GB+ recommended.' -ForegroundColor Yellow }
if ($target.IsSystem -or $target.IsBoot) { Fail 'Refusing to touch the system disk.' }

# -KeepConfig：重刷前先备份 U 盘上的 rig.conf（整镜像升级时保留矿机身份）
$savedRigConf = $null
if ($KeepConfig) {
  $existingVol = @(Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Removable' -and $_.DriveLetter -ne $null }) | Select-Object -First 1
  if ($existingVol) {
    $candidate = "$($existingVol.DriveLetter):\rig.conf"
    if (Test-Path $candidate) {
      $savedRigConf = Join-Path $env:TEMP ("rig-keep-{0}.conf" -f (Get-Date -Format 'yyyyMMddHHmmss'))
      Copy-Item $candidate $savedRigConf -Force
      Write-Host "   rig.conf backed up from $($existingVol.DriveLetter): (will be restored)" -ForegroundColor Green
    }
  }
  if (-not $savedRigConf) { Write-Host '   [WARN] -KeepConfig: no rig.conf found on the USB, nothing to preserve.' -ForegroundColor Yellow }
}

Write-Host ''
Write-Host 'About to flash:' -ForegroundColor Red
Write-Host ("  Disk #{0}  {1}  {2} GB" -f $target.Number, $target.FriendlyName, $targetSizeGb) -ForegroundColor Red
Write-Host "  Image: $Iso" -ForegroundColor Red
Write-Host '  ALL PARTITIONS AND DATA ON THIS DISK WILL BE DELETED!' -ForegroundColor Red
Write-Host ''
if (-not $Force) {
  $answer = Read-Host 'Type YES to continue'
  if ($answer -ne 'YES') { Fail 'Cancelled.' }
}

Write-Step 'Clearing partition table...'
try {
  Clear-Disk -Number $target.Number -RemoveData -RemoveOEM -Confirm:$false -ErrorAction Stop
} catch {
  Write-Host "  Clear-Disk failed ($($_.Exception.Message)), using diskpart" -ForegroundColor Yellow
  "select disk $($target.Number)`nclean" | diskpart | Out-Null
}

Write-Step ('Writing image ({0:N0} MB), please wait...' -f ($isoItem.Length / 1MB))
$fs = [System.IO.File]::OpenRead($Iso)
$diskStream = $null
try {
  $diskStream = New-Object System.IO.FileStream(
    "\\.\PhysicalDrive$($target.Number)",
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::ReadWrite,
    1048576,
    [System.IO.FileOptions]::WriteThrough
  )
  $buffer = New-Object byte[] (4 * 1024 * 1024)
  $total = $fs.Length
  $written = 0L
  $lastPct = -1
  while ($true) {
    $read = $fs.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) { break }
    $diskStream.Write($buffer, 0, $read)
    $written += $read
    $pct = [math]::Floor($written * 100 / $total)
    if ($pct -ne $lastPct -and ($pct % 5) -eq 0) {
      Write-Host ("   {0,3}%  {1:N0} / {2:N0} MB" -f $pct, ($written / 1MB), ($total / 1MB))
      $lastPct = $pct
    }
  }
  $diskStream.Flush()
  Write-Host ''
  Write-Host ('   Done, wrote {0:N0} MB' -f ($written / 1MB)) -ForegroundColor Green
} catch {
  Fail "Write failed: $($_.Exception.Message). Close Explorer windows, check write protection, retry."
} finally {
  if ($diskStream) { $diskStream.Dispose() }
  $fs.Dispose()
}

Start-Sleep -Seconds 2
"select disk $($target.Number)`nrescan" | diskpart | Out-Null

if ($RigConf) {
  if (-not (Test-Path $RigConf)) { Fail "rig.conf not found: $RigConf" }
  Write-Step 'Copying rig.conf to the USB drive...'
  Start-Sleep -Seconds 2
  $volumes = @(Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Removable' })
  if ($volumes.Count -eq 0) {
    Write-Host '   [WARN] No drive letter found. Copy rig.conf to the USB root manually.' -ForegroundColor Yellow
  } else {
    $vol = $volumes | Select-Object -First 1
    Copy-Item $RigConf ("$($vol.DriveLetter):\rig.conf") -Force
    Write-Host "   rig.conf written to $($vol.DriveLetter):\rig.conf" -ForegroundColor Green
  }
}

# 恢复 -KeepConfig 备份
if ($savedRigConf) {
  Write-Step 'Restoring the previous rig.conf...'
  Start-Sleep -Seconds 2
  $vol = @(Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Removable' }) | Select-Object -First 1
  if ($vol) {
    Copy-Item $savedRigConf ("$($vol.DriveLetter):\rig.conf") -Force
    Write-Host "   rig.conf restored to $($vol.DriveLetter):\rig.conf" -ForegroundColor Green
    Remove-Item $savedRigConf -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "   [WARN] Could not restore rig.conf automatically. Backup kept at: $savedRigConf" -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host 'DONE' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Boot the mining rig from this USB (set USB first in BIOS, or press F12/F8).'
Write-Host '  2. On first boot, rig.conf is picked up and the rig registers with the server.'
Write-Host '  3. The console shows the rig IP; open http://<IP>:4000 for the local dashboard.'
