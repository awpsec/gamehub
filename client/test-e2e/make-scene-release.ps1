# Build a realistic scene release on a Windows CI runner, the way RUNE/CODEX
# ship them:  rune-mygame.rar + .r00 … .r99 + .s00 …  (old-style volume names)
#   └─ mygame.iso
#        ├─ setup.exe + setup-1.bin … (Inno Setup, disk-spanned)
#        ├─ autorun.inf
#        └─ RUNE\Mygame\Binaries\Win64\{Mygame-Win64-Shipping.exe, steam_api64.dll, steam_emu.ini}
# The "game" exe is a real program: it prints ORIGINAL, the crack's copy prints
# CRACKED — so the E2E can prove the crack really landed.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Iscc = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
  [string]$Rar = 'C:\Program Files\WinRAR\Rar.exe'
)
$ErrorActionPreference = 'Stop'
$work = Join-Path $env:RUNNER_TEMP 'scene-build'
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work, $Out | Out-Null

function New-RandomFile([string]$Path, [int]$Bytes) {
  New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
  $buf = New-Object byte[] $Bytes
  (New-Object System.Random 42).NextBytes($buf)
  [IO.File]::WriteAllBytes($Path, $buf)
}
function New-Exe([string]$Path, [string]$Says) {
  New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
  $src = Join-Path $work "p-$Says.cs"
  "class P { static void Main() { System.Console.WriteLine(`"$Says`"); } }" | Set-Content $src
  & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /out:$Path $src | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "csc failed" }
  # real game binaries are big; pad (PE overlay is ignored by the loader)
  $pad = New-Object byte[] (2MB); $fs = [IO.File]::Open($Path, 'Append'); $fs.Write($pad, 0, $pad.Length); $fs.Close()
}

# --- the game Inno installs ---
$game = Join-Path $work 'game'
New-Exe (Join-Path $game 'Mygame\Binaries\Win64\Mygame-Win64-Shipping.exe') 'ORIGINAL'
New-RandomFile (Join-Path $game 'Mygame\Binaries\Win64\steam_api64.dll') 300KB
New-RandomFile (Join-Path $game 'Engine\Binaries\ThirdParty\Steamworks\Steamv153\Win64\steam_api64.dll') 300KB
New-RandomFile (Join-Path $game 'Mygame\Content\Paks\Mygame-WindowsNoEditor.pak') 36MB
New-RandomFile (Join-Path $game 'Mygame.exe') 180KB  # UE root bootstrap stub

# --- Inno Setup, disk-spanned like scene setups ---
$iss = Join-Path $work 'mygame.iss'
@"
[Setup]
AppName=Mygame
AppVersion=1.0
AppPublisher=Gamehub E2E
DefaultDirName={autopf}\Mygame
DisableProgramGroupPage=yes
OutputDir=$work\iso
OutputBaseFilename=setup
DiskSpanning=yes
DiskSliceSize=12000000
SlicesPerDisk=1
Compression=none
PrivilegesRequired=lowest
[Files]
Source: "$game\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
"@ | Set-Content $iss
& $Iscc /Q $iss | Out-Host
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }

# --- ISO contents: setup + autorun + the group's crack folder ---
$iso = Join-Path $work 'iso'
"[autorun]`r`nopen=setup.exe`r`n" | Set-Content (Join-Path $iso 'autorun.inf')
"RUNE presents Mygame" | Set-Content (Join-Path $iso 'rune-mygame.nfo')
$crack = Join-Path $iso 'RUNE\Mygame\Binaries\Win64'
New-Exe (Join-Path $crack 'Mygame-Win64-Shipping.exe') 'CRACKED'
'EMU' | Set-Content (Join-Path $crack 'steam_api64.dll')
"[Settings]`r`nLanguage=english`r`n" | Set-Content (Join-Path $crack 'steam_emu.ini')
Get-ChildItem -Recurse $iso | Select-Object FullName, Length | Format-Table -AutoSize | Out-Host

# --- write the ISO with Windows' own IMAPI2 ---
Add-Type -TypeDefinition @'
using System; using System.IO; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public static class IsoWriter {
  public static void Write(string path, object stream, int blockSize, int totalBlocks) {
    var s = (IStream)stream; var buf = new byte[blockSize]; IntPtr read = Marshal.AllocHGlobal(4);
    try { using (var f = File.Create(path)) { for (int i = 0; i < totalBlocks; i++) { s.Read(buf, blockSize, read); f.Write(buf, 0, Marshal.ReadInt32(read)); } } }
    finally { Marshal.FreeHGlobal(read); }
  }
}
'@
$fsi = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$fsi.FileSystemsToCreate = 3  # ISO9660 + Joliet
$fsi.VolumeName = 'MYGAME'
$fsi.Root.AddTree($iso, $false)
$img = $fsi.CreateResultImage()
$isoPath = Join-Path $work 'mygame.iso'
[IsoWriter]::Write($isoPath, $img.ImageStream, $img.BlockSize, $img.TotalBlocks)
"ISO: $((Get-Item $isoPath).Length) bytes"

# --- old-style RAR volumes, small enough to run past .r99 into .s00+ ---
Push-Location $Out
& $Rar a -m0 -v400k -vn -ep1 -idq 'rune-mygame.rar' $isoPath | Out-Host
if ($LASTEXITCODE -ne 0) { throw "rar failed ($LASTEXITCODE)" }
"RUNE presents Mygame" | Set-Content 'rune-mygame.nfo'
Pop-Location
$vols = Get-ChildItem $Out -Filter 'rune-mygame.*'
"volumes: $($vols.Count)  (last: $(($vols | Sort-Object Name | Select-Object -Last 3).Name -join ', '))"
if (-not (Test-Path (Join-Path $Out 'rune-mygame.s00'))) { throw 'expected the set to roll over to .s00' }
