# Installer audio + extras guard. Used for EVERY installer Gamehub starts:
# silent Inno/NSIS, setup wizards (FitGirl / DODI / ElAmigos / scene), DLC and
# update installers.
#
# Strategy (v1.9):
#   1. Mute the SYSTEM master endpoint before the installer exists, so music
#      that starts the instant setup runs never reaches the speakers.
#   2. Track the installer's process tree natively (Toolhelp snapshot — a few
#      ms, unlike Get-CimInstance which can take 300ms+ during heavy disk IO).
#   3. Every PollMs, mute every audio session (on every active render device)
#      owned by the tree, or by a process running out of an installer temp dir
#      (Inno's %TEMP%\is-*.tmp\setup.tmp plays FitGirl/DODI music).
#   4. Release the master once a tree session has been muted (or MasterHoldMs
#      elapses) — Discord / Spotify come back within seconds; the installer
#      stays muted for its whole life.
#   5. On exit, un-mute any session we muted whose process is STILL running
#      (e.g. the game, launched from the wizard's "Launch game" checkbox) and
#      restore the master if still held. Crash-safe via StateFile.
#
# Launch mode (-LaunchExe): the guard starts the installer itself (UAC is
# handled by ShellExecute when the exe's manifest asks for admin), prints
# STARTED:<pid>, and exits once setup and any helper still running from a
# temp/payload dir are gone. Used for wizard installs so Gamehub can tell
# when the wizard is finished.
#
# stdout protocol: MUTED | STARTED:<pid> | CANCELLED | LAUNCH_FAILED:<msg> | DONE
param(
  [int]$RootPid = 0,
  [string]$StopFile = '',
  [string]$PidFile = '',
  [string]$StateFile = '',
  [string]$WatchDirs = '',       # '|'-separated path prefixes whose processes are muted
  [string]$LaunchExe = '',
  [string]$LaunchArgs = '',
  [string]$LaunchCwd = '',
  [switch]$MuteOnly,
  [switch]$RestoreOnly,
  [switch]$NoMaster,             # another guard already holds the master mute
  [switch]$NoExtras,             # don't kill redist / promo helpers (wizard mode)
  [switch]$SelfTest,             # CI: prove the C# compiles + process tree works, touch no audio
  [int]$PollMs = 40,
  [int]$MasterHoldMs = 8000,
  [int]$ExtrasEveryMs = 750
)

$ErrorActionPreference = 'SilentlyContinue'
if (-not $StateFile) {
  $StateFile = Join-Path $env:TEMP 'gamehub-audio-guard-state.json'
}

function Say([string]$Line) {
  try { [Console]::Out.WriteLine($Line); [Console]::Out.Flush() } catch { }
}

# NOTE: Windows PowerShell 5.1 compiles this with the C# 5 compiler — no
# string interpolation, ?. , out var, or expression-bodied members.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class GamehubAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  private class MMDeviceEnumeratorComObject { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
  }

  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
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

  [Guid("87CE5498-68D6-44E5-A1FC-635806365766"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float fLevel, ref Guid EventContext);
    [PreserveSig] int GetMasterVolume(out float pfLevel);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid EventContext);
    [PreserveSig] int GetMute(out bool pbMute);
  }

  // ---------- process tree (Toolhelp) ----------
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct PROCESSENTRY32W {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")]
  private static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")]
  private static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr hObject);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "QueryFullProcessImageNameW")]
  private static extern bool QueryFullProcessImageName(IntPtr hProcess, int flags, StringBuilder exeName, ref int size);

  private static readonly HashSet<uint> known = new HashSet<uint>();
  private static readonly HashSet<uint> alive = new HashSet<uint>();
  private static readonly Dictionary<uint, string> pathCache = new Dictionary<uint, string>();
  private static readonly HashSet<uint> mutedPids = new HashSet<uint>();
  private static string[] watchDirs = new string[0];
  private static uint root = 0;

  public static void SetRoot(int pid) {
    if (pid <= 0) return;
    root = (uint)pid;
    known.Add(root);
  }
  public static int Root { get { return (int)root; } }

  public static void SetWatchDirs(string joined) {
    var list = new List<string>();
    if (!String.IsNullOrEmpty(joined)) {
      foreach (var raw in joined.Split('|')) {
        var t = raw.Trim().TrimEnd('\\', '/');
        if (t.Length > 3) list.Add(t + "\\");
      }
    }
    watchDirs = list.ToArray();
  }

  public static string ImagePath(uint pid) {
    string cached;
    if (pathCache.TryGetValue(pid, out cached)) return cached;
    string result = null;
    IntPtr h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
    if (h != IntPtr.Zero) {
      try {
        var sb = new StringBuilder(1024);
        int size = sb.Capacity;
        if (QueryFullProcessImageName(h, 0, sb, ref size)) result = sb.ToString(0, size);
      } finally { CloseHandle(h); }
    }
    pathCache[pid] = result;
    return result;
  }

  public static bool InWatchedDir(uint pid) {
    if (watchDirs.Length == 0) return false;
    var p = ImagePath(pid);
    if (String.IsNullOrEmpty(p)) return false;
    foreach (var d in watchDirs) {
      if (p.StartsWith(d, StringComparison.OrdinalIgnoreCase)) return true;
    }
    return false;
  }

  /// <summary>Snapshot once: grow the known tree (children of anything we have
  /// seen, so orphaned grandchildren stay tracked) and refresh liveness.</summary>
  public static void Refresh() {
    IntPtr snap = CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return;
    var rows = new List<KeyValuePair<uint, uint>>();
    try {
      var e = new PROCESSENTRY32W();
      e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (Process32First(snap, ref e)) {
        do { rows.Add(new KeyValuePair<uint, uint>(e.th32ProcessID, e.th32ParentProcessID)); }
        while (Process32Next(snap, ref e));
      }
    } finally { CloseHandle(snap); }

    alive.Clear();
    foreach (var r in rows) alive.Add(r.Key);
    if (known.Count > 0) {
      bool changed = true;
      while (changed) {
        changed = false;
        foreach (var r in rows) {
          if (r.Key != r.Value && known.Contains(r.Value) && !known.Contains(r.Key)) {
            known.Add(r.Key);
            changed = true;
          }
        }
      }
    }
    // forget cached paths for dead PIDs (PID reuse)
    var dead = new List<uint>();
    foreach (var k in pathCache.Keys) if (!alive.Contains(k)) dead.Add(k);
    foreach (var k in dead) pathCache.Remove(k);
  }

  public static bool RootAlive() { return root != 0 && alive.Contains(root); }

  /// <summary>Installer helpers still running: tree members whose image lives
  /// in a watched (temp / payload) dir. The installed GAME never qualifies.</summary>
  public static int InstallerHelpersAlive() {
    int n = 0;
    foreach (var pid in known) {
      if (pid == root) continue;
      if (alive.Contains(pid) && InWatchedDir(pid)) n++;
    }
    return n;
  }

  public static int[] FindByImage(string imagePath) {
    var hits = new List<int>();
    if (String.IsNullOrEmpty(imagePath)) return hits.ToArray();
    foreach (var pid in alive) {
      var p = ImagePath(pid);
      if (p != null && String.Equals(p, imagePath, StringComparison.OrdinalIgnoreCase)) hits.Add((int)pid);
    }
    return hits.ToArray();
  }

  private static bool ShouldMute(uint pid) {
    if (pid == 0) return false;
    if (known.Contains(pid) && alive.Contains(pid)) return true;
    return InWatchedDir(pid);
  }

  // ---------- endpoints ----------
  private static List<IMMDevice> RenderDevices(IMMDeviceEnumerator en) {
    var list = new List<IMMDevice>();
    IMMDeviceCollection coll;
    if (en.EnumAudioEndpoints(0 /* eRender */, 1 /* ACTIVE */, out coll) == 0 && coll != null) {
      int count;
      coll.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IMMDevice d;
        if (coll.Item(i, out d) == 0 && d != null) list.Add(d);
      }
      Marshal.ReleaseComObject(coll);
    }
    if (list.Count == 0) {
      IMMDevice def;
      if (en.GetDefaultAudioEndpoint(0, 1, out def) == 0 && def != null) list.Add(def);
    }
    return list;
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

  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void SetMute(bool mute) { Marshal.ThrowExceptionForHR(Vol().SetMute(mute, Guid.Empty)); }
  public static float GetVolume() { float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void SetVolume(float v) {
    if (v < 0f) v = 0f;
    if (v > 1f) v = 1f;
    Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, Guid.Empty));
  }
  public static void ForceSilent() {
    try { SetMute(true); } catch { }
    try { SetVolume(0f); } catch { }
  }

  /// <summary>Walk every session on every active render device. mute=true mutes
  /// installer sessions; mute=false un-mutes sessions WE muted whose process is
  /// still alive (the game launched from the wizard). Returns sessions touched.</summary>
  private static int Sweep(bool mute) {
    int touched = 0;
    IMMDeviceEnumerator en = null;
    try {
      en = (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorComObject();
      foreach (var device in RenderDevices(en)) {
        IAudioSessionManager2 mgr = null;
        IAudioSessionEnumerator sessions = null;
        try {
          object o;
          var iid = typeof(IAudioSessionManager2).GUID;
          if (device.Activate(ref iid, 23, IntPtr.Zero, out o) != 0 || o == null) continue;
          mgr = (IAudioSessionManager2)o;
          if (mgr.GetSessionEnumerator(out sessions) != 0 || sessions == null) continue;
          int count;
          sessions.GetCount(out count);
          var ctx = Guid.Empty;
          for (int i = 0; i < count; i++) {
            IAudioSessionControl ctl = null;
            try {
              if (sessions.GetSession(i, out ctl) != 0 || ctl == null) continue;
              var ctl2 = ctl as IAudioSessionControl2;
              if (ctl2 == null) continue;
              uint pid;
              if (ctl2.GetProcessId(out pid) != 0 || pid == 0) continue;
              var vol = ctl as ISimpleAudioVolume;
              if (vol == null) continue;
              if (mute) {
                if (!ShouldMute(pid)) continue;
                bool already;
                vol.GetMute(out already);
                // only remember sessions WE muted — never un-mute something
                // the user had muted themselves
                if (!already) { vol.SetMute(true, ref ctx); touched++; mutedPids.Add(pid); }
              } else {
                if (!mutedPids.Contains(pid) || !alive.Contains(pid)) continue;
                vol.SetMute(false, ref ctx);
                touched++;
              }
            } catch {
            } finally {
              if (ctl != null) Marshal.ReleaseComObject(ctl);
            }
          }
        } catch {
        } finally {
          if (sessions != null) Marshal.ReleaseComObject(sessions);
          if (mgr != null) Marshal.ReleaseComObject(mgr);
          Marshal.ReleaseComObject(device);
        }
      }
    } catch {
    } finally {
      if (en != null) Marshal.ReleaseComObject(en);
    }
    return touched;
  }

  public static int MuteInstallerSessions() { return Sweep(true); }
  public static int MutedCount { get { return mutedPids.Count; } }
  public static int ReleaseSurvivors() { Refresh(); return Sweep(false); }
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

if ($SelfTest) {
  if (-not ('GamehubAudio' -as [type])) { Say 'SELFTEST:compile-failed'; exit 3 }
  [GamehubAudio]::SetRoot($PID)
  [GamehubAudio]::Refresh()
  if (-not [GamehubAudio]::RootAlive()) { Say 'SELFTEST:tree-failed'; exit 4 }
  $self = [GamehubAudio]::ImagePath([uint32]$PID)
  $hits = @([GamehubAudio]::FindByImage($self))
  if ($hits -notcontains $PID) { Say 'SELFTEST:image-failed'; exit 5 }
  Say ('SELFTEST:ok ' + $hits.Count)
  exit 0
}

if ($RestoreOnly) {
  Restore-AudioState -Path $StateFile
  exit 0
}

# ---- 1. master mute BEFORE any installer audio can start ----
if (-not $NoMaster) {
  if (-not (Test-Path -LiteralPath $StateFile)) { Save-AudioState -Path $StateFile }
  try { [GamehubAudio]::ForceSilent() } catch { }
}
Say 'MUTED'
if ($MuteOnly) { exit 0 }

# Inno unpacks setup.tmp (the process that actually plays repack music) into
# %TEMP%\is-XXXXX.tmp — watch the whole user temp dir plus the payload dirs.
$dirs = @($env:TEMP, $env:TMP) + @($WatchDirs -split '\|') | Where-Object { $_ } | Select-Object -Unique
[GamehubAudio]::SetWatchDirs(($dirs -join '|'))

# ---- redist / promo helper killer (silent mode only; low cadence — CIM is slow) ----
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

function Stop-InstallerExtras([int]$Root) {
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

$script:masterReleased = [bool]$NoMaster
function Release-MasterMute {
  if ($script:masterReleased) { return }
  $script:masterReleased = $true
  # Restore the user's master but KEEP StateFile until final exit (crash recovery).
  Restore-AudioState -Path $StateFile -KeepFile
}

$exitCode = 0
$script:finishedNaturally = $false
try {
  # ---- 2. launch mode: start the installer ourselves ----
  if ($LaunchExe) {
    [GamehubAudio]::Refresh()
    $before = @([GamehubAudio]::FindByImage($LaunchExe))
    $cwd = $LaunchCwd
    if (-not $cwd -or -not (Test-Path -LiteralPath $cwd)) { $cwd = Split-Path -Parent $LaunchExe }
    $p = $null
    $declined = $false
    try {
      $sp = @{ FilePath = $LaunchExe; WorkingDirectory = $cwd; PassThru = $true; ErrorAction = 'Stop' }
      if (-not [string]::IsNullOrWhiteSpace($LaunchArgs)) { $sp.ArgumentList = $LaunchArgs }
      $p = Start-Process @sp
    } catch {
      $ex = $_.Exception
      $native = 0
      try {
        if ($ex -is [System.ComponentModel.Win32Exception]) { $native = [int]$ex.NativeErrorCode }
        elseif ($ex.InnerException -is [System.ComponentModel.Win32Exception]) { $native = [int]$ex.InnerException.NativeErrorCode }
      } catch { }
      if ($native -eq 1223 -or $ex.Message -match 'cancel') { $declined = $true }
      # Start-Process can report a UAC cancel even after the user accepted —
      # look for a NEW process running the setup image before giving up.
      $deadline = (Get-Date).AddSeconds(6)
      while (-not $p -and (Get-Date) -lt $deadline) {
        [GamehubAudio]::Refresh()
        $now = @(@([GamehubAudio]::FindByImage($LaunchExe)) | Where-Object { $before -notcontains $_ })
        if ($now.Count -gt 0) { $p = [pscustomobject]@{ Id = [int]$now[0] } }
        else { Start-Sleep -Milliseconds 200 }
      }
      if (-not $p) {
        if ($declined) { Say 'CANCELLED'; $exitCode = 1223 }
        else { Say ('LAUNCH_FAILED:' + $ex.Message); $exitCode = 1 }
        return
      }
    }
    $RootPid = [int]$p.Id
    Say ('STARTED:' + $RootPid)
  }

  # ---- 3. guard loop ----
  $started = Get-Date
  $rootSeenAt = $null
  $lastExtras = [datetime]::MinValue
  $rootGoneAt = $null
  while ($true) {
    if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }

    $effectiveRoot = Get-EffectiveRootPid
    if ($effectiveRoot -gt 0 -and $effectiveRoot -ne [GamehubAudio]::Root) {
      [GamehubAudio]::SetRoot($effectiveRoot)
    }
    [GamehubAudio]::Refresh()
    if ($effectiveRoot -gt 0 -and -not $rootSeenAt) { $rootSeenAt = Get-Date }

    $muted = 0
    try { $muted = [GamehubAudio]::MuteInstallerSessions() } catch { }

    if (-not $script:masterReleased) {
      try { [GamehubAudio]::ForceSilent() } catch { }
      $anchor = if ($rootSeenAt) { $rootSeenAt } else { $started }
      $held = ((Get-Date) - $anchor).TotalMilliseconds
      # Release once the installer's own audio is caught (it's muted per-session
      # now), or the hold cap elapses (installers without music).
      if ($rootSeenAt -and ([GamehubAudio]::MutedCount -gt 0 -or $held -ge $MasterHoldMs)) {
        Release-MasterMute
      }
    }

    if (-not $NoExtras -and ((Get-Date) - $lastExtras).TotalMilliseconds -ge $ExtrasEveryMs) {
      $lastExtras = Get-Date
      try { Stop-InstallerExtras -Root $effectiveRoot } catch { }
    }

    # Done when setup is gone AND no helper is still running from temp/payload
    # (bootstrappers that exit after launching the real wizard).
    if ($effectiveRoot -gt 0 -and -not [GamehubAudio]::RootAlive()) {
      if ([GamehubAudio]::InstallerHelpersAlive() -eq 0) {
        if (-not $rootGoneAt) { $rootGoneAt = Get-Date }
        # short grace: Inno's setup.exe can exit a beat before setup.tmp's children
        if (((Get-Date) - $rootGoneAt).TotalMilliseconds -ge 1500) { $script:finishedNaturally = $true; break }
      } else {
        $rootGoneAt = $null
      }
    }

    Start-Sleep -Milliseconds $PollMs
  }
} finally {
  # ---- 5. hand audio back ----
  # Only when setup actually finished: anything of ours still running then is
  # the GAME (wizard's "Launch game" checkbox) — give it its sound back. When
  # Gamehub merely stopped watching, survivors are the still-open installer.
  if ($script:finishedNaturally) { try { [void][GamehubAudio]::ReleaseSurvivors() } catch { } }
  if (-not $NoMaster) {
    if (-not $script:masterReleased) {
      Restore-AudioState -Path $StateFile
    } else {
      try { if (Test-Path -LiteralPath $StateFile) { Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue } } catch { }
    }
  }
  if ($StopFile) { try { Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue } catch { } }
  if ($PidFile) { try { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue } catch { } }
  if ($exitCode -eq 0) { Say 'DONE' }
}
exit $exitCode
