// Steam-style in-game overlay: global hotkeys while a game runs, a launch
// hint toast, F12 screen captures, and a frameless always-on-top overlay
// window (identity, web browser, this game's screenshots, quit-game).
//
// No DLL injection: the overlay is a normal Electron window set above the
// game via always-on-top ("screen-saver" level). That covers windowed and
// borderless games; exclusive-fullscreen titles keep their display lock, same
// limitation every non-injected overlay has.
const {
  app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain, shell,
} = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shots = require('./screenshots');
const { waitForGameWindow } = require('./centerwindow');

let deps = null; // { getConfig, getAvatar }
const sessions = new Map(); // gameId -> { title, started, pid }
let lastGameId = null;
let overlayWin = null;
let toastWin = null;
let registered = { overlay: null, shot: null }; // accelerators currently held
let launchHintToken = 0; // cancels a pending post-launch toast if the game exits
let inputHookInstalled = false;
let capturing = false;

function shotsRoot() {
  return path.join(app.getPath('userData'), 'Screenshots');
}

function activeSession() {
  if (lastGameId != null && sessions.has(lastGameId)) {
    return { gameId: lastGameId, ...sessions.get(lastGameId) };
  }
  const [first] = sessions;
  return first ? { gameId: first[0], ...first[1] } : null;
}

function cfg() { return deps?.getConfig?.() || {}; }
function overlayKey() { return (cfg().overlayKey || 'Shift+Tab').trim(); }
function screenshotKey() { return (cfg().screenshotKey || 'F12').trim(); }
function overlayEnabled() { return cfg().overlayEnabled !== false && !!overlayKey(); }
function shotsEnabled() { return !!screenshotKey(); }

// human label for hints: "Shift+Tab" → "Shift + Tab"
function keyLabel(acc) { return (acc || '').split('+').join(' + '); }

// Match a before-input-event against an Electron accelerator ("F12", "Shift+Tab").
function inputMatchesAccel(input, accel) {
  if (!accel || input.type !== 'keyDown' || input.isAutoRepeat) return false;
  const parts = accel.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  const keyName = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const wantCtrl = mods.has('control') || mods.has('ctrl')
    || mods.has('cmdorctrl') || mods.has('commandorcontrol');
  const wantAlt = mods.has('alt') || mods.has('option');
  const wantShift = mods.has('shift');
  const wantMeta = mods.has('meta') || mods.has('super') || mods.has('cmd') || mods.has('command');
  if (!!input.control !== wantCtrl) return false;
  if (!!input.alt !== wantAlt) return false;
  if (!!input.meta !== wantMeta) return false;
  if (!!input.shift !== wantShift) return false;
  const pressed = String(input.key || '');
  const code = String(input.code || '');
  if (/^f\d{1,2}$/i.test(keyName)) {
    return pressed.toUpperCase() === keyName.toUpperCase() || code.toUpperCase() === keyName.toUpperCase();
  }
  if (/^tab$/i.test(keyName)) return pressed === 'Tab' || code === 'Tab';
  return pressed.toLowerCase() === keyName.toLowerCase();
}

// ---------------------------------------------------------------- hotkeys
function syncHotkeys() {
  for (const key of [registered.overlay, registered.shot]) {
    if (key) { try { globalShortcut.unregister(key); } catch { /* */ } }
  }
  registered = { overlay: null, shot: null };
  if (!sessions.size) return;
  if (overlayEnabled()) {
    const key = overlayKey();
    try {
      if (globalShortcut.register(key, toggleOverlay)) registered.overlay = key;
      else console.warn(`[overlay] could not register ${key} (held by another app?)`);
    } catch (err) { console.warn(`[overlay] bad overlay hotkey "${key}":`, err.message); }
  }
  if (shotsEnabled()) {
    const key = screenshotKey();
    try {
      if (globalShortcut.register(key, () => { captureActive(); })) registered.shot = key;
      else console.warn(`[overlay] could not register ${key} (held by another app?)`);
    } catch (err) { console.warn(`[overlay] bad screenshot hotkey "${key}":`, err.message); }
  }
}

// When any Gamehub window has focus, Chromium often eats F12 for DevTools
// before globalShortcut runs. Intercept here so in-app / overlay focus still
// captures, and DevTools never steals the screenshot key mid-session.
function installInputHooks() {
  if (inputHookInstalled) return;
  inputHookInstalled = true;
  const attach = (contents) => {
    contents.on('before-input-event', (event, input) => {
      if (!sessions.size) return;
      if (shotsEnabled() && inputMatchesAccel(input, screenshotKey())) {
        event.preventDefault();
        captureActive();
        return;
      }
      if (overlayEnabled() && inputMatchesAccel(input, overlayKey())) {
        event.preventDefault();
        toggleOverlay();
      }
    });
  };
  app.on('web-contents-created', (_e, contents) => attach(contents));
  for (const win of BrowserWindow.getAllWindows()) {
    try { attach(win.webContents); } catch { /* */ }
  }
}

// ------------------------------------------------------------- toast popup
// Tiny click-through bubble above the taskbar: launch hint, capture confirm.
// Recreated per message — query params carry the payload, no IPC needed.
function showToast({ title, body = '', img = '', ms = 4500 }) {
  try { toastWin?.close(); } catch { /* */ }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  const w = 348;
  const h = img ? 132 : 84;
  toastWin = new BrowserWindow({
    width: w,
    height: h,
    x: wa.x + wa.width - w - 18,
    y: wa.y + wa.height - h - 18,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, devTools: false },
  });
  toastWin.setAlwaysOnTop(true, 'screen-saver');
  toastWin.setIgnoreMouseEvents(true);
  const tw = toastWin; // a newer toast must never be nulled/closed by this one's timers
  const q = { title, body, ms: String(ms) };
  if (img) q.img = img;
  tw.loadFile(path.join(__dirname, '..', 'renderer', 'toast.html'), { query: q });
  // no moveTop(): it crashes X11 (_NET_RESTACK_WINDOW atom, SIGTRAP) — the
  // screen-saver always-on-top level already stacks above the game on Windows.
  tw.once('ready-to-show', () => { if (!tw.isDestroyed()) tw.showInactive(); });
  tw.on('closed', () => { if (toastWin === tw) toastWin = null; });
  setTimeout(() => { try { tw.close(); } catch { /* */ } }, ms + 600); // CSS fade runs first
}

function closeToast() { try { toastWin?.close(); } catch { /* */ } toastWin = null; }

// ------------------------------------------------------------ overlay win
function toggleOverlay() {
  if (overlayWin) { closeOverlay(); return; }
  openOverlay();
}

function openOverlay() {
  const session = activeSession();
  if (!session || overlayWin) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.bounds;
  overlayWin = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true, // Steam-style: the game stays visible behind a dark tint
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'overlayPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // the in-overlay web browser
      devTools: false, // F12 is our screenshot key — never open DevTools here
    },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const ow = overlayWin;
  // Seed the session start time in the URL so the timer never paints "0:00"
  // while the async overlay:state round-trip is still in flight.
  ow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'), {
    query: { started: String(session.started || Date.now()) },
  });
  ow.once('ready-to-show', () => { if (!ow.isDestroyed()) { ow.show(); ow.focus(); } });
  ow.on('closed', () => { if (overlayWin === ow) overlayWin = null; });
}

function closeOverlay() {
  try { overlayWin?.close(); } catch { /* */ }
  overlayWin = null;
}

// -------------------------------------------------------------- screenshots
function pickScreenSource(sources, display) {
  const id = String(display.id);
  return sources.find((s) => s.display_id === id)
    || sources.find((s) => String(s.display_id) === id)
    || sources.find((s) => /screen|entire/i.test(s.name) && !s.display_id)
    || sources[0]
    || null;
}

async function grabScreenPng() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = display.scaleFactor || 1;
  const fullW = Math.max(1, Math.round(display.size.width * scale));
  const fullH = Math.max(1, Math.round(display.size.height * scale));
  // Full-res first; smaller sizes as fallback — some GPUs/drivers return an
  // empty thumbnail when asked for a huge DXGI capture in one shot.
  const sizes = [
    { width: fullW, height: fullH },
    { width: Math.round(fullW / 2), height: Math.round(fullH / 2) },
    { width: Math.min(fullW, 1920), height: Math.min(fullH, 1080) },
  ];
  let lastErr = null;
  for (const thumbnailSize of sizes) {
    try {
      const sources = await Promise.race([
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10_000)),
      ]);
      const src = pickScreenSource(sources, display);
      if (!src || src.thumbnail.isEmpty()) {
        lastErr = new Error('nothing captured');
        continue;
      }
      return src.thumbnail.toPNG();
    } catch (err) {
      lastErr = err;
    }
  }
  // Windows GDI fallback — helps when Chromium's capturer is blocked/empty.
  if (process.platform === 'win32') {
    try {
      return await grabScreenPngGdi(display);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('nothing captured');
}

function grabScreenPngGdi(display) {
  const out = path.join(os.tmpdir(), `gamehub-shot-${process.pid}-${Date.now()}.png`);
  const x = display.bounds.x;
  const y = display.bounds.y;
  const w = display.bounds.width;
  const h = display.bounds.height;
  const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap ${w}, ${h}
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size ${w}, ${h}))
$bmp.Save('${out.replace(/'/g, "''")}')
$g.Dispose(); $bmp.Dispose()
`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { windowsHide: true }
    );
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* */ } reject(new Error('GDI capture timed out')); }, 12_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0 || !fs.existsSync(out)) {
          reject(new Error(stderr.trim() || 'GDI capture failed'));
          return;
        }
        const buf = fs.readFileSync(out);
        try { fs.unlinkSync(out); } catch { /* */ }
        if (!buf.length) reject(new Error('GDI capture empty'));
        else resolve(buf);
      } catch (err) {
        reject(err);
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function captureActive() {
  const session = activeSession();
  if (!session || capturing) return null;
  capturing = true;
  // Never photograph our own chrome: the overlay (F12 while it's open, or the
  // in-overlay Capture button) and a lingering previous-capture toast are both
  // always-on-top. Fade the overlay out (opacity 0 — the compositor shows
  // straight through, no unmap/repaint flash), shoot, then restore — and only
  // then raise the confirmation toast so it stacks above the overlay.
  const reopen = !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible());
  try {
    closeToast();
    if (reopen) { overlayWin.setOpacity(0); await new Promise((r) => setTimeout(r, 350)); }
    const png = await grabScreenPng();
    const file = shots.saveShot(shotsRoot(), session.gameId, png);
    const entry = shots.listShots(shotsRoot(), session.gameId).find((e) => e.file === file);
    if (reopen && overlayWin && !overlayWin.isDestroyed()) { overlayWin.setOpacity(1); overlayWin.focus(); }
    showToast({ title: 'Screenshot saved', body: session.title, img: entry?.url || '', ms: 3600 });
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay:shot', entry || null);
    return entry || null;
  } catch (err) {
    console.warn('[overlay] screenshot failed:', err.message);
    if (reopen && overlayWin && !overlayWin.isDestroyed()) { overlayWin.setOpacity(1); overlayWin.focus(); }
    showToast({ title: 'Screenshot failed', body: err.message, ms: 3200 });
    return null;
  } finally {
    capturing = false;
  }
}

// -------------------------------------------------------------- exit game
function exitActiveGame() {
  const session = activeSession();
  if (!session?.pid) return false;
  try {
    if (process.platform === 'win32') {
      // /T takes the whole tree (launchers respawn the real exe as a child)
      spawn('taskkill', ['/pid', String(session.pid), '/T', '/F'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      try { process.kill(-session.pid, 'SIGTERM'); } catch { process.kill(session.pid, 'SIGTERM'); }
    }
    closeOverlay();
    return true;
  } catch (err) {
    console.warn('[overlay] exit-game failed:', err.message);
    return false;
  }
}

// ------------------------------------------------------------- public API
async function overlayState() {
  const session = activeSession();
  const c = cfg();
  const name = c.mode === 'local' ? 'Local' : (c.username || 'Player');
  const avatar = await Promise.resolve(deps.getAvatar?.()).catch(() => null);
  return {
    game: session ? { id: session.gameId, title: session.title, started: session.started } : null,
    user: { name, avatar: avatar || null },
    keys: { overlay: keyLabel(registered.overlay || overlayKey()), screenshot: keyLabel(registered.shot || screenshotKey()) },
    shots: session ? shots.listShots(shotsRoot(), session.gameId) : [],
  };
}

function init(d) {
  deps = d;
  installInputHooks();
  ipcMain.handle('overlay:state', () => overlayState());
  ipcMain.handle('overlay:close', () => { closeOverlay(); return true; });
  ipcMain.handle('overlay:capture', () => captureActive());
  ipcMain.handle('overlay:deleteShot', (e, file) => shots.deleteShot(shotsRoot(), file));
  ipcMain.handle('overlay:exitGame', () => exitActiveGame());
  ipcMain.handle('overlay:openExternal', (e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

function showLaunchHint(title) {
  const hints = [];
  if (registered.overlay || overlayEnabled()) hints.push(`${keyLabel(registered.overlay || overlayKey())} — overlay`);
  if (registered.shot || shotsEnabled()) hints.push(`${keyLabel(registered.shot || screenshotKey())} — screenshot`);
  if (!hints.length) return;
  showToast({ title: title || 'Game started', body: hints.join('   ·   '), ms: 5200 });
}

// Called when a spawned game process is confirmed running.
function gameStarted({ gameId, title, pid, started }) {
  sessions.set(Number(gameId), { title: title || 'Game', started: started || Date.now(), pid });
  lastGameId = Number(gameId);
  syncHotkeys(); // hotkeys available immediately during load screens
  // Toast waits until a real game window is up (or a short fallback delay),
  // so the Shift+Tab hint appears over the game — not over Gamehub pre-launch.
  const token = ++launchHintToken;
  waitForGameWindow(pid).then(() => {
    if (token !== launchHintToken) return;
    if (!sessions.has(Number(gameId))) return;
    syncHotkeys(); // re-assert after the game takes foreground (some hosts drop early regs)
    showLaunchHint(title);
  });
}

function gameEnded(gameId) {
  sessions.delete(Number(gameId));
  if (lastGameId === Number(gameId)) lastGameId = sessions.size ? [...sessions.keys()].at(-1) : null;
  if (!sessions.size) {
    launchHintToken += 1; // cancel any pending launch toast
    closeOverlay();
    closeToast();
  }
  syncHotkeys(); // re-register for a remaining session, or release everything
}

function shutdown() {
  sessions.clear();
  lastGameId = null;
  launchHintToken += 1;
  closeOverlay();
  closeToast();
  try { globalShortcut.unregisterAll(); } catch { /* */ }
  registered = { overlay: null, shot: null };
}

// Settings saved mid-game: re-read hotkeys from config.
function configChanged() { if (sessions.size) syncHotkeys(); }

module.exports = {
  init, gameStarted, gameEnded, shutdown, configChanged, shotsRoot,
  isRunning: () => sessions.size > 0,
  captureActive,
};
