# Build Gamehub's Windows installer with CURRENT NSIS, not the 2018 NSIS
# 3.0.4.1 electron-builder 24 downloads. That build's System.dll plug-in
# crashes the installer (0xC0000005 at System.dll+0x1581) on current Windows
# (Windows 11 24H2 / Server 2025 core): 7 of 20 fresh installs in CI, vs 0 of
# 20 with NSIS 3.13.
#
# Produces <RUNNER_TEMP>\nsis-current = official NSIS (>= 3.10) + the
# elevate.exe helper electron-builder copies into the app, and exports
# ELECTRON_BUILDER_NSIS_DIR (GITHUB_ENV in CI, and this process).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot

& (Join-Path $root 'test-e2e\install-tools.ps1') -Tools nsis
$makensis = 'C:\Program Files (x86)\NSIS\makensis.exe'
$ver = (& $makensis /VERSION).Trim()
"official NSIS: $ver"
if ($ver -notmatch '^v?(\d+)\.(\d+)' -or ([int]$Matches[1] -lt 3) -or ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -lt 10)) {
  throw "NSIS $ver is too old — need 3.10+ (older System.dll crashes on current Windows)"
}

# elevate.exe from electron-builder's own NSIS bundle, verified with the same
# SHA-512 app-builder-lib pins for it
$tmp = Join-Path $env:RUNNER_TEMP 'eb-nsis'
New-Item -ItemType Directory -Force $tmp | Out-Null
$arc = Join-Path $tmp 'nsis-3.0.4.1.7z'
Invoke-WebRequest -Uri 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z' -OutFile $arc
$sha = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($arc)))
if ($sha -ne 'VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q==') { throw "electron-builder NSIS bundle checksum mismatch: $sha" }
$sz = Join-Path $root 'vendor\7zip\win\7z.exe'
if (-not (Test-Path $sz)) { $sz = 'C:\Program Files\7-Zip\7z.exe' }
& $sz e $arc "-o$tmp" 'elevate.exe' -r -y | Out-Null
if (-not (Test-Path (Join-Path $tmp 'elevate.exe'))) { throw 'elevate.exe not found in the electron-builder NSIS bundle' }

$nd = Join-Path $env:RUNNER_TEMP 'nsis-current'
Remove-Item -Recurse -Force $nd -ErrorAction SilentlyContinue
Copy-Item 'C:\Program Files (x86)\NSIS' $nd -Recurse
Copy-Item (Join-Path $tmp 'elevate.exe') $nd
"ELECTRON_BUILDER_NSIS_DIR=$nd"
$env:ELECTRON_BUILDER_NSIS_DIR = $nd
if ($env:GITHUB_ENV) { "ELECTRON_BUILDER_NSIS_DIR=$nd" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV }
