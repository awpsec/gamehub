# Hard audio guard for silent Inno/FitGirl installs.
# Per-process session mute is NOT enough — FitGirl music often starts at full
# blast before a session exists, and elevated setup audio can ignore it.
# Strategy: mute the system master endpoint immediately, keep forcing it, mute
# every session, kill redist/promo extras, then restore prior volume/mute.
param(
  [int]$RootPid = 0,
  [string]$StopFile = '',
  [string]$PidFile = '',
  [string]$StateFile = '',
  [switch]$MuteOnly,
  [switch]$RestoreOnly,
  [int]$PollMs = 80
)

$ErrorActionPreference = 'SilentlyContinue'
if (-not $StateFile) {
  $StateFile = Join-Path $env:TEMP 'gamehub-audio-guard-state.json'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class GamehubAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  private class MMDeviceEnumeratorComObject { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceEnumerator {
    int NotImpl1();
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  }

  // IAudioEndpointVolume — master device mute/volume (works across elevated apps)
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioEndpointVolume {
    int NotImpl1(); // RegisterControlChangeNotify
    int NotImpl2(); // UnregisterControlChangeNotify
    int NotImpl3(); // GetChannelCount
    int NotImpl4(); // SetMasterVolumeLevel
    [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int NotImpl6(); // GetMasterVolumeLevel
    [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
    int NotImpl8(); // SetChannelVolumeLevel
    int NotImpl9(); // GetChannelVolumeLevel
    int NotImpl10(); // SetChannelVolumeLevelScalar
    int NotImpl11(); // GetChannelVolumeLevelScalar
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
    [PreserveSig] int GetMute(out bool pbMute);
  }

  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionManager2 {
    int NotImpl1();
    int NotImpl2();
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
  }

  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int SessionCount);
    [PreserveSig] int GetSession(int SessionCount, out IAudioSessionControl Session);
  }

  [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionControl { }

  [Guid("87CE5498-68D6-140E-49E3-635806365766"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float fLevel, ref Guid EventContext);
    [PreserveSig] int GetMasterVolume(out float pfLevel);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid EventContext);
    [PreserveSig] int GetMute(out bool pbMute);
  }

  private static IAudioEndpointVolume Vol() {
    var enumerator = (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorComObject();
    IMMDevice device;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
    object o;
    var iid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }

  public static bool GetMute() {
    bool m;
    Marshal.ThrowExceptionForHR(Vol().GetMute(out m));
    return m;
  }

  public static void SetMute(bool mute) {
    Marshal.ThrowExceptionForHR(Vol().SetMute(mute, Guid.Empty));
  }

  public static float GetVolume() {
    float v;
    Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v));
    return v;
  }

  public static void SetVolume(float v) {
    if (v < 0f) v = 0f;
    if (v > 1f) v = 1f;
    Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, Guid.Empty));
  }

  public static void ForceSilent() {
    try { SetMute(true); } catch { }
    try { SetVolume(0f); } catch { }
    MuteAllSessions();
  }

  public static void MuteAllSessions() {
    IMMDeviceEnumerator enumerator = null;
    IMMDevice device = null;
    IAudioSessionManager2 mgr = null;
    IAudioSessionEnumerator sessions = null;
    try {
      enumerator = (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorComObject();
      if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0 || device == null) return;
      object o;
      var iid = typeof(IAudioSessionManager2).GUID;
      if (device.Activate(ref iid, 23, IntPtr.Zero, out o) != 0 || o == null) return;
      mgr = (IAudioSessionManager2)o;
      if (mgr.GetSessionEnumerator(out sessions) != 0 || sessions == null) return;
      int count;
      sessions.GetCount(out count);
      var empty = Guid.Empty;
      for (int i = 0; i < count; i++) {
        IAudioSessionControl ctl = null;
        try {
          if (sessions.GetSession(i, out ctl) != 0 || ctl == null) continue;
          var vol = ctl as ISimpleAudioVolume;
          if (vol == null) continue;
          vol.SetMute(true, ref empty);
          vol.SetMasterVolume(0f, ref empty);
        } catch {
        } finally {
          if (ctl != null) Marshal.ReleaseComObject(ctl);
        }
      }
    } catch {
    } finally {
      if (sessions != null) Marshal.ReleaseComObject(sessions);
      if (mgr != null) Marshal.ReleaseComObject(mgr);
      if (device != null) Marshal.ReleaseComObject(device);
      if (enumerator != null) Marshal.ReleaseComObject(enumerator);
    }
  }
}
'@

function Save-AudioState {
  param([string]$Path)
  try {
    $mute = [GamehubAudio]::GetMute()
    $vol = [GamehubAudio]::GetVolume()
    $obj = @{ muted = [bool]$mute; volume = [double]$vol; savedAt = (Get-Date).ToString('o') }
    ($obj | ConvertTo-Json -Compress) | Set-Content -Path $Path -Encoding UTF8 -Force
  } catch { }
}

function Restore-AudioState {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  try {
    $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    $obj = $raw | ConvertFrom-Json
    if ($null -ne $obj.volume) {
      try { [GamehubAudio]::SetVolume([float]$obj.volume) } catch { }
    }
    if ($null -ne $obj.muted) {
      try { [GamehubAudio]::SetMute([bool]$obj.muted) } catch { }
    }
  } catch { }
  try { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue } catch { }
}

if ($RestoreOnly) {
  Restore-AudioState -Path $StateFile
  exit 0
}

# Mute BEFORE any installer audio can start (also used via -MuteOnly for a sync pre-mute).
if (-not (Test-Path -LiteralPath $StateFile)) {
  Save-AudioState -Path $StateFile
}
try { [GamehubAudio]::ForceSilent() } catch { }

if ($MuteOnly) {
  exit 0
}

function Get-EffectiveRootPid {
  if ($PidFile -and (Test-Path -LiteralPath $PidFile)) {
    try {
      $t = (Get-Content -LiteralPath $PidFile -Raw).Trim()
      $n = 0
      if ([int]::TryParse($t, [ref]$n) -and $n -gt 0) { return $n }
    } catch { }
  }
  return $RootPid
}

function Get-ProcessTreeIds([int]$Root) {
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  if ($Root -le 0) { return @() }
  [void]$ids.Add($Root)
  try {
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Select-Object ProcessId, ParentProcessId
    $changed = $true
    while ($changed) {
      $changed = $false
      foreach ($row in $all) {
        if ($null -eq $row.ProcessId) { continue }
        $childId = [int]$row.ProcessId
        $parentId = [int]$row.ParentProcessId
        if ($ids.Contains($parentId) -and -not $ids.Contains($childId)) {
          [void]$ids.Add($childId)
          $changed = $true
        }
      }
    }
  } catch { }
  return @($ids)
}

function Test-RedistProcessName([string]$BaseName) {
  if ([string]::IsNullOrWhiteSpace($BaseName)) { return $false }
  $n = $BaseName.ToLowerInvariant()
  if ($n -eq 'dxsetup' -or $n -eq 'dxwebsetup' -or $n -eq 'oalinst') { return $true }
  if ($n -match 'vcredist|vc_redist') { return $true }
  if ($n -match '^dotnetfx|^ndp\d|physx') { return $true }
  if ($n -match 'directx') { return $true }
  return $false
}

function Test-PromoCommandLine([string]$Cmd) {
  if ([string]::IsNullOrWhiteSpace($Cmd)) { return $false }
  return [bool]($Cmd -match 'fitgirl-repacks|fitgirl\.site|fitgirl\.repacks|paste\.fitgirl|fg-repacks')
}

function Test-BrowserOrUrlHost([string]$BaseName) {
  if ([string]::IsNullOrWhiteSpace($BaseName)) { return $false }
  $n = $BaseName.ToLowerInvariant()
  return ($n -match '^(chrome|msedge|firefox|iexplore|brave|opera|cmd|powershell|pwsh|rundll32|explorer)$')
}

function Stop-InstallerExtras([int]$Root, [int[]]$Tree) {
  $treeIds = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($id in @($Tree)) {
    if ($id -gt 0) { [void]$treeIds.Add([int]$id) }
  }
  try {
    $rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Select-Object ProcessId, ParentProcessId, Name, CommandLine
  } catch { return }

  foreach ($row in $rows) {
    if ($null -eq $row.ProcessId) { continue }
    $procId = [int]$row.ProcessId
    if ($Root -gt 0 -and $procId -eq $Root) { continue }
    $parentId = 0
    try { $parentId = [int]$row.ParentProcessId } catch { $parentId = 0 }
    $inTree = $treeIds.Contains($procId) -or $treeIds.Contains($parentId)

    if (-not $inTree) {
      if (-not (Test-PromoCommandLine $row.CommandLine)) { continue }
      $baseOut = [IO.Path]::GetFileNameWithoutExtension([string]$row.Name)
      if (-not (Test-BrowserOrUrlHost $baseOut)) { continue }
      try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch { }
      continue
    }

    $base = [IO.Path]::GetFileNameWithoutExtension([string]$row.Name)
    $kill = $false
    if (Test-RedistProcessName $base) { $kill = $true }
    elseif ((Test-PromoCommandLine $row.CommandLine) -and (Test-BrowserOrUrlHost $base)) { $kill = $true }

    if ($kill) {
      try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch { }
    }
  }
}

try {
  while ($true) {
    if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }

    $effectiveRoot = Get-EffectiveRootPid
    if ($effectiveRoot -gt 0) {
      $alive = Get-Process -Id $effectiveRoot -ErrorAction SilentlyContinue
      if (-not $alive) { break }
      $tree = @(Get-ProcessTreeIds -Root $effectiveRoot)
      try { Stop-InstallerExtras -Root $effectiveRoot -Tree $tree } catch { }
    }

    try { [GamehubAudio]::ForceSilent() } catch { }
    Start-Sleep -Milliseconds $PollMs
  }
} finally {
  Restore-AudioState -Path $StateFile
  if ($StopFile) { try { Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue } catch { } }
  if ($PidFile) { try { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue } catch { } }
}
