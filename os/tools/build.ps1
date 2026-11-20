<#
.SYNOPSIS
  Build a MinerOS image (Windows entry point).

.DESCRIPTION
  Builds the Linux image inside WSL2 (recommended) or Docker.

  One-time setup (Administrator PowerShell):
    wsl --install -d Ubuntu
    # then inside Ubuntu:
    sudo apt update && sudo apt install -y live-build debootstrap xorriso mtools dosfstools `
      squashfs-tools syslinux syslinux-common isolinux grub-pc-bin grub-efi-amd64-bin `
      rsync curl wget gnupg xz-utils zstd parted ca-certificates

  Then:
    .\build.ps1              # build
    .\build.ps1 -Clean       # purge and rebuild
    .\build.ps1 -Docker      # build with Docker Desktop

.NOTES
  Output: os\dist\mineros-1.0.0-amd64.iso + .sha256
#>
[CmdletBinding()]
param(
  [switch]$Clean,
  [switch]$Docker,
  [switch]$NoIso
)

$ErrorActionPreference = 'Stop'
$OsDir = Split-Path -Parent $PSScriptRoot
$ProjectRoot = Split-Path -Parent $OsDir

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path (Join-Path $OsDir 'dist') | Out-Null

function Show-Result {
  $iso = Get-ChildItem (Join-Path $OsDir 'dist') -Filter '*.iso' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($iso) {
    Write-Host ''
    Write-Host 'BUILD OK' -ForegroundColor Green
    Write-Host ('   {0}  ({1:N1} MB)' -f $iso.FullName, ($iso.Length / 1MB))
    $sha = "$($iso.FullName).sha256"
    if (Test-Path $sha) { Get-Content $sha | ForEach-Object { Write-Host "   $_" } }
    Write-Host ''
    Write-Host 'Next: flash a USB drive (Administrator PowerShell)' -ForegroundColor Cyan
    Write-Host ('   .\os\tools\flash-usb.ps1 -Iso "{0}"' -f $iso.FullName)
  }
}

if ($Docker) {
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if (-not $docker) { Fail 'docker not found. Install Docker Desktop or use WSL2 mode (without -Docker).' }
  Write-Step 'Building with Docker'
  $buildArgs = @()
  if ($Clean) { $buildArgs += '--clean' }
  if ($NoIso) { $buildArgs += '--no-iso' }
  & bash (Join-Path $OsDir 'build/build-docker.sh') @buildArgs
  if ($LASTEXITCODE -ne 0) { Fail 'Docker build failed.' }
  Show-Result
  return
}

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl) { Fail 'WSL2 not installed. Run "wsl --install -d Ubuntu" as Administrator, or use -Docker.' }

Write-Step 'Checking WSL distributions'
$distros = & wsl.exe -l -q 2>$null
if ($LASTEXITCODE -ne 0 -or -not $distros) { Fail 'No WSL distribution. Run: wsl --install -d Ubuntu' }
$distro = ($distros | Where-Object { $_ -match 'Ubuntu' } | Select-Object -First 1)
if (-not $distro) { $distro = ($distros | Select-Object -First 1) }
$distro = $distro.Trim()
Write-Step "Using WSL distro: $distro"

$wslRoot = (& wsl.exe -d $distro -- wslpath -a "$ProjectRoot").Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslRoot) { Fail 'Could not map the project path into WSL.' }
Write-Step "Project path: $wslRoot"

$check = & wsl.exe -d $distro -- bash -lc "command -v lb >/dev/null && command -v debootstrap >/dev/null && echo OK || echo MISSING"
if ($check -notmatch 'OK') {
  Write-Host ''
  Write-Host 'WSL is missing build tools. Run this once inside Ubuntu:' -ForegroundColor Yellow
  Write-Host '  sudo apt update && sudo apt install -y live-build debootstrap xorriso mtools dosfstools \' -ForegroundColor Yellow
  Write-Host '    squashfs-tools syslinux syslinux-common isolinux grub-pc-bin grub-efi-amd64-bin \' -ForegroundColor Yellow
  Write-Host '    rsync curl wget gnupg xz-utils zstd parted ca-certificates' -ForegroundColor Yellow
  Write-Host ''
  Fail 'Build dependencies are missing.'
}

$buildArgs = @()
if ($Clean) { $buildArgs += '--clean' }
if ($NoIso) { $buildArgs += '--no-iso' }
$cmd = "cd '$wslRoot' && sudo bash os/build/build.sh $($buildArgs -join ' ')"
Write-Step 'Building in WSL (first run takes 20-40 minutes)'
& wsl.exe -d $distro -- bash -lc $cmd
if ($LASTEXITCODE -ne 0) { Fail 'Build failed. See os/build/build.log' }

Show-Result
