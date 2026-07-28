# Elevated game launcher — run by Task Scheduler with highest privileges.
# Unelevated Gamehub drops request.json into -BridgeDir, then schtasks /Run.
# We Start-Process the exe and write response.json { ok, pid } (or { ok:false, error }).
param(
  [Parameter(Mandatory = $true)][string]$BridgeDir
)

$ErrorActionPreference = 'Stop'
$reqPath = Join-Path $BridgeDir 'request.json'
$respPath = Join-Path $BridgeDir 'response.json'

function Write-Resp($obj) {
  # Windows PowerShell 5.1's UTF8 encoding writes a BOM that breaks JSON.parse in Node.
  $json = ($obj | ConvertTo-Json -Compress)
  [System.IO.File]::WriteAllText($respPath, $json, [System.Text.UTF8Encoding]::new($false))
}

try {
  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Test-Path -LiteralPath $reqPath)) {
    if ((Get-Date) -ge $deadline) {
      Write-Resp @{ ok = $false; error = 'no-request' }
      exit 1
    }
    Start-Sleep -Milliseconds 100
  }

  $raw = [System.IO.File]::ReadAllText($reqPath)
  $req = $raw | ConvertFrom-Json
  if (-not $req.exe) {
    Write-Resp @{ ok = $false; error = 'bad-request' }
    exit 1
  }

  $exe = [string]$req.exe
  $cwd = if ($req.cwd) { [string]$req.cwd } else { Split-Path -Parent $exe }
  if (-not (Test-Path -LiteralPath $exe)) {
    Write-Resp @{ ok = $false; error = 'exe-missing' }
    exit 1
  }

  $p = Start-Process -FilePath $exe -WorkingDirectory $cwd -PassThru -WindowStyle Normal
  if (-not $p -or -not $p.Id) {
    Write-Resp @{ ok = $false; error = 'start-failed' }
    exit 1
  }
  Write-Resp @{ ok = $true; pid = [int]$p.Id }
  exit 0
} catch {
  try { Write-Resp @{ ok = $false; error = $_.Exception.Message } } catch { }
  exit 1
}
