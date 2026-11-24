# Gamehub's own installer on a real Windows box (CI):
#   1. fresh per-user install, bundled 7-Zip present
#   2. only ONE Gamehub runs — a second launch hands over and exits
#   3. installing an update over a RUNNING Gamehub (what the in-app updater
#      does) closes it via the quit request, installs, and relaunches it
param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = 'Stop'
$fail = @()
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Host "ok   $name" } else { Write-Host "FAIL $name $detail"; $script:fail += $name }
}
function MainProcs {
  # Electron: one main process + helpers (--type=gpu-process, renderer, …)
  @(Get-CimInstance Win32_Process -Filter "Name='Gamehub.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' })
}
function WaitFor([scriptblock]$cond, [int]$seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
  return [bool](& $cond)
}

# 1. install
$p = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru -Wait
Check 'installer exit code 0' ($p.ExitCode -eq 0) "exit=$($p.ExitCode)"
if ($p.ExitCode -ne 0) {
  # what crashed? (Windows Error Reporting → Application log, event 1000)
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000 } -MaxEvents 3 -ErrorAction SilentlyContinue |
    ForEach-Object { $_.TimeCreated.ToString('s') + '  ' + ($_.Message -split "`n" | Select-Object -First 8) -join ' ' } | Out-Host
}
$exe = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter 'Gamehub.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
Check 'Gamehub.exe installed' ($null -ne $exe)
if (-not $exe) { exit 1 }
$appDir = $exe.DirectoryName
"installed to $appDir"
$sz = Join-Path $appDir 'resources\7zip\7z.exe'
Check 'bundled 7-Zip shipped' (Test-Path $sz)
if (Test-Path $sz) {
  $info = & $sz i
  Check 'bundled 7-Zip reads RAR + ISO' ((($info -match '\bRar5?\b').Count -gt 0) -and (($info -match '\bIso\b').Count -gt 0))
}

# 2. single instance
Start-Process -FilePath $exe.FullName | Out-Null
Check 'Gamehub starts' (WaitFor { (MainProcs).Count -eq 1 } 40)
$first = (MainProcs)[0].ProcessId
Start-Sleep -Seconds 6
Start-Process -FilePath $exe.FullName | Out-Null
Start-Sleep -Seconds 10
$now = MainProcs
Check 'second launch does not open a second Gamehub' ($now.Count -eq 1 -and $now[0].ProcessId -eq $first) "main processes: $($now.ProcessId -join ',')"

# 3. update over the running app — same flags electron-updater passes
# diagnostics: the stock installer's own "is it running?" probe
$probe = cmd /c "tasklist /FI `"USERNAME eq %USERNAME%`" /FI `"IMAGENAME eq Gamehub.exe`" /FO csv | find `"Gamehub.exe`""
"stock tasklist probe → exit $LASTEXITCODE`n$probe"
$t0 = Get-Date
$p = Start-Process -FilePath $Setup -ArgumentList '/S', '--updated', '--force-run' -PassThru
$sawRequest = $false
$end = (Get-Date).AddSeconds(180)
while (-not $p.HasExited -and (Get-Date) -lt $end) {
  if (Test-Path "$env:APPDATA\Gamehub\quit-for-update") { $sawRequest = $true }
  Start-Sleep -Milliseconds 100
}
$done = $p.HasExited
"quit request seen on disk: $sawRequest"
if (-not $done) {
  'installer still running — its process tree:'
  Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $p.Id -or $_.ProcessId -eq $p.Id } | Select-Object ProcessId, Name, CommandLine | Format-List | Out-Host
}
Check 'update installer finished' ($done -and $p.ExitCode -eq 0) "done=$done exit=$($p.ExitCode)"
"update took $([int]((Get-Date) - $t0).TotalSeconds)s"
Check 'old Gamehub closed' (-not (Get-Process -Id $first -ErrorAction SilentlyContinue))
Check 'Gamehub reopened after the update' (WaitFor { (MainProcs | Where-Object { $_.ProcessId -ne $first }).Count -ge 1 } 40)
Check 'quit request cleaned up' (-not (Test-Path "$env:APPDATA\Gamehub\quit-for-update"))
$log = "$env:APPDATA\Gamehub\logs\updater.log"
$logText = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
"--- updater.log ---`n$logText"
Check 'Gamehub quit on the installer''s request' ($logText -match 'installer asked Gamehub to quit')
Check 'start logged with version' ($logText -match 'started v\d')

Get-Process Gamehub -ErrorAction SilentlyContinue | Stop-Process -Force
if ($fail.Count) { Write-Host "`n$($fail.Count) check(s) failed"; exit 1 }
Write-Host "`nall checks passed"
