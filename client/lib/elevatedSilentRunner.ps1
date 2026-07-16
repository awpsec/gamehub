# Runs elevated (via UAC once). Starts silent Inno setup already elevated,
# then aggressively kills DirectX / VC++ / OpenAL / promo helpers that FitGirl
# still launches because those checkboxes default to ON under /VERYSILENT.
#
# Handshake files (unelevated parent must NOT trust HasExited on this process):
#   AliveFile   — written FIRST after UAC accept (proves elevation worked)
#   StartedFile — setup.exe PID once launched
#   DoneFile    — final exit code when this runner finishes
param(
  [Parameter(Mandatory = $true)][string]$SetupExe,
  [Parameter(Mandatory = $true)][string]$ArgsFile,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(Mandatory = $true)][string]$StartedFile,
  [Parameter(Mandatory = $true)][string]$AliveFile,
  [Parameter(Mandatory = $true)][string]$DoneFile,
  [string]$StopFile = '',
  [int]$PollMs = 40,
  [int]$PostExitSweepSeconds = 20
)

$ErrorActionPreference = 'SilentlyContinue'
$script:exitCode = 1

# Windows-quote one argument for a child command line. Start-Process with an
# ARRAY ArgumentList joins elements with spaces WITHOUT quoting — a spaced
# /DIR=C:\...\Title With Spaces would reach the installer split into pieces
# (installing into a truncated stray folder). Build ONE pre-quoted line instead.
function ConvertTo-QuotedArg([string]$Arg) {
  if ($null -eq $Arg -or $Arg -eq '') { return '""' }
  # NSIS /D= MUST stay unquoted even with spaces — NSIS reads the raw command
  # line tail after /D=, and quoted /D= paths break the install.
  if ($Arg -match '^/D=') { return $Arg }
  if ($Arg -notmatch '[\s"]') { return $Arg }
  $s = $Arg -replace '(\\+)$', '$1$1'   # double trailing backslashes
  $s = $s -replace '(\\*)"', '$1$1\"'   # escape embedded quotes (+ their backslashes)
  return '"' + $s + '"'
}

function Write-Done([int]$Code) {
  $script:exitCode = $Code
  try {
    $dir = Split-Path -Parent $DoneFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Set-Content -LiteralPath $DoneFile -Value ([string]$Code) -Encoding ASCII -Force
  } catch { }
}

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
      if ($base -match '^(msiexec|cmd|powershell|pwsh|conhost)$' -or (Test-RedistProcessName $base)) {
        $kill = $true
      } elseif ($cmd -match 'fitgirl-repacks|fitgirl\.site' -and (Test-PromoHost $base)) {
        $kill = $true
      } elseif ($cmd -match '\\_?CommonRedist\\|\\_Redist\\|\\DirectX\\') {
        if ($base -match 'setup|install|redist|dx|vc') { $kill = $true }
      }
    }

    if ($kill) {
      try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch { }
      try { & taskkill.exe /F /PID $procId 2>$null | Out-Null } catch { }
    }
  }
}

try {
  # Prove UAC was accepted BEFORE touching setup — unelevated parent waits on this.
  try {
    $aliveDir = Split-Path -Parent $AliveFile
    if ($aliveDir -and -not (Test-Path -LiteralPath $aliveDir)) {
      New-Item -ItemType Directory -Path $aliveDir -Force | Out-Null
    }
    Set-Content -LiteralPath $AliveFile -Value ([string]$PID) -Encoding ASCII -Force
  } catch {
    Write-Done 3
    exit 3
  }

  if (-not (Test-Path -LiteralPath $SetupExe)) { Write-Done 2; exit 2 }
  if (-not (Test-Path -LiteralPath $ArgsFile)) { Write-Done 2; exit 2 }

  $argList = @(Get-Content -LiteralPath $ArgsFile -ErrorAction Stop |
    ForEach-Object { "$_".TrimEnd() } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
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
    $argLine = (($argList | ForEach-Object { ConvertTo-QuotedArg $_ }) -join ' ')
    $startParams = @{
      FilePath         = $SetupExe
      WorkingDirectory = $WorkingDirectory
      PassThru         = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($argLine)) {
      $startParams.ArgumentList = $argLine
    }
    # -WindowStyle is Windows-only (pwsh on Linux rejects it).
    if ($IsWindows -or $env:OS -match 'Windows') {
      $startParams.WindowStyle = 'Hidden'
    }
    $p = Start-Process @startParams
  } catch {
    Write-Done 1
    exit 1
  }
  if ($null -eq $p) { Write-Done 1; exit 1 }

  try {
    Set-Content -LiteralPath $StartedFile -Value ([string]$p.Id) -Encoding ASCII -Force
  } catch { }

  while ($true) {
    if ($StopFile -and (Test-Path -LiteralPath $StopFile)) {
      try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
      try { & taskkill.exe /F /T /PID $p.Id 2>$null | Out-Null } catch { }
      # 15 = stopped by parent (not UAC 1223 — that is reserved for consent decline).
      Write-Done 15
      exit 15
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
      if ($idle -ge 25) { break }
    } else {
      $idle = 0
    }
  }

  $code = 0
  try { $code = [int]$p.ExitCode } catch { $code = 0 }
  Write-Done $code
  exit $code
} catch {
  Write-Done 1
  exit 1
}
