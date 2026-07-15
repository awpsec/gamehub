# Watchdog for silent Inno/FitGirl installs:
#  1) Mute audio sessions for the installer process tree (music survives /VERYSILENT)
#  2) Kill optional extras FitGirl still launches when "checked by default":
#     DirectX / VC++ redistributables, OpenAL, and promo site browser tabs
param(
  [Parameter(Mandatory = $true)]
  [int]$RootPid,
  [int]$PollMs = 500
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class GamehubAudioMute {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  private class MMDeviceEnumeratorComObject { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceEnumerator {
    int f();
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
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
    [PreserveSig] int GetSession(int SessionCount, out IAudioSessionControl2 Session);
  }

  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionControl2 {
    int NotImpl1();
    int NotImpl2();
    int NotImpl3();
    int NotImpl4();
    int NotImpl5();
    int NotImpl6();
    int NotImpl7();
    int NotImpl8();
    int NotImpl9();
    int NotImpl10();
    int NotImpl11();
    [PreserveSig] int GetProcessId(out uint pPid);
  }

  [Guid("87CE5498-68D6-140E-49E3-635806365766"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float fLevel, ref Guid EventContext);
    [PreserveSig] int GetMasterVolume(out float pfLevel);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid EventContext);
    [PreserveSig] int GetMute(out bool pbMute);
  }

  public static void MutePids(int[] pids) {
    if (pids == null || pids.Length == 0) return;
    var want = new System.Collections.Generic.HashSet<uint>();
    foreach (var p in pids) if (p > 0) want.Add((uint)p);

    IMMDeviceEnumerator enumerator = null;
    IMMDevice device = null;
    IAudioSessionManager2 mgr = null;
    IAudioSessionEnumerator sessions = null;
    try {
      enumerator = (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorComObject();
      if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0 || device == null) return;
      var iid = typeof(IAudioSessionManager2).GUID;
      object o;
      if (device.Activate(ref iid, 23, IntPtr.Zero, out o) != 0 || o == null) return;
      mgr = (IAudioSessionManager2)o;
      if (mgr.GetSessionEnumerator(out sessions) != 0 || sessions == null) return;
      int count;
      sessions.GetCount(out count);
      var empty = Guid.Empty;
      for (int i = 0; i < count; i++) {
        IAudioSessionControl2 ctl = null;
        try {
          if (sessions.GetSession(i, out ctl) != 0 || ctl == null) continue;
          uint pid;
          if (ctl.GetProcessId(out pid) != 0 || !want.Contains(pid)) continue;
          var vol = ctl as ISimpleAudioVolume;
          if (vol == null) continue;
          vol.SetMute(true, ref empty);
          vol.SetMasterVolume(0f, ref empty);
        } finally {
          if (ctl != null) Marshal.ReleaseComObject(ctl);
        }
      }
    } catch {
      // Best-effort — never fail the installer over mute.
    } finally {
      if (sessions != null) Marshal.ReleaseComObject(sessions);
      if (mgr != null) Marshal.ReleaseComObject(mgr);
      if (device != null) Marshal.ReleaseComObject(device);
      if (enumerator != null) Marshal.ReleaseComObject(enumerator);
    }
  }
}
'@

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
        # Avoid $pid — that is a PowerShell automatic variable.
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

function Stop-InstallerExtras([int[]]$Tree) {
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
    if ($procId -eq $RootPid) { continue }
    $parentId = 0
    try { $parentId = [int]$row.ParentProcessId } catch { $parentId = 0 }
    $inTree = $treeIds.Contains($procId) -or $treeIds.Contains($parentId)

    if (-not $inTree) {
      # Promo site opens often use ShellExecute → parent is explorer, not setup.
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

while ($true) {
  $proc = Get-Process -Id $RootPid -ErrorAction SilentlyContinue
  if (-not $proc) { break }
  $tree = @(Get-ProcessTreeIds -Root $RootPid)
  if ($tree.Count -gt 0) {
    try { [GamehubAudioMute]::MutePids([int[]]$tree) } catch { }
    try { Stop-InstallerExtras -Tree $tree } catch { }
  }
  Start-Sleep -Milliseconds $PollMs
}
