// Windows low-level keyboard hook for in-game screenshot hotkeys.
// Electron's globalShortcut often fails to deliver F12 while another app
// (the game) has focus — Chromium/Steam/etc. reserve it. A WH_KEYBOARD_LL
// hook still sees the key. Non-Windows: no-op (globalShortcut + before-input).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let hookProc = null;
let watcher = null;
let signalFile = null;
let onShot = null;
let lastFire = 0;

// Electron accelerator → Win32 VK (+ optional Shift/Ctrl/Alt requirements)
function parseAccel(accel) {
  const parts = String(accel || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const keyName = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const wantShift = mods.has('shift') ? 1 : 0;
  const wantCtrl = (mods.has('control') || mods.has('ctrl') || mods.has('cmdorctrl') || mods.has('commandorcontrol')) ? 1 : 0;
  const wantAlt = (mods.has('alt') || mods.has('option')) ? 1 : 0;
  let vk = 0;
  if (/^f([1-9]|1[0-2])$/i.test(keyName)) vk = 0x70 + (parseInt(keyName.slice(1), 10) - 1);
  else if (/^printscreen|prtscr|snapshot$/i.test(keyName)) vk = 0x2C;
  else if (/^tab$/i.test(keyName)) vk = 0x09;
  else if (keyName.length === 1) vk = keyName.toUpperCase().charCodeAt(0);
  else return null;
  return { vk, wantShift, wantCtrl, wantAlt };
}

function stop() {
  if (watcher) {
    try { watcher.close(); } catch { /* */ }
    watcher = null;
  }
  if (hookProc) {
    try { hookProc.kill(); } catch { /* */ }
    hookProc = null;
  }
  if (signalFile) {
    try { fs.unlinkSync(signalFile); } catch { /* */ }
    signalFile = null;
  }
}

function start(accel, callback) {
  stop();
  onShot = callback;
  if (process.platform !== 'win32' || typeof callback !== 'function') return false;
  const parsed = parseAccel(accel);
  if (!parsed) {
    console.warn(`[overlay] hotkey hook: unsupported accelerator "${accel}"`);
    return false;
  }

  signalFile = path.join(os.tmpdir(), `gamehub-shot-hook-${process.pid}.signal`);
  try { fs.writeFileSync(signalFile, '0'); } catch { /* */ }

  const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class GhShotHook {
  private const int WH_KEYBOARD_LL = 13;
  private const int WM_KEYDOWN = 0x0100;
  private const int WM_SYSKEYDOWN = 0x0104;
  private static LowLevelKeyboardProc _proc = HookCallback;
  private static IntPtr _hook = IntPtr.Zero;
  private static string _path;
  private static int _vk;
  private static int _shift;
  private static int _ctrl;
  private static int _alt;
  private static long _last;

  private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  private static extern IntPtr SetWindowsHookEx(int id, LowLevelKeyboardProc proc, IntPtr mod, uint thread);
  [DllImport("user32.dll", SetLastError=true)]
  private static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")]
  private static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")]
  private static extern short GetAsyncKeyState(int vKey);

  [StructLayout(LayoutKind.Sequential)]
  private struct KBDLLHOOKSTRUCT {
    public int vkCode; public int scanCode; public int flags; public int time; public IntPtr dwExtraInfo;
  }

  public static void Run(string path, int vk, int shift, int ctrl, int alt) {
    _path = path; _vk = vk; _shift = shift; _ctrl = ctrl; _alt = alt;
    using (Process cur = Process.GetCurrentProcess())
    using (ProcessModule mod = cur.MainModule) {
      _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(mod.ModuleName), 0);
    }
    if (_hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    Application.Run();
    UnhookWindowsHookEx(_hook);
  }

  private static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN)) {
      KBDLLHOOKSTRUCT info = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
      if (info.vkCode == _vk) {
        bool sh = Down(0x10); // VK_SHIFT
        bool ct = Down(0x11); // VK_CONTROL
        bool al = Down(0x12); // VK_MENU
        if (sh == (_shift != 0) && ct == (_ctrl != 0) && al == (_alt != 0)) {
          long now = DateTime.UtcNow.Ticks;
          if (now - _last > 2500000) { // ~250ms debounce
            _last = now;
            try { File.WriteAllText(_path, now.ToString()); } catch {}
          }
        }
      }
    }
    return CallNextHookEx(_hook, nCode, wParam, lParam);
  }
}
"@
[GhShotHook]::Run('${signalFile.replace(/'/g, "''")}', ${parsed.vk}, ${parsed.wantShift}, ${parsed.wantCtrl}, ${parsed.wantAlt})
`;

  try {
    hookProc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { detached: false, stdio: 'ignore', windowsHide: true }
    );
    hookProc.on('exit', () => { hookProc = null; });
    hookProc.on('error', (err) => {
      console.warn('[overlay] hotkey hook failed to start:', err.message);
      hookProc = null;
    });
  } catch (err) {
    console.warn('[overlay] hotkey hook spawn failed:', err.message);
    return false;
  }

  try {
    watcher = fs.watch(signalFile, () => {
      const now = Date.now();
      if (now - lastFire < 300) return;
      lastFire = now;
      try { onShot?.(); } catch (err) { console.warn('[overlay] hotkey hook callback:', err.message); }
    });
  } catch (err) {
    console.warn('[overlay] hotkey hook watch failed:', err.message);
    stop();
    return false;
  }
  return true;
}

module.exports = { start, stop, parseAccel };
