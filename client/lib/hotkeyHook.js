// Windows screenshot hotkey while a game has focus.
// Electron globalShortcut / before-input only see F12 when a Gamehub window is
// focused. A WH_KEYBOARD_LL helper running on an STA PowerShell thread posts to
// a tiny localhost HTTP server in the Electron process when the key is pressed.
const { spawn } = require('node:child_process');
const http = require('node:http');

let hookProc = null;
let server = null;
let onShot = null;
let lastFire = 0;
let currentAccel = null;

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

function fire() {
  const now = Date.now();
  if (now - lastFire < 400) return;
  lastFire = now;
  try { onShot?.(); } catch (err) { console.warn('[overlay] hotkey hook callback:', err.message); }
}

function stop() {
  if (hookProc) {
    try { hookProc.kill(); } catch { /* */ }
    hookProc = null;
  }
  if (server) {
    try { server.close(); } catch { /* */ }
    server = null;
  }
  currentAccel = null;
}

function start(accel, callback) {
  if (process.platform !== 'win32' || typeof callback !== 'function') {
    stop();
    return false;
  }
  const parsed = parseAccel(accel);
  if (!parsed) {
    console.warn(`[overlay] hotkey hook: unsupported accelerator "${accel}"`);
    stop();
    return false;
  }
  // Already running (or starting) for this accel — just refresh the callback.
  if (server && currentAccel === accel) {
    onShot = callback;
    return true;
  }
  stop();
  onShot = callback;
  currentAccel = accel;

  server = http.createServer((req, res) => {
    if (req.url === '/shot') {
      fire();
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Net;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class GhShotHook2 {
  private const int WH_KEYBOARD_LL = 13;
  private const int WM_KEYDOWN = 0x0100;
  private const int WM_SYSKEYDOWN = 0x0104;
  private static LowLevelKeyboardProc _proc = HookCallback;
  private static IntPtr _hook = IntPtr.Zero;
  private static int _port;
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
  [DllImport("user32.dll")]
  private static extern short GetAsyncKeyState(int vKey);

  [StructLayout(LayoutKind.Sequential)]
  private struct KBDLLHOOKSTRUCT {
    public int vkCode; public int scanCode; public int flags; public int time; public IntPtr dwExtraInfo;
  }

  public static void Run(int port, int vk, int shift, int ctrl, int alt) {
    _port = port; _vk = vk; _shift = shift; _ctrl = ctrl; _alt = alt;
    // IntPtr.Zero is valid for WH_KEYBOARD_LL on modern Windows.
    _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, IntPtr.Zero, 0);
    if (_hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    Application.Run();
    UnhookWindowsHookEx(_hook);
  }

  private static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  private static void Ping() {
    try {
      HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + _port + "/shot");
      req.Method = "GET";
      req.Timeout = 800;
      req.ReadWriteTimeout = 800;
      using (req.GetResponse()) { }
    } catch { }
  }

  private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN)) {
      KBDLLHOOKSTRUCT info = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
      if (info.vkCode == _vk) {
        bool sh = Down(0x10);
        bool ct = Down(0x11);
        bool al = Down(0x12);
        if (sh == (_shift != 0) && ct == (_ctrl != 0) && al == (_alt != 0)) {
          long now = DateTime.UtcNow.Ticks;
          if (now - _last > 3500000) {
            _last = now;
            Ping();
          }
        }
      }
    }
    return CallNextHookEx(_hook, nCode, wParam, lParam);
  }
}
"@
[GhShotHook2]::Run(${port}, ${parsed.vk}, ${parsed.wantShift}, ${parsed.wantCtrl}, ${parsed.wantAlt})
`;
    try {
      // -STA is required for Application.Run / Windows.Forms message pump.
      hookProc = spawn(
        'powershell.exe',
        ['-STA', '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
        { detached: false, stdio: 'ignore', windowsHide: true }
      );
      hookProc.on('exit', (code) => {
        if (code && code !== 0) console.warn(`[overlay] hotkey hook exited with code ${code}`);
        hookProc = null;
      });
      hookProc.on('error', (err) => {
        console.warn('[overlay] hotkey hook failed to start:', err.message);
        hookProc = null;
      });
    } catch (err) {
      console.warn('[overlay] hotkey hook spawn failed:', err.message);
      stop();
    }
  });

  server.on('error', (err) => {
    console.warn('[overlay] hotkey hook server failed:', err.message);
    stop();
  });
  return true;
}

module.exports = { start, stop, parseAccel };
