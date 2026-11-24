# Install the tools CI uses to BUILD test releases (never shipped with Gamehub).
# Chocolatey's community feed has outages (503/504), so each tool: already
# there → skip; else Chocolatey with retries; else the project's official
# download, installed silently.
param([string[]]$Tools = @('innosetup', 'nsis', 'winrar'))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$spec = @{
  innosetup = @{ Exe = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'; Url = 'https://jrsoftware.org/download.php/is.exe'; Args = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-' }
  nsis      = @{ Exe = 'C:\Program Files (x86)\NSIS\makensis.exe'; Url = 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.10/nsis-3.10-setup.exe'; Args = '/S' }
  winrar    = @{ Exe = 'C:\Program Files\WinRAR\Rar.exe'; Url = 'https://www.rarlab.com/rar/winrar-x64-723.exe'; Args = '/S' }
}

foreach ($t in $Tools) {
  $s = $spec[$t]
  if (Test-Path $s.Exe) { "${t}: already installed"; continue }
  for ($i = 1; $i -le 3 -and -not (Test-Path $s.Exe); $i++) {
    choco install $t -y --no-progress | Out-Host
    if (-not (Test-Path $s.Exe)) { Start-Sleep -Seconds (20 * $i) }
  }
  if (-not (Test-Path $s.Exe)) {
    "${t}: Chocolatey unavailable — official download"
    $dl = Join-Path $env:RUNNER_TEMP "$t-setup.exe"
    for ($i = 1; $i -le 3; $i++) {
      try { Invoke-WebRequest -Uri $s.Url -OutFile $dl -UserAgent 'Mozilla/5.0' -MaximumRedirection 10; break } catch { "download attempt $i failed: $($_.Exception.Message)"; Start-Sleep -Seconds (10 * $i) }
    }
    Start-Process -FilePath $dl -ArgumentList $s.Args -Wait
  }
  if (-not (Test-Path $s.Exe)) { throw "${t} could not be installed" }
  "${t}: ok ($($s.Exe))"
}
