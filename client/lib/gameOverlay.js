// Steam-style in-game overlay: global hotkeys while a game runs, a launch
// hint toast, F12 screen captures, and a frameless always-on-top overlay
// window (identity, web browser, this game's screenshots, quit-game).
//
// No DLL injection: the overlay is a normal Electron window set above the
// game via always-on-top ("screen-saver" level). That covers windowed and
// borderless games; exclusive-fullscreen titles keep their display lock, same
// limitation every non-injected overlay has.
const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const shots = require('./screenshots');

let deps = null; // { getConfig, getAvatar }
const sessions = new Map(); // gameId -> { title, started, pid }
let lastGameId = null;
let overlayWin = null;
let toastWin = null;
let registered = { overlay: null, shot: null }; // accelerators currently held

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
      if (globalShortcut.register(key, () => captureActive())) registered.shot = key;
      else console.warn(`[overlay] could not register ${key} (held by another app?)`);
    } catch (err) { console.warn(`[overlay] bad screenshot hotkey "${key}":`, err.message); }
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
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  toastWin.setAlwaysOnTop(true, 'screen-saver');
  toastWin.setIgnoreMouseEvents(true);
  const tw = toastWin; // a newer toast must never be nulled/closed by this one's timers
  const q = { title, body, ms: String(ms) };
  if (img) q.img = img;
  tw.loadFile(path.join(__dirname, '..', 'renderer', 'toast.html'), { query: q });
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
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreen: true,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#151311',
    webPreferences: {
      preload: path.join(__dirname, '..', 'overlayPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // the in-overlay web browser
    },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const ow = overlayWin;
  ow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  ow.once('ready-to-show', () => { if (!ow.isDestroyed()) { ow.show(); ow.focus(); } });
  ow.on('closed', () => { if (overlayWin === ow) overlayWin = null; });
}

function closeOverlay() {
  try { overlayWin?.close(); } catch { /* */ }
  overlayWin = null;
}

// -------------------------------------------------------------- screenshots
async function captureActive() {
  const session = activeSession();
  if (!session) return null;
  // Never photograph our own chrome: the overlay (F12 while it's open, or the
  // in-overlay Capture button) and a lingering previous-capture toast are both
  // always-on-top. Hide them, let the compositor settle, shoot, then restore.
  const reopen = !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible());
  try {
    closeToast();
    if (reopen) { overlayWin.hide(); await new Promise((r) => setTimeout(r, 240)); }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      },
    });
    const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) throw new Error('nothing captured');
    const file = shots.saveShot(shotsRoot(), session.gameId, src.thumbnail.toPNG());
    const entry = shots.listShots(shotsRoot(), session.gameId).find((e) => e.file === file);
    showToast({ title: 'Screenshot saved', body: session.title, img: entry?.url || '', ms: 3600 });
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay:shot', entry || null);
    return entry || null;
  } catch (err) {
    console.warn('[overlay] screenshot failed:', err.message);
    showToast({ title: 'Screenshot failed', body: err.message, ms: 3200 });
    return null;
  } finally {
    if (reopen && overlayWin && !overlayWin.isDestroyed()) { overlayWin.show(); overlayWin.focus(); }
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
  ipcMain.handle('overlay:state', () => overlayState());
  ipcMain.handle('overlay:close', () => { closeOverlay(); return true; });
  ipcMain.handle('overlay:capture', () => captureActive());
  ipcMain.handle('overlay:deleteShot', (e, file) => shots.deleteShot(shotsRoot(), file));
  ipcMain.handle('overlay:exitGame', () => exitActiveGame());
  ipcMain.handle('overlay:openExternal', (e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

// Called when a spawned game process is confirmed running.
function gameStarted({ gameId, title, pid, started }) {
  sessions.set(Number(gameId), { title: title || 'Game', started: started || Date.now(), pid });
  lastGameId = Number(gameId);
  syncHotkeys();
  const hints = [];
  if (registered.overlay) hints.push(`${keyLabel(registered.overlay)} — overlay`);
  if (registered.shot) hints.push(`${keyLabel(registered.shot)} — screenshot`);
  if (hints.length) {
    showToast({ title: title || 'Game started', body: hints.join('   ·   '), ms: 5200 });
  }
}

function gameEnded(gameId) {
  sessions.delete(Number(gameId));
  if (lastGameId === Number(gameId)) lastGameId = sessions.size ? [...sessions.keys()].at(-1) : null;
  if (!sessions.size) {
    closeOverlay();
    closeToast();
  }
  syncHotkeys(); // re-register for a remaining session, or release everything
}

function shutdown() {
  sessions.clear();
  lastGameId = null;
  closeOverlay();
  closeToast();
  try { globalShortcut.unregisterAll(); } catch { /* */ }
}

// Settings saved mid-game: re-read hotkeys from config.
function configChanged() { if (sessions.size) syncHotkeys(); }

module.exports = { init, gameStarted, gameEnded, shutdown, configChanged, shotsRoot, isRunning: () => sessions.size > 0 };
