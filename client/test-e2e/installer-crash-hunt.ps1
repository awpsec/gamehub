# Install + uninstall a Gamehub installer N times on a clean machine and count
# crashes (exit 0xC0000005). Prints the faulting module from Windows Error
# Reporting for each crash.   -Setup <Gamehub-Setup.exe> -Runs 15 -Label custom
param([Parameter(Mandatory = $true)][string]$Setup, [int]$Runs = 15, [string]$Label = 'build')
$ErrorActionPreference = 'Continue'
$crashes = 0; $fails = 0
for ($i = 1; $i -le $Runs; $i++) {
  $t0 = Get-Date
  $p = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru
  if (-not $p.WaitForExit(180000)) { try { $p.Kill() } catch {}; "[$Label] run $i HUNG (killed after 180 s)"; $fails++; continue }
  $code = $p.ExitCode
  $exe = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter 'Gamehub.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  $line = "[$Label] run $i install exit=$code installed=$([bool]$exe)"
  if ($code -eq -1073741819) {
    $crashes++
    $ev = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; StartTime = $t0.AddSeconds(-2) } -MaxEvents 2 -ErrorAction SilentlyContinue
    foreach ($e in $ev) { $line += "`n    WER: " + (($e.Message -replace '\s+', ' ').Substring(0, [Math]::Min(600, ($e.Message -replace '\s+', ' ').Length))) }
  } elseif ($code -ne 0 -or -not $exe) { $fails++ }
  $line
  # uninstall to get back to a clean slate
  $un = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter 'Uninstall Gamehub.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($un) { Start-Process -FilePath $un.FullName -ArgumentList '/S' -Wait; Start-Sleep -Seconds 3 }
  Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\gamehub-client" -ErrorAction SilentlyContinue
}
"[$Label] $crashes crash(es), $fails other failure(s) in $Runs fresh installs"
"$Label=$crashes" | Out-File -Append "$env:RUNNER_TEMP\crash-hunt.txt"
