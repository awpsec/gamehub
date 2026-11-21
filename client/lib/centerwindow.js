// Best-effort: nudge a freshly-launched game window to the center of its
// monitor. Some games open windowed at an awkward spot (e.g. top-left corner
// sitting at screen center). We can't control another app's window from
// Electron directly, so we hand a tiny, self-contained PowerShell watcher the
// launched PID. It waits for the process (or a descendant — launcher → game)
// to show a top-level window, then centers it ONCE.
//
// Guards keep it safe:
//   - skips minimized / maximized windows
//   - skips true fullscreen & borderless-fullscreen (covers ~the whole monitor)
//   - SWP_NOACTIVATE so we never steal focus
//   - centers the first qualifying window then stops (never fights a game that
//     repositions itself afterwards)
const { spawn } = require('node:child_process');

function runHiddenPowershell(script, { detached = true, stdio = 'ignore' } = {}) {
  return spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { detached, stdio, windowsHide: true }
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function centerGameWindow(pid) {
  if (process.platform !== 'win32' || !pid) return;

  const ps = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class GhWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
function Desc($id){ $r=@($id); Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" | ForEach-Object { $r += Desc $_.ProcessId }; $r }
$deadline=(Get-Date).AddSeconds(25)
while((Get-Date) -lt $deadline){
  $ids = Desc ${pid} | Select-Object -Unique
  $p = Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
  if($p){
    $h=$p.MainWindowHandle
    if([GhWin]::IsWindowVisible($h) -and -not [GhWin]::IsIconic($h) -and -not [GhWin]::IsZoomed($h)){
      $r=New-Object GhWin+RECT
      [void][GhWin]::GetWindowRect($h,[ref]$r)
      $w=$r.R-$r.L; $ht=$r.B-$r.T
      if($w -gt 120 -and $ht -gt 120){
        $wa=[System.Windows.Forms.Screen]::FromHandle($h).WorkingArea
        # only reposition genuinely-windowed games; leave (borderless) fullscreen alone
        if($w -lt $wa.Width*0.98 -or $ht -lt $wa.Height*0.98){
          $x=$wa.X+[int](($wa.Width-$w)/2)
          $y=$wa.Y+[int](($wa.Height-$ht)/2)
          [void][GhWin]::SetWindowPos($h,[IntPtr]::Zero,$x,$y,0,0,0x0015) # SWP_NOSIZE|NOZORDER|NOACTIVATE
        }
        break
      }
    }
  }
  Start-Sleep -Milliseconds 400
}
`;

  try {
    const child = runHiddenPowershell(ps);
    child.unref();
  } catch {
    /* best-effort only — never let a positioning helper break Play */
  }
}

// Resolves once the launched PID (or a descendant) shows a real game-sized
// top-level window — used so the Shift+Tab hint toast appears AFTER the game
// is up, not over Gamehub during the loading gap.
//
// Always waits at least minDelayMs from the call (even if a splash pops early).
// Tiny launcher/console windows are ignored via minWidth/minHeight.
function waitForGameWindow(pid, {
  timeoutMs = 90_000,
  fallbackMs = 8_000,
  minDelayMs = 5_500,
  minWidth = 640,
  minHeight = 400,
  settleMs = 900,
} = {}) {
  const t0 = Date.now();
  const ensureMinDelay = async () => {
    const left = Math.max(0, minDelayMs - (Date.now() - t0));
    if (left) await delay(left);
  };

  if (!pid || process.platform !== 'win32') {
    return ensureMinDelay().then(() => delay(Math.max(0, fallbackMs - minDelayMs)));
  }

  const secs = Math.max(8, Math.round(timeoutMs / 1000));
  const ps = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class GhWait {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
function Desc($id){ $r=@($id); Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" | ForEach-Object { $r += Desc $_.ProcessId }; $r }
$deadline=(Get-Date).AddSeconds(${secs})
while((Get-Date) -lt $deadline){
  $ids = Desc ${Number(pid)} | Select-Object -Unique
  foreach($p in (Get-Process -Id $ids -ErrorAction SilentlyContinue)){
    if($p.MainWindowHandle -eq 0){ continue }
    if(-not $p.MainWindowTitle){ continue }
    if(-not [GhWait]::IsWindowVisible($p.MainWindowHandle)){ continue }
    if([GhWait]::IsIconic($p.MainWindowHandle)){ continue }
    $r=New-Object GhWait+RECT
    if(-not [GhWait]::GetWindowRect($p.MainWindowHandle,[ref]$r)){ continue }
    $w=$r.R-$r.L; $ht=$r.B-$r.T
    # ignore tiny splash / console / launcher stubs
    if($w -ge ${Number(minWidth)} -and $ht -ge ${Number(minHeight)}){ exit 0 }
  }
  Start-Sleep -Milliseconds 450
}
exit 1
`;

  return new Promise((resolve) => {
    let done = false;
    const finish = async (found) => {
      if (done) return;
      done = true;
      await ensureMinDelay();
      if (found) await delay(settleMs);
      else {
        const left = Math.max(0, fallbackMs - (Date.now() - t0));
        if (left) await delay(left);
      }
      resolve(!!found);
    };

    const timer = setTimeout(() => { try { child.kill(); } catch { /* */ } finish(false); }, timeoutMs);
    let child;
    try {
      child = runHiddenPowershell(ps, { detached: false, stdio: 'ignore' });
      child.on('exit', (code) => { clearTimeout(timer); finish(code === 0); });
      child.on('error', () => { clearTimeout(timer); finish(false); });
    } catch {
      clearTimeout(timer);
      finish(false);
    }
  });
}

module.exports = { centerGameWindow, waitForGameWindow };
