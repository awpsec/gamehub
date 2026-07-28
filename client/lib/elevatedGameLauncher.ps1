# Elevated helper — run by Task Scheduler with highest privileges.
# Unelevated Gamehub drops request.json into -BridgeDir, then schtasks /Run.
# Actions: launch (default) | capture
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

function Do-Capture($outPath) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
  $dir = Split-Path -Parent $outPath
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  if (-not (Test-Path -LiteralPath $outPath)) { throw 'capture-empty' }
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
  $action = if ($req.action) { [string]$req.action } else { 'launch' }

  if ($action -eq 'capture') {
    $out = [string]$req.outPath
    if (-not $out) {
      Write-Resp @{ ok = $false; error = 'bad-request' }
      exit 1
    }
    Do-Capture $out
    Write-Resp @{ ok = $true; file = $out }
    exit 0
  }

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
