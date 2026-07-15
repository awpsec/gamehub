# Runs elevated (via UAC once). Starts silent Inno setup already elevated,
# then aggressively kills DirectX / VC++ / OpenAL / promo helpers that FitGirl
# still launches because those checkboxes default to ON under /VERYSILENT.
# Unelevated watchdogs cannot Stop-Process elevated redist installers — this can.
param(
  [Parameter(Mandatory = $true)][string]$SetupExe,
  [Parameter(Mandatory = $true)][string]$ArgsFile,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(Mandatory = $true)][string]$StartedFile,
  [string]$StopFile = '',
  [int]$PollMs = 40,
  [int]$PostExitSweepSeconds = 20
)

$ErrorActionPreference = 'SilentlyContinue'

function Test-RedistProcessName([string]$BaseName) {
  if ([string]::IsNullOrWhiteSpace($BaseName)) { return $false }
  $n = $BaseName.ToLowerInvariant()
  if ($n -eq 'dxsetup' -or $n -eq 'dxwebsetup' -or $n -eq 'oalinst') { return $true }
  if ($n -match 'vcredist|vc_redist') { return $true }
  if ($n -match '^dotnetfx|^ndp\d|physx|xnafx|ue4prereq|ue5prereq') { return $true }
  if ($n -match 'directx') { return $true }
  return $false
}

function Test-RedistCommandLine([string]$Cmd) {
  if ([string]::IsNullOrWhiteSpace($Cmd)) { return $false }
  if ($Cmd -match 'vcredist|VC_redist|VCRedist|DXSETUP|dxwebsetup|oalinst') { return $true }
  if ($Cmd -match 'DirectX.{0,80}(Setup|Redistributable|Runtime)|\\DirectX\\') { return $true }
  if ($Cmd -match '\\_?CommonRedist\\|\\_Redist\\|\\Redist\\') { return $true }
  if ($Cmd -match 'dotnetfx|NDP\d+|PhysX|XNAFX') { return $true }
  if ($Cmd -match 'fitgirl-repacks|fitgirl\.site|paste\.fitgirl|fg-repacks') { return $true }
  return $false
}

function Test-PromoHost([string]$BaseName) {
  if ([string]::IsNullOrWhiteSpace($BaseName)) { return $false }
  $n = $BaseName.ToLowerInvariant()
  return ($n -match '^(chrome|msedge|firefox|iexplore|brave|opera|cmd|powershell|pwsh|rundll32|explorer)$')
}

function Stop-AllExtras([int]$ProtectPid) {
  try {
    $rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Select-Object ProcessId, Name, CommandLine
  } catch { return }

  foreach ($row in $rows) {
    if ($null -eq $row.ProcessId) { continue }
    $procId = [int]$row.ProcessId
    if ($ProtectPid -gt 0 -and $procId -eq $ProtectPid) { continue }
    if ($procId -eq $PID) { continue }

    $base = [IO.Path]::GetFileNameWithoutExtension([string]$row.Name)
    $cmd = [string]$row.CommandLine
    $kill = $false

    if (Test-RedistProcessName $base) { $kill = $true }
    elseif (Test-RedistCommandLine $cmd) {
      # msiexec / cmd wrappers launching a redist payload
      if ($base -match '^(msiexec|cmd|powershell|pwsh|conhost)$' -or (Test-RedistProcessName $base)) {
        $kill = $true
      } elseif ($cmd -match 'fitgirl-repacks|fitgirl\.site' -and (Test-PromoHost $base)) {
        $kill = $true
      } elseif ($cmd -match '\\_?CommonRedist\\|\\_Redist\\|\\DirectX\\') {
        # setup.exe under a DirectX/_Redist folder is a redist, not the game setup
        # (game setup is protected via ProtectPid).
        if ($base -match 'setup|install|redist|dx|vc') { $kill = $true }
      }
    }

    if ($kill) {
      try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch { }
      try { & taskkill.exe /F /PID $procId 2>$null | Out-Null } catch { }
    }
  }
}

if (-not (Test-Path -LiteralPath $SetupExe)) { exit 2 }
if (-not (Test-Path -LiteralPath $ArgsFile)) { exit 2 }

$argList = @(Get-Content -LiteralPath $ArgsFile -ErrorAction Stop | ForEach-Object { "$_".TrimEnd() } | Where-Object { $_ -ne '' })
if (-not (Test-Path -LiteralPath $WorkingDirectory)) {
  $WorkingDirectory = Split-Path -Parent $SetupExe
}

try {
  if ($StartedFile -and (Test-Path -LiteralPath $StartedFile)) {
    Remove-Item -LiteralPath $StartedFile -Force -ErrorAction SilentlyContinue
  }
} catch { }

$p = $null
try {
  $p = Start-Process -FilePath $SetupExe -ArgumentList $argList -WorkingDirectory $WorkingDirectory -PassThru -WindowStyle Hidden
} catch {
  exit 1
}
if ($null -eq $p) { exit 1 }

try {
  Set-Content -LiteralPath $StartedFile -Value ([string]$p.Id) -Encoding ASCII -Force
} catch { }

while ($true) {
  if ($StopFile -and (Test-Path -LiteralPath $StopFile)) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
    try { & taskkill.exe /F /T /PID $p.Id 2>$null | Out-Null } catch { }
    exit 1223
  }
  try { $p.Refresh() } catch { }
  if ($p.HasExited) { break }
  Stop-AllExtras -ProtectPid ([int]$p.Id)
  Start-Sleep -Milliseconds $PollMs
}

# FitGirl often kicks DirectX/VC++ as post-install [Run] entries — sweep after exit.
$deadline = (Get-Date).AddSeconds($PostExitSweepSeconds)
$idle = 0
while ((Get-Date) -lt $deadline) {
  if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }
  $before = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    Test-RedistProcessName $_.ProcessName
  })
  Stop-AllExtras -ProtectPid 0
  Start-Sleep -Milliseconds $PollMs
  if ($before.Count -eq 0) {
    $idle++
    if ($idle -ge 25) { break } # ~1s with no redists seen
  } else {
    $idle = 0
  }
}

$code = 0
try { $code = [int]$p.ExitCode } catch { $code = 0 }
exit $code
