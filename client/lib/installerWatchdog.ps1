# Audio + extras guard for silent Inno/NSIS/FitGirl installs.
#
# Scoped mute strategy (v1.8.17+):
#   1. Mute the SYSTEM master endpoint immediately (FitGirl music can start
#      before any per-process audio session exists — the race window).
#   2. After MasterHoldMs (and once we know the setup PID), RESTORE the master
#      and switch to per-session mute of the setup process tree only.
#   3. Keep killing DirectX / VC++ / promo browsers for the whole install.
#   4. On stop/exit, restore master again if still held (crash-safe via StateFile).
param(
  [int]$RootPid = 0,
  [string]$StopFile = '',
  [string]$PidFile = '',
  [string]$StateFile = '',
  [switch]$MuteOnly,
  [switch]$RestoreOnly,
  [int]$PollMs = 80,
  [int]$MasterHoldMs = 8000
)

$ErrorActionPreference = 'SilentlyContinue'
if (-not $StateFile) {
  $StateFile = Join-Path $env:TEMP 'gamehub-audio-guard-state.json'
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
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

  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioEndpointVolume {
    int NotImpl1();
    int NotImpl2();
    int NotImpl3();
    int NotImpl4();
    [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int NotImpl6();
    [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
    int NotImpl8();
    int NotImpl9();
    int NotImpl10();
    int NotImpl11();
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

  // Full IAudioSessionControl vtable + IAudioSessionControl2::GetProcessId.
  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionControl2 {
    int NotImpl_GetState();
    int NotImpl_GetDisplayName();
    int NotImpl_SetDisplayName();
    int NotImpl_GetIconPath();
    int NotImpl_SetIconPath();
    int NotImpl_GetGroupingParam();
    int NotImpl_SetGroupingParam();
    int NotImpl_RegisterAudioSessionNotification();
    int NotImpl_UnregisterAudioSessionNotification();
    int NotImpl_GetSessionIdentifier();
    int NotImpl_GetSessionInstanceIdentifier();
    [PreserveSig] int GetProcessId(out uint pProcessId);
    int NotImpl_IsSystemSoundsSession();
    int NotImpl_SetDuckingPreference();
  }

  // Correct ISimpleAudioVolume IID (was wrongly 68D6-140E… which broke QI).
  [Guid("87CE5498-68D6-44E5-A1FC-635806365766"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
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
  }

  /// <summary>Mute audio sessions owned by any of the given process ids. Returns count muted.</summary>
  public static int MuteSessionsForPids(int[] pids) {
    if (pids == null || pids.Length == 0) return 0;
    var want = new HashSet<uint>();
    for (int i = 0; i < pids.Length; i++) {
      if (pids[i] > 0) want.Add((uint)pids[i]);
    }
    if (want.Count == 0) return 0;

    IMMDeviceEnumerator enumerator = null;
    IMMDevice device = null;
    IAudioSessionManager2 mgr = null;
    IAudioSessionEnumerator sessions = null;
    int muted = 0;
    try {
      enumerator = (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorComObject();
      if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0 || device == null) return 0;
      object o;
      var iid = typeof(IAudioSessionManager2).GUID;
      if (device.Activate(ref iid, 23, IntPtr.Zero, out o) != 0 || o == null) return 0;
      mgr = (IAudioSessionManager2)o;
      if (mgr.GetSessionEnumerator(out sessions) != 0 || sessions == null) return 0;
      int count;
      sessions.GetCount(out count);
      var empty = Guid.Empty;
      for (int i = 0; i < count; i++) {
        IAudioSessionControl ctl = null;
        try {
          if (sessions.GetSession(i, out ctl) != 0 || ctl == null) continue;
          var ctl2 = ctl as IAudioSessionControl2;
          if (ctl2 == null) continue;
          uint pid;
          if (ctl2.GetProcessId(out pid) != 0) continue;
          if (!want.Contains(pid)) continue;
          var vol = ctl as ISimpleAudioVolume;
          if (vol == null) continue;
          vol.SetMute(true, ref empty);
          vol.SetMasterVolume(0f, ref empty);
          muted++;
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
    return muted;
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
  param(
    [string]$Path,
    [switch]$KeepFile
  )
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
  if (-not $KeepFile) {
    try { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue } catch { }
  }
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
  $null = $Tree
  try {
    $rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Select-Object ProcessId, Name, CommandLine
  } catch { return }

  foreach ($row in $rows) {
    if ($null -eq $row.ProcessId) { continue }
    $procId = [int]$row.ProcessId
    if ($Root -gt 0 -and $procId -eq $Root) { continue }
    if ($procId -eq $PID) { continue }

    $base = [IO.Path]::GetFileNameWithoutExtension([string]$row.Name)
    $cmd = [string]$row.CommandLine
    $kill = $false

    if (Test-RedistProcessName $base) { $kill = $true }
    elseif (Test-RedistCommandLine $cmd) {
      if ($base -match '^(msiexec|cmd|powershell|pwsh|conhost)$' -or (Test-RedistProcessName $base)) {
        $kill = $true
      } elseif ((Test-PromoCommandLine $cmd) -and (Test-BrowserOrUrlHost $base)) {
        $kill = $true
      } elseif ($cmd -match '\\_?CommonRedist\\|\\_Redist\\|\\DirectX\\') {
        if ($base -match 'setup|install|redist|dx|vc') { $kill = $true }
      }
    } elseif ((Test-PromoCommandLine $cmd) -and (Test-BrowserOrUrlHost $base)) {
      $kill = $true
    }

    if ($kill) {
      try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch { }
      try { & taskkill.exe /F /PID $procId 2>$null | Out-Null } catch { }
    }
  }
}

$script:masterReleased = $false
$masterHoldUntil = (Get-Date).AddMilliseconds([Math]::Max(0, $MasterHoldMs))

function Release-MasterMute {
  if ($script:masterReleased) { return }
  $script:masterReleased = $true
  # Restore user's master volume/mute but KEEP StateFile until final exit
  # (crash recovery still knows the prior values).
  Restore-AudioState -Path $StateFile -KeepFile
}

try {
  while ($true) {
    if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }

    $effectiveRoot = Get-EffectiveRootPid
    $tree = @()
    if ($effectiveRoot -gt 0) {
      $alive = Get-Process -Id $effectiveRoot -ErrorAction SilentlyContinue
      if (-not $alive) { break }
      $tree = @(Get-ProcessTreeIds -Root $effectiveRoot)
      try { Stop-InstallerExtras -Root $effectiveRoot -Tree $tree } catch { }
    } else {
      try { Stop-InstallerExtras -Root 0 -Tree @() } catch { }
    }

    if (-not $script:masterReleased) {
      # Race window: keep master muted until hold elapsed AND we know setup PID.
      try { [GamehubAudio]::ForceSilent() } catch { }
      $holdDone = ((Get-Date) -ge $masterHoldUntil)
      if ($effectiveRoot -gt 0 -and $holdDone) {
        $sessions = 0
        try { $sessions = [GamehubAudio]::MuteSessionsForPids([int[]]$tree) } catch { }
        # Release master once hold is done; keep forcing per-session mute after.
        Release-MasterMute
        if ($sessions -gt 0) {
          try { [void][GamehubAudio]::MuteSessionsForPids([int[]]$tree) } catch { }
        }
      }
    } else {
      if ($effectiveRoot -gt 0 -and $tree.Count -gt 0) {
        try { [void][GamehubAudio]::MuteSessionsForPids([int[]]$tree) } catch { }
      } else {
        # Lost root PID — re-hold master as a safety net.
        try { [GamehubAudio]::ForceSilent() } catch { }
      }
    }

    Start-Sleep -Milliseconds $PollMs
  }
} finally {
  if (-not $script:masterReleased) {
    Restore-AudioState -Path $StateFile
  } else {
    # Master already restored mid-run; just clear the state file.
    try { if (Test-Path -LiteralPath $StateFile) { Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue } } catch { }
  }
  if ($StopFile) { try { Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue } catch { } }
  if ($PidFile) { try { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue } catch { } }
}
