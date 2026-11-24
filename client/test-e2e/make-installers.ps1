# Build one real installer of every type Gamehub automates, on a Windows CI
# runner. Each installs a tiny "game": <Name>.exe prints "<NAME>-OK".
#   nsis\setup.exe     NSIS               (makensis)
#   msi\game.msi       Windows Installer  (WiX 5)
#   burn\setup.exe     WiX Burn bundle    (chains its own MSI, InstallFolder var)
#   sfx\setup.exe      7-Zip self-extractor
#   dlc\setup.exe      Inno Setup DLC     (adds DLC\dlc.pak to an installed game)
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$work = Join-Path $env:RUNNER_TEMP 'engines-build'
Remove-Item -Recurse -Force $work, $Out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work, $Out | Out-Null

function New-Game([string]$Dir, [string]$Name) {
  New-Item -ItemType Directory -Force $Dir | Out-Null
  $src = Join-Path $work "$Name.cs"
  "class P { static void Main() { System.Console.WriteLine(`"$($Name.ToUpper())-OK`"); } }" | Set-Content $src
  & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /out:(Join-Path $Dir "$Name.exe") $src | Out-Host
  if ($LASTEXITCODE) { throw 'csc failed' }
  $pad = New-Object byte[] (3MB); $fs = [IO.File]::Open((Join-Path $Dir "$Name.exe"), 'Append'); $fs.Write($pad, 0, $pad.Length); $fs.Close()
  $data = New-Object byte[] (12MB); (New-Object System.Random 7).NextBytes($data)
  New-Item -ItemType Directory -Force (Join-Path $Dir 'data') | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $Dir 'data\content.pak'), $data)
}

# --- NSIS ---
$g = Join-Path $work 'nsisgame'; New-Game $g 'NsisGame'
@"
Name "NsisGame"
OutFile "$Out\nsis\setup.exe"
InstallDir "`$PROGRAMFILES\NsisGame"
RequestExecutionLevel user
Section
  SetOutPath `$INSTDIR
  File /r "$g\*"
  WriteUninstaller "`$INSTDIR\uninstall.exe"
SectionEnd
Section "Uninstall"
  RMDir /r `$INSTDIR
SectionEnd
"@ | Set-Content (Join-Path $work 'nsis.nsi')
New-Item -ItemType Directory -Force (Join-Path $Out 'nsis') | Out-Null
& 'C:\Program Files (x86)\NSIS\makensis.exe' /V2 (Join-Path $work 'nsis.nsi') | Out-Host
if ($LASTEXITCODE) { throw 'makensis failed' }

# --- MSI (WiX 5) ---
function New-Msi([string]$GameName, [string]$OutFile, [string]$Upgrade) {
  $gd = Join-Path $work $GameName.ToLower(); New-Game $gd $GameName
  $wxs = Join-Path $work "$GameName.wxs"
  @"
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="$GameName" Manufacturer="Gamehub E2E" Version="1.0.0" UpgradeCode="$Upgrade" Scope="perMachine">
    <MediaTemplate EmbedCab="yes" />
    <StandardDirectory Id="ProgramFiles6432Folder">
      <Directory Id="INSTALLFOLDER" Name="$GameName" />
    </StandardDirectory>
    <Feature Id="Main"><ComponentGroupRef Id="GameFiles" /></Feature>
    <ComponentGroup Id="GameFiles" Directory="INSTALLFOLDER">
      <Files Include="$gd\**" />
    </ComponentGroup>
  </Package>
</Wix>
"@ | Set-Content $wxs
  New-Item -ItemType Directory -Force (Split-Path $OutFile) | Out-Null
  & wix build $wxs -o $OutFile | Out-Host
  if ($LASTEXITCODE) { throw "wix build $GameName failed" }
}
New-Msi 'MsiGame' (Join-Path $Out 'msi\game.msi') '6B1E4C3A-2F11-4B4B-9A37-1F0E6B7E0A01'

# --- WiX Burn bundle chaining its own MSI ---
New-Msi 'BundleGame' (Join-Path $work 'bundlegame.msi') '6B1E4C3A-2F11-4B4B-9A37-1F0E6B7E0A02'
@"
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" xmlns:bal="http://wixtoolset.org/schemas/v4/wxs/bal">
  <Bundle Name="BundleGame" Version="1.0.0" Manufacturer="Gamehub E2E" UpgradeCode="6B1E4C3A-2F11-4B4B-9A37-1F0E6B7E0A03">
    <BootstrapperApplication>
      <bal:WixStandardBootstrapperApplication LicenseUrl="https://example.com/license" Theme="hyperlinkLicense" />
    </BootstrapperApplication>
    <Variable Name="InstallFolder" Type="formatted" Value="[ProgramFiles6432Folder]BundleGame" bal:Overridable="yes" />
    <Chain>
      <MsiPackage SourceFile="$work\bundlegame.msi">
        <MsiProperty Name="INSTALLFOLDER" Value="[InstallFolder]" />
      </MsiPackage>
    </Chain>
  </Bundle>
</Wix>
"@ | Set-Content (Join-Path $work 'bundle.wxs')
New-Item -ItemType Directory -Force (Join-Path $Out 'burn') | Out-Null
& wix build (Join-Path $work 'bundle.wxs') -ext WixToolset.Bal.wixext -o (Join-Path $Out 'burn\setup.exe') | Out-Host
if ($LASTEXITCODE) { throw 'wix build bundle failed' }

# --- 7-Zip self-extractor ---
$g = Join-Path $work 'sfxgame'; New-Game $g 'SfxGame'
New-Item -ItemType Directory -Force (Join-Path $Out 'sfx') | Out-Null
& 'C:\Program Files\7-Zip\7z.exe' a -sfx7z.sfx (Join-Path $Out 'sfx\setup.exe') "$g\*" | Out-Host
if ($LASTEXITCODE) { throw '7z sfx failed' }

# --- Inno DLC that installs into an existing game folder ---
$dlc = Join-Path $work 'dlcfiles'; New-Item -ItemType Directory -Force (Join-Path $dlc 'DLC') | Out-Null
$buf = New-Object byte[] (2MB); (New-Object System.Random 9).NextBytes($buf); [IO.File]::WriteAllBytes((Join-Path $dlc 'DLC\dlc.pak'), $buf)
@"
[Setup]
AppName=Mygame Expansion
AppVersion=1.0
DefaultDirName={autopf}\Mygame
DisableDirPage=no
OutputDir=$Out\dlc
OutputBaseFilename=setup
Uninstallable=no
PrivilegesRequired=lowest
[Files]
Source: "$dlc\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
"@ | Set-Content (Join-Path $work 'dlc.iss')
& 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' /Q (Join-Path $work 'dlc.iss') | Out-Host
if ($LASTEXITCODE) { throw 'ISCC dlc failed' }

Get-ChildItem -Recurse $Out -File | Select-Object FullName, Length | Format-Table -AutoSize | Out-Host
