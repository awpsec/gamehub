const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const {
  loadConfig, saveConfig, loadInstalled, saveInstalled, loadMyLibrary, saveMyLibrary,
  loadFavorites, saveFavorites, loadPlaytime, savePlaytime,
  loadCategories, saveCategories,
} = require('./lib/config');
const { makeApi, normalizeServerUrl } = require('./lib/serverApi');
const installer = require('./lib/installer');
const platform = require('./lib/platform');
const centerWindow = require('./lib/centerwindow');
const { resolveInPlacePaths } = require('./lib/inplace');
const { copyPackageToStaging, isInside } = require('./lib/localCopy');
const {
  beginJob, endJob, getJob,
  isPausedError, isCancelledError, isAbortError, abortError,
} = require('./lib/jobControl');
const { fingerprintInstaller } = require('./lib/fingerprint');
const {
  canAutoSilentInstall, attemptSilentInstallSafe, restoreInstallerAudioIfNeeded,
} = require('./lib/silentInstall');
const gameOverlay = require('./lib/gameOverlay');
const shots = require('./lib/screenshots');
const linuxDesktop = require('./lib/linuxDesktop');
const winGameProcess = require('./lib/winGameProcess');
const elevatedLaunch = require('./lib/elevatedLaunch');

/** Wine prefix for a Library install (Linux only). Stable per title under gamesDir. */
function winePrefixForTitle(title) {
  if (!platform.isLinux) return null;
  const base = config?.gamesDir || path.join(os.homedir(), '.local', 'share', 'gamehub');
  return platform.wineRunner.winePrefixPath(base, title || 'default');
}

/** Shortcut opts shared by install / pick-exe / heal paths. */
function shortcutOpts(extra = {}) {
  return {
    desktop: config.createDesktopShortcut,
    startMenu: config.createStartMenuShortcut,
    winePrefix: platform.isLinux ? (extra.winePrefix || winePrefixForTitle(extra.title)) : null,
    // Silent installs pin linuxRunner:'wine' so shortcuts match the prefix layout.
    linuxRunner: extra.linuxRunner || config.linuxRunner || 'wine',
  };
}

/**
 * Open a path: folders via shell; Windows .exe via Wine on Linux, shell on Windows.
 * Returns '' on success (shell.openPath convention) or an error string.
 */
async function openPathSmart(target, { winePrefix = null } = {}) {
  if (!target) return 'missing path';
  if (platform.isLinux && /\.exe$/i.test(target) && fs.existsSync(target)) {
    try {
      const child = platform.openWindowsExe(target, {
        ...config,
        winePrefix: winePrefix || winePrefixForTitle(path.basename(path.dirname(target))),
      }, { forInstall: /setup|install|unins/i.test(path.basename(target)) });
      child?.unref?.();
      return '';
    } catch (err) {
      return String(err?.message || err);
    }
  }
  return shell.openPath(target);
}

let win;
let config = null;
let localServer = null; // handle from the in-process server (serverless mode)
const api = makeApi(() => config);

// Do two folders overlap (same, or one inside the other)? Windows-safe
// (case-insensitive). Used to refuse organizing a library that contains the
// read-only seeding store, before any file is touched.
function pathsOverlap(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep);
}

// Is this folder strictly inside one of the user's install roots (the Library /
// picked alternates)? Distinguishes writable installs from legacy in-place
// entries that point at the read-only Store — those are never modified.
function inInstallRoot(dir) {
  if (!dir) return false;
  const roots = [config.gamesDir, ...(config.gamesDirs || [])].filter(Boolean);
  return roots.some((r) => isInside(dir, r) && path.resolve(dir) !== path.resolve(r));
}

// Serverless mode: boot the Gamehub server in-process against a local Store
// folder (torrents — scanned, read-only) and point the client at it. Installs
// land in gamesDir (the Library). Remote/NAS mode never calls this.
// Returns true once serverUrl points at the local instance.
async function startLocalLibrary() {
  // Migrate pre-1.5.2 local configs: libraryDir was the scanned folder.
  if (!config.storeDir && config.libraryDir) {
    config.storeDir = config.libraryDir;
    saveConfig(config);
  }
  const catalog = config.storeDir || config.libraryDir;
  if (!catalog) return false;
  if (!config.gamesDir) {
    throw new Error('Set a Library (games) folder before starting local mode.');
  }
  if (pathsOverlap(catalog, config.gamesDir)) {
    throw new Error('The Store and Library folders overlap. Pick separate folders so seeding files are never modified.');
  }
  if (localServer) { await localServer.close().catch(() => {}); localServer = null; }
  const embedDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'embedded')
    : path.join(__dirname, 'embedded');
  const { startEmbeddedServer } = await import(pathToFileURL(path.join(embedDir, 'embed.js')).href);
  // Pin: server libraryDir = Store (catalog + file source). Organize targets
  // gamesDir (installs). storeDir pin = Store so organize refuses if installs
  // somehow overlap the Store (also checked above).
  localServer = startEmbeddedServer({
    dataDir: path.join(app.getPath('userData'), 'localdb'),
    libraryDir: catalog,
    storeDir: catalog,
    manageLibrary: !!config.manageLibrary,
    organizeDir: config.gamesDir,
    port: 0, // OS-assigned, loopback only
    host: '127.0.0.1',
    localMode: true,
  });
  const port = await localServer.ready;
  config.serverUrl = `http://127.0.0.1:${port}`;
  console.log(`[gamehub] local Store on ${config.serverUrl} (store: ${catalog}, library: ${config.gamesDir})`);
  return true;
}
const activeTasks = new Set();
// games launched this session (detached children). Tracked so we can still bank
// their time if Gamehub is closed while a game is open — the child's own 'exit'
// never reaches a main process that has already quit.
const running = new Map(); // gameId -> { started, stopWatch? }

// bank a finished/interrupted session locally + report it to the server
function bankPlaytime(gameId, seconds) {
  if (!(seconds > 0)) return;
  const pt = loadPlaytime();
  const cur = pt[gameId] || { seconds: 0 };
  cur.seconds += seconds;
  cur.lastPlayed = new Date().toISOString();
  pt[gameId] = cur;
  savePlaytime(pt);
  api.reportPlaytime(Number(gameId), seconds); // fire-and-forget
}

/** Wire overlay + presence + playtime for a live game PID (spawn or adopted). */
function beginTrackedSession({ gameId, title, pid, started, exePath = null }) {
  const gid = Number(gameId);
  const prev = running.get(gid);
  try { prev?.stopWatch?.(); } catch { /* */ }

  if (platform.isWindows && config.centerGameWindow !== false && pid) {
    centerWindow.centerGameWindow(pid);
  }
  task(gid, 'playing');
  gameOverlay.gameStarted({ gameId: gid, title, pid, started });
  api.setStatus(gid);
  const heartbeat = setInterval(() => api.setStatus(gid), 60000);

  const endSession = (seconds, { immediateFailCode = null } = {}) => {
    clearInterval(heartbeat);
    api.setStatus(null);
    running.delete(gid);
    gameOverlay.gameEnded(gid);
    if (seconds < 10 && immediateFailCode != null && immediateFailCode !== 0) {
      task(gid, 'play-failed', {
        message: `“${title}” exited immediately (code ${immediateFailCode}). It may need dependencies (VC++ / DirectX — check the game folder for a _CommonRedist or similar), or the wrong .exe is mapped — use “Select launcher” to pick another.`,
      });
      return;
    }
    bankPlaytime(gid, seconds);
    win?.webContents.send('task:update', { gameId: gid, phase: 'playtime' });
  };

  let stopWatch = null;
  const markRunning = () => {
    running.set(gid, {
      started,
      stopWatch: () => { try { stopWatch?.cancel?.(); } catch { /* */ } },
    });
  };
  markRunning();

  return {
    onChildExit(code) {
      try { stopWatch?.cancel?.(); } catch { /* */ }
      const seconds = Math.round((Date.now() - started) / 1000);
      endSession(seconds, { immediateFailCode: code });
    },
    watchAdoptedPid() {
      stopWatch = winGameProcess.watchGamePid(pid, {
        exePath,
        started,
        onExit: (_finalPid, seconds) => endSession(seconds),
      });
      markRunning();
    },
  };
}

function sanitizeTitle(t) {
  return (t || 'Game').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
}

function isArchiveVolume(name) {
  const l = name.toLowerCase();
  // note: bare .bin/.img are NOT archives — they're usually game data
  return (
    /\.(rar|zip|7z|iso)$/.test(l) ||
    /\.r\d{2}$/.test(l) ||
    /\.(7z|zip|rar)\.\d{2,3}$/.test(l) ||
    /\.\d{3}$/.test(l)
  );
}

function moveNonArchiveLeftovers(stagingDir, installDir) {
  for (const entry of fs.readdirSync(stagingDir, { withFileTypes: true })) {
    if (entry.isFile() && isArchiveVolume(entry.name)) continue;
    const from = path.join(stagingDir, entry.name);
    const to = path.join(installDir, entry.name);
    if (fs.existsSync(to)) continue; // extraction already produced it
    try {
      fs.renameSync(from, to);
    } catch {
      /* best-effort */
    }
  }
}

function task(gameId, phase, extra = {}) {
  const job = getJob(gameId);
  if (job) {
    job.phase = phase;
    if (extra.pct != null) job.pct = extra.pct;
    if (extra.message != null) job.message = extra.message;
  }
  win?.webContents.send('task:update', { gameId, phase, ...extra });
}

// Run an install/DLC/update under a Job. Pause keeps staging + job entry;
// cancel wipes staging and clears the job. Returns the pipeline result, or
// { paused: true } / { cancelled: true } for control outcomes (not thrown to UI).
async function runJob(gameId, kind, args, fn) {
  const job = beginJob(gameId, kind, args);
  activeTasks.add(gameId);
  try {
    const result = await fn(job);
    endJob(gameId, { keepIfPaused: false });
    return result;
  } catch (err) {
    if (isPausedError(err) || (job.state === 'paused' && isAbortError(err))) {
      job.state = 'paused';
      job.wipeWorkDirs(); // drop partial extract; keep staging for resume
      task(gameId, 'paused', {
        pct: job.pct,
        message: job.phase === 'extracting'
          ? 'Paused — download kept. Resume to unpack.'
          : (job.message ? `Paused — ${job.message}` : 'Paused. Resume anytime.'),
      });
      endJob(gameId, { keepIfPaused: true });
      return { paused: true };
    }
    if (isCancelledError(err) || job.state === 'cancelled' || isAbortError(err)) {
      job.wipeStaging();
      task(gameId, 'cancelled', { message: 'Cancelled.' });
      endJob(gameId, { keepIfPaused: false });
      return { cancelled: true };
    }
    // Real failure — clear the busy chrome so the UI doesn't stick on "Downloading"
    task(gameId, 'error', { message: err.message || 'Install failed' });
    endJob(gameId, { keepIfPaused: false });
    throw err;
  } finally {
    activeTasks.delete(gameId);
    // paused jobs stay in the jobs map (and conceptually "active" for UI)
    if (getJob(gameId)?.state === 'paused') activeTasks.add(gameId);
  }
}

// Themed in-app question dialog: rendered by the renderer in Gamehub's own
// style instead of a native Windows message box. Resolves to the index of the
// chosen button. Falls back to the native box if the renderer isn't available
// (e.g. during startup crashes). Cancel during an install dismisses the modal
// so the pipeline can abort instead of waiting forever on a button click.
let askSeq = 0;
let pendingAsk = null; // { id, resolve }
function dismissPendingAsk(response = -1) {
  if (!pendingAsk) return;
  const { id, resolve } = pendingAsk;
  pendingAsk = null;
  try { ipcMain.removeAllListeners(`ui:answer:${id}`); } catch { /* */ }
  try { win?.webContents?.send('ui:ask-dismiss'); } catch { /* */ }
  resolve(response);
}
async function askUser({ title, message, detail = '', buttons, defaultId = 0 }) {
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    const id = ++askSeq;
    return await new Promise((resolve) => {
      pendingAsk = { id, resolve };
      ipcMain.once(`ui:answer:${id}`, (e, response) => {
        if (pendingAsk?.id === id) pendingAsk = null;
        resolve(Number(response) || 0);
      });
      win.webContents.send('ui:ask', { id, title, message, detail, buttons, defaultId });
    });
  }
  const r = await dialog.showMessageBox(win, { type: 'question', buttons, defaultId, title, message, detail });
  return r.response;
}

// is a saved window rect still usable — i.e. is its top-left on some connected
// display's work area (so a disconnected monitor can't strand it off-screen)?
function onScreen(b) {
  if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const { x, y, width, height } = d.workArea;
    return b.x >= x - 8 && b.y >= y - 8 && b.x < x + width - 60 && b.y < y + height - 40;
  });
}
// remember size + position (and maximized state) so we reopen where we left off
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds(); // un-maximized rect — reopen at the size you chose
  config = { ...config, winBounds: { x: b.x, y: b.y, width: b.width, height: b.height }, winMaximized: win.isMaximized() };
  saveConfig(config);
}

function createWindow() {
  // comfortable default: a fraction of the monitor work area (Steam-like) —
  // never cramped on a laptop, never absurd on a 4K / ultrawide panel
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const defW = Math.min(wa.width - 40, Math.max(1100, Math.min(1760, Math.round(wa.width * 0.8))));
  const defH = Math.min(wa.height - 40, Math.max(720, Math.min(1100, Math.round(wa.height * 0.85))));
  const saved = onScreen(config.winBounds) ? config.winBounds : null;
  win = new BrowserWindow({
    width: saved ? saved.width : defW,
    height: saved ? saved.height : defH,
    ...(saved ? { x: saved.x, y: saved.y } : { center: true }),
    minWidth: 900,
    minHeight: 600,
    frame: false, // custom title bar — themed like the web UI
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#151311',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  if (saved && config.winMaximized) win.maximize();
  win.on('close', saveBounds);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Renderer may miss early update:status events (check starts ~6s after boot).
  // Replay the last known status once the page is ready.
  win.webContents.on('did-finish-load', () => replayUpdateStatus());
  // Mid-session releases: re-check when the user comes back to Gamehub.
  win.on('focus', () => {
    if (Date.now() - lastUpdateCheckAt >= 45_000) checkForUpdates(false);
  });
}

ipcMain.handle('win:minimize', () => win.minimize());
ipcMain.handle('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.handle('win:close', () => win.close());

// Window dragging + double-click-to-maximize are native (-webkit-app-region on
// the title bar — see renderer/style.css). No IPC needed.
ipcMain.handle('shell:openExternal', (e, url) => {
  // only ever hand the OS an http(s) URL — never a file:// or custom scheme
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

app.setAppUserModelId('com.gamehub.client'); // proper taskbar identity on Windows

app.whenReady().then(async () => {
  // If a prior silent install crashed while system-muted, undo that first.
  try { restoreInstallerAudioIfNeeded(); } catch { /* */ }
  config = loadConfig();
  // Repo is public — drop any leftover private-update tokens from older builds.
  if (config.updateTokenEnc || config.updateToken) {
    delete config.updateTokenEnc;
    delete config.updateToken;
    saveConfig(config);
  }
  markGamesDir();
  gameOverlay.init({ getConfig: () => config, getAvatar: fetchAvatar });
  if (config.mode === 'local') {
    try {
      await startLocalLibrary();
    } catch (err) {
      console.error('[gamehub] local library failed to start:', err);
      // Stay in local mode so Settings / Reset remain reachable — never silently
      // flip a torrents-on-this-PC setup into "connect to a server" mode.
      dialog.showErrorBox(
        'Local library',
        `Couldn't start the local library:\n\n${err.message}\n\nGamehub will open anyway — check Store & Library folders in Settings, or use Reset setup.`
      );
    }
  }
  createWindow();
  // AppImage: ensure a user application-menu entry exists so Gamehub isn't
  // terminal-only after download. .deb installs already ship a system .desktop.
  if (platform.isLinux && linuxDesktop.isAppImage() && !linuxDesktop.desktopEntryInstalled()) {
    try {
      const r = linuxDesktop.installUserDesktopEntry();
      if (r.ok) console.log('[gamehub] installed application menu entry →', r.path);
    } catch (err) {
      console.warn('[gamehub] could not install desktop entry:', err.message);
    }
  }
  // App updates: check after the window is up, then often while open, and again
  // when Gamehub is focused — so a release published mid-session shows up without
  // killing the process.
  setTimeout(() => checkForUpdates(false), 5_000);
  setInterval(() => checkForUpdates(false), 2 * 60 * 1000);
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  gameOverlay.shutdown(); // release global hotkeys before exit
  if (localServer) localServer.close().catch(() => {});
});
// closing Gamehub while a game is still running would otherwise lose that
// session's time — bank whatever has accrued so far on the way out
app.on('before-quit', () => {
  const now = Date.now();
  for (const [gameId, sess] of running) {
    try { sess.stopWatch?.(); } catch { /* */ }
    bankPlaytime(gameId, Math.round((now - sess.started) / 1000));
  }
  running.clear();
});

// ---------- config ----------
ipcMain.handle('config:get', () => {
  const { updateTokenEnc, updateToken, ...safe } = config; // strip legacy token fields if present
  return {
    ...safe,
    // sensible pre-fill for the first-run games-folder step
    suggestedGamesDir: path.join(os.homedir(), 'Games'),
    // host OS for compatibility messaging (win32 | linux | darwin)
    hostPlatform: process.platform,
    // Linux: whether Wine/Proton/umu is detectable for .exe install & play
    wineAvailable: platform.isLinux ? platform.hasWineRunner(config) : true,
    // Linux menu integration (AppImage / portable)
    linuxDesktop: platform.isLinux ? linuxDesktop.status() : null,
    // Windows: one-time elevated game-launch helper (Task Scheduler)
    elevatedLaunch: platform.isWindows ? elevatedLaunch.status() : { supported: false },
  };
});
ipcMain.handle('elevatedLaunch:status', () => (
  platform.isWindows ? elevatedLaunch.status() : { supported: false }
));
ipcMain.handle('elevatedLaunch:enable', async () => {
  if (!platform.isWindows) return { ok: false, error: 'unsupported' };
  const r = await elevatedLaunch.enable();
  if (r.ok) {
    config = { ...config, elevatedLaunchPrompted: true };
    saveConfig(config);
  }
  return r;
});
ipcMain.handle('elevatedLaunch:disable', async () => {
  if (!platform.isWindows) return { ok: false, error: 'unsupported' };
  return elevatedLaunch.disable();
});
ipcMain.handle('linuxDesktop:status', () => linuxDesktop.status());
ipcMain.handle('linuxDesktop:install', () => linuxDesktop.installUserDesktopEntry());
ipcMain.handle('linuxDesktop:remove', () => linuxDesktop.removeUserDesktopEntry());

ipcMain.handle('config:set', (e, next) => {
  config = { ...config, ...next };
  if (typeof config.serverUrl === 'string') {
    config.serverUrl = normalizeServerUrl(config.serverUrl);
  }
  saveConfig(config);
  markGamesDir();
  gameOverlay.configChanged(); // pick up hotkey changes mid-game
  return config;
});

// Serverless onboarding: Store (torrents) + Library (installs) on this PC.
// Remote mode is never entered here.
ipcMain.handle('local:enable', async (e, { storeDir, gamesDir } = {}) => {
  const store = String(storeDir || '').trim();
  const lib = String(gamesDir || '').trim();
  if (!store) return { error: 'pick a Store folder first (your torrents / completed downloads)' };
  if (!lib) return { error: 'pick a Library folder first (where games install)' };
  if (pathsOverlap(store, lib)) {
    return { error: 'The Store and Library folders overlap. Pick separate folders so seeding files are never modified.' };
  }
  config = {
    ...config,
    mode: 'local',
    storeDir: store,
    libraryDir: store, // legacy alias kept in sync for older heal/UI paths
    gamesDir: lib,
    authToken: '',
    username: 'local',
    apiKey: '',
  };
  saveConfig(config);
  markGamesDir();
  try {
    await startLocalLibrary();
    return { ok: true, serverUrl: config.serverUrl };
  } catch (err) {
    console.error('[gamehub] local:enable failed:', err);
    return { error: err.message };
  }
});

// Serverless settings: change Store / Library / organize. Re-boots the
// in-process server so the new settings are pinned + a fresh scan runs.
ipcMain.handle('local:configure', async (e, patch = {}) => {
  if (config.mode !== 'local') return { error: 'not in local mode' };
  const next = { ...config };
  if (typeof patch.storeDir === 'string' && patch.storeDir.trim()) {
    next.storeDir = patch.storeDir.trim();
    next.libraryDir = next.storeDir; // keep legacy alias in sync
  }
  // Accept libraryDir as an alias for gamesDir from older UI wording
  if (typeof patch.gamesDir === 'string' && patch.gamesDir.trim()) next.gamesDir = patch.gamesDir.trim();
  else if (typeof patch.libraryDir === 'string' && patch.libraryDir.trim()
    && patch.libraryDir.trim() !== next.storeDir) {
    // Older UI called the install folder "libraryDir" — only treat it as gamesDir
    // when it isn't the store path.
    next.gamesDir = patch.libraryDir.trim();
  }
  if (typeof patch.manageLibrary === 'boolean') next.manageLibrary = patch.manageLibrary;

  const catalog = next.storeDir || next.libraryDir;
  if (!catalog) return { error: 'Store folder is required in local mode.' };
  if (!next.gamesDir) return { error: 'Library (games) folder is required in local mode.' };
  if (pathsOverlap(catalog, next.gamesDir)) {
    return { error: 'The Store and Library folders overlap. Pick separate folders so seeding files are never modified.' };
  }
  config = next;
  saveConfig(config);
  markGamesDir();
  try {
    await startLocalLibrary();
    return { ok: true, serverUrl: config.serverUrl };
  } catch (err) {
    console.error('[gamehub] local:configure failed:', err);
    return { error: err.message };
  }
});

// Leave serverless mode and return to the welcome screen so the user can
// connect to a remote Gamehub server (or set up local again). Does NOT delete
// Store/Library files on disk — only clears local mode config + stops the
// in-process server. installed.json / library.json are cleared so remote mode
// starts clean (they were local-only state).
ipcMain.handle('local:reset', async () => {
  if (localServer) {
    try { await localServer.close(); } catch { /* best-effort */ }
    localServer = null;
  }
  config = {
    mode: 'remote',
    libraryDir: '',
    storeDir: '',
    manageLibrary: false,
    serverUrl: 'http://localhost:8686',
    apiKey: '',
    authToken: '',
    username: '',
    gamesDir: '',
    gamesDirs: [],
    showSteamPrices: config.showSteamPrices !== false,
    deleteArchivesAfterExtract: config.deleteArchivesAfterExtract !== false,
    createDesktopShortcut: config.createDesktopShortcut !== false,
    createStartMenuShortcut: config.createStartMenuShortcut !== false,
    centerGameWindow: config.centerGameWindow !== false,
    linuxRunner: config.linuxRunner || 'wine',
    ...(config.winBounds ? { winBounds: config.winBounds } : {}),
    ...(config.winMaximized != null ? { winMaximized: config.winMaximized } : {}),
  };
  saveConfig(config);
  try { saveInstalled({}); } catch { /* */ }
  try { saveMyLibrary([]); } catch { /* */ }
  return { ok: true };
});

// Refresh button → scan the library folder for newly-added games (local mode
// scans in-process; a remote admin triggers a server scan; guests just reload).
ipcMain.handle('library:rescan', () => api.rescan());

// ---------- screenshots (F12 captures + library views) ----------
// Files live under userData/Screenshots/<gameId>/. Paths from the renderer are
// always re-validated against that root — never trusted.
ipcMain.handle('shots:list', (e, gameId) => shots.listShots(gameOverlay.shotsRoot(), gameId ?? null));
ipcMain.handle('shots:delete', (e, file) => shots.deleteShot(gameOverlay.shotsRoot(), file));
ipcMain.handle('shots:openFolder', async (e, gameId) => {
  const root = gameOverlay.shotsRoot();
  const dir = gameId != null ? shots.gameDir(root, gameId) : root;
  if (!dir) return { error: 'invalid game id' };
  fs.mkdirSync(dir, { recursive: true }); // opening an empty folder is fine
  const err = await shell.openPath(dir);
  return err ? { error: err } : { ok: true };
});
ipcMain.handle('shots:showInFolder', (e, file) => {
  if (typeof file !== 'string' || !shots.isInside(gameOverlay.shotsRoot(), file)) return { error: 'not a screenshot' };
  shell.showItemInFolder(path.resolve(file));
  return { ok: true };
});

// ---------- auto-update (electron-updater ← public GitHub releases) ----------
// Releases are published on the public awpsec/gamehub repo — no token needed.
autoUpdater.autoDownload = true;          // fetch in the background once found
autoUpdater.autoInstallOnAppQuit = false; // install only when the user clicks
autoUpdater.allowDowngrade = false;
autoUpdater.logger = {
  info: (m) => console.log('[update]', m),
  warn: (m) => console.warn('[update]', m),
  error: (m) => console.error('[update]', m),
  debug: () => {},
};

let lastUpdateStatus = { status: 'idle' }; // replayed to the renderer after load
let lastUpdateCheckAt = 0;
let updateCheckInFlight = false;

function sendUpdate(status, extra = {}) {
  lastUpdateStatus = { status, ...extra, at: Date.now() };
  if (win && !win.isDestroyed()) win.webContents.send('update:status', lastUpdateStatus);
}
function replayUpdateStatus() {
  if (!win || win.isDestroyed()) return;
  if (lastUpdateStatus.status === 'idle') return;
  win.webContents.send('update:status', lastUpdateStatus);
}
function configureUpdateFeed() {
  // Re-apply feed before each check so mid-session releases stay discoverable.
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'awpsec',
    repo: 'gamehub',
  });
}
autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
autoUpdater.on('update-available', (info) => sendUpdate('available', { version: info.version }));
autoUpdater.on('update-not-available', (info) => sendUpdate('none', { version: info?.version }));
autoUpdater.on('download-progress', (p) => sendUpdate('downloading', {
  version: lastUpdateStatus.version,
  percent: Math.round(p.percent || 0),
}));
autoUpdater.on('update-downloaded', (info) => sendUpdate('ready', { version: info.version }));
autoUpdater.on('error', (err) => sendUpdate('error', { message: String(err?.message || err) }));

async function checkForUpdates(interactive = false) {
  if (updateCheckInFlight) {
    if (interactive) sendUpdate(lastUpdateStatus.status || 'checking', { ...lastUpdateStatus, message: 'Already checking…' });
    return lastUpdateStatus;
  }
  if (!app.isPackaged) {
    if (interactive) sendUpdate('dev');
    return lastUpdateStatus;
  }
  updateCheckInFlight = true;
  lastUpdateCheckAt = Date.now();
  try {
    configureUpdateFeed();
    const result = await autoUpdater.checkForUpdates();
    // If events were somehow missed, still surface a found update from the result.
    const ver = result?.updateInfo?.version;
    if (ver && lastUpdateStatus.status !== 'ready' && lastUpdateStatus.status !== 'available'
        && lastUpdateStatus.status !== 'downloading') {
      const cur = app.getVersion();
      if (ver !== cur) sendUpdate('available', { version: ver });
    }
    return result;
  } catch (err) {
    sendUpdate('error', { message: String(err?.message || err) });
    return null;
  } finally {
    updateCheckInFlight = false;
  }
}

ipcMain.handle('update:check', () => checkForUpdates(true));
ipcMain.handle('update:status', () => lastUpdateStatus);
ipcMain.handle('update:install', () => { setImmediate(() => autoUpdater.quitAndInstall()); return true; });

// marker file so a server scanning this folder (e.g. games dir accidentally
// placed inside the library) knows to skip it
function markGamesDir() {
  if (!config.gamesDir) return;
  try {
    fs.mkdirSync(config.gamesDir, { recursive: true });
    const marker = path.join(config.gamesDir, '.gamehub-client');
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, 'This folder is a Gamehub client install location. Servers skip it when scanning.');
    }
  } catch { /* best-effort */ }
}
ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickExeFile', async (e, defaultPath) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select the game launcher',
    defaultPath: defaultPath || config.gamesDir,
    filters: [{ name: 'Programs', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- library ----------
ipcMain.handle('library:get', async () => {
  const [status, games] = await Promise.all([api.status(), api.library()]);
  return {
    status,
    games,
    installed: loadInstalled(),
    myLibrary: loadMyLibrary(),
    favorites: loadFavorites(),
    playtime: loadPlaytime(),
    categories: normalizeCategories(loadCategories()),
  };
});

// profile + social stats (server-side per-user playtime)
// Avatar for the overlay's identity corner: cached briefly so opening the
// overlay never waits on the server.
let cachedAvatar = null;
let avatarFetchedAt = 0;
async function fetchAvatar() {
  if (!config.authToken) return null; // local mode / guests have no profile
  if (cachedAvatar && Date.now() - avatarFetchedAt < 5 * 60_000) return cachedAvatar;
  const stats = await api.myStats().catch(() => null);
  if (stats?.avatar) { cachedAvatar = stats.avatar; avatarFetchedAt = Date.now(); }
  return cachedAvatar;
}
ipcMain.handle('me:stats', () => api.myStats());
ipcMain.handle('user:stats', (_e, id) => api.userStats(id));
ipcMain.handle('social:leaderboard', () => api.leaderboard());
ipcMain.handle('me:avatar', (_e, avatar) => api.setAvatar(avatar));

// shape guard — a malformed categories.json must never break the library
function normalizeCategories(c) {
  const cats = Array.isArray(c?.categories) ? c.categories.filter((x) => x && x.id && typeof x.name === 'string') : [];
  for (const cat of cats) cat.games = Array.isArray(cat.games) ? cat.games : [];
  return { categories: cats, collapsed: c?.collapsed && typeof c.collapsed === 'object' ? c.collapsed : {} };
}
ipcMain.handle('cat:get', () => normalizeCategories(loadCategories()));
ipcMain.handle('cat:save', (e, data) => {
  const clean = normalizeCategories(data);
  saveCategories(clean);
  return clean;
});

ipcMain.handle('fav:toggle', (e, gameId) => {
  let favs = loadFavorites();
  favs = favs.includes(gameId) ? favs.filter((id) => id !== gameId) : [...favs, gameId];
  saveFavorites(favs);
  return favs;
});

ipcMain.handle('auth:login', async (e, { username, password }) => {
  const { token, user, created } = await api.login(username, password);
  config = { ...config, authToken: token, username: user.username };
  saveConfig(config);
  return { ...user, created };
});

ipcMain.handle('auth:register', async (e, { username, password, confirm }) => {
  const { token, user, created } = await api.register(username, password, confirm);
  config = { ...config, authToken: token, username: user.username };
  saveConfig(config);
  return { ...user, created };
});

ipcMain.handle('auth:status', async () => {
  const st = await api.authStatus();
  return { ...st, username: config.username, hasToken: !!config.authToken };
});

ipcMain.handle('auth:logout', async () => {
  try {
    await api.logout();
  } catch { /* token may already be dead */ }
  config = { ...config, authToken: '' };
  saveConfig(config);
  return true;
});

ipcMain.handle('mylib:add', (e, gameId) => {
  const list = loadMyLibrary();
  if (!list.includes(gameId)) list.push(gameId);
  saveMyLibrary(list);
  return list;
});

ipcMain.handle('mylib:remove', (e, gameId) => {
  const list = loadMyLibrary().filter((id) => id !== gameId);
  saveMyLibrary(list);
  return list;
});

// ---------- install pipeline ----------
ipcMain.handle('game:install', async (e, { gameId, packageId, installDir } = {}) => {
  const baseDir = installDir || config.gamesDir;
  if (!baseDir) throw new Error('Set your games folder in Settings first.');
  // installing implies it belongs in your library (keyed by the logical game id)
  const list = loadMyLibrary();
  if (!list.includes(gameId)) {
    list.push(gameId);
    saveMyLibrary(list);
  }
  return runJob(gameId, 'install', { gameId, packageId: packageId ?? gameId, installDir: baseDir }, (job) =>
    installGame(gameId, packageId ?? gameId, baseDir, job)
  );
});

ipcMain.handle('game:pause', async (e, gameId) => {
  const job = getJob(gameId);
  if (!job || job.state !== 'running') return { ok: false, error: 'Nothing to pause.' };
  const r = job.pause();
  dismissPendingAsk(-1);
  return r;
});

ipcMain.handle('game:resume', async (e, gameId) => {
  const job = getJob(gameId);
  if (!job || job.state !== 'paused') throw new Error('Nothing paused for this game.');
  const prep = job.prepareResume();
  if (!prep.ok) throw new Error(prep.error || 'Could not resume.');
  task(gameId, job.phase === 'extracting' ? 'extracting' : 'downloading', {
    pct: job.pct,
    message: 'Resuming…',
  });
  // Re-enter the same pipeline; staging partials resume automatically.
  const { kind, args } = job;
  // Drop the paused marker from activeTasks so runJob can re-add cleanly —
  // but keep the job object (beginJob would replace a paused job; we reuse it).
  activeTasks.delete(gameId);
  // Manually drive the same finally semantics as runJob without beginJob().
  activeTasks.add(gameId);
  try {
    let result;
    if (kind === 'install') result = await installGame(args.gameId, args.packageId, args.installDir, job);
    else if (kind === 'dlc') result = await installDlc(args.gameId, args.packageId, args.parentGameId, job);
    else if (kind === 'update') result = await applyUpdate(args.gameId, args.packageId, job);
    else throw new Error(`Unknown job kind: ${kind}`);
    endJob(gameId, { keepIfPaused: false });
    return result;
  } catch (err) {
    if (isPausedError(err) || (job.state === 'paused' && isAbortError(err))) {
      job.state = 'paused';
      job.wipeWorkDirs();
      task(gameId, 'paused', {
        pct: job.pct,
        message: job.phase === 'extracting'
          ? 'Paused — download kept. Resume to unpack.'
          : (job.message ? `Paused — ${job.message}` : 'Paused. Resume anytime.'),
      });
      endJob(gameId, { keepIfPaused: true });
      return { paused: true };
    }
    if (isCancelledError(err) || job.state === 'cancelled' || isAbortError(err)) {
      job.wipeStaging();
      task(gameId, 'cancelled', { message: 'Cancelled.' });
      endJob(gameId, { keepIfPaused: false });
      return { cancelled: true };
    }
    // Real failure — clear the busy chrome so the UI doesn't stick on "Downloading"
    task(gameId, 'error', { message: err.message || 'Install failed' });
    endJob(gameId, { keepIfPaused: false });
    throw err;
  } finally {
    activeTasks.delete(gameId);
    if (getJob(gameId)?.state === 'paused') activeTasks.add(gameId);
  }
});

ipcMain.handle('game:cancel', async (e, gameId) => {
  const job = getJob(gameId);
  if (!job) return { ok: false, error: 'Nothing to cancel.' };
  const wasPaused = job.state === 'paused';
  job.cancel();
  // Unblock any in-app ask modal so throwIfAborted can run after askUser returns.
  dismissPendingAsk(-1);
  if (wasPaused) {
    // No in-flight promise to catch AbortError — clean up here.
    job.wipeStaging();
    task(gameId, 'cancelled', { message: 'Cancelled.' });
    activeTasks.delete(gameId);
    endJob(gameId, { keepIfPaused: false });
  }
  // If running, the in-flight pipeline's catch in runJob/resume handles wipe + event.
  return { ok: true };
});

// ---------- DLC: merge into the base game's install ----------
// Drop-in DLC (the common form) downloads, unpacks, and merges into the
// installed base game's folder — every file added is recorded so the DLC can
// be removed individually later. Repack-style DLC that ship their own
// setup.exe fall back to the normal wizard flow in their own folder.
async function installDlc(dlcId, packageId, parentId, job) {
  const installed = loadInstalled();
  let parent = installed[parentId];
  if (parent) parent = await healLocalEntry(parentId, parent); // organize may have renamed the base install
  if (!parent?.dir || !fs.existsSync(parent.dir)) throw new Error('Install the base game first.');
  // seeding safety: an in-place game that lives OUTSIDE the Library is the
  // read-only Store copy — never write into it. Reclaimed installs inside the
  // Library are ours to extend.
  if (parent.inPlace && !inInstallRoot(parent.dir)) {
    throw new Error('This game plays in place from your Store folder, which Gamehub never modifies. Install the base game into your Library first, then add DLC.');
  }
  job?.throwIfAborted();
  const pkg = await api.game(packageId);
  const title = sanitizeTitle(pkg.meta_title || pkg.clean_name);
  const baseDir = path.dirname(parent.dir);
  const stagingDir = path.join(baseDir, '_staging', `${dlcId}-pkg${packageId}-${title}`);
  const workDir = path.join(baseDir, '_staging', `${dlcId}-pkg${packageId}-${title}-payload`);
  job?.trackStaging(stagingDir);
  job?.trackWork(workDir);

  // 1. fetch to staging (HTTP remote, or local Store copy). Keep partials so
  // a dropped connection can resume; staging is keyed by packageId.
  task(dlcId, 'downloading', { pct: 0, message: 'Fetching file list…' });
  const files = await api.files(packageId);
  await fetchPackageToStaging(
    dlcId, packageId, pkg, files, stagingDir,
    config.mode === 'local' ? 'Copying' : 'Downloading',
    job
  );
  job?.throwIfAborted();

  let stagingDone = false;
  try {
    // 2. unpack to a work area first — never extract straight into the game dir
    task(dlcId, 'extracting', { message: 'Unpacking…' });
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    const extractedCount = await installer.extractAll(stagingDir, workDir, (m) =>
      task(dlcId, 'extracting', { message: m }), job?.signal
    );
    job?.throwIfAborted();
    if (extractedCount === 0) {
      for (const entry of fs.readdirSync(stagingDir)) {
        fs.renameSync(path.join(stagingDir, entry), path.join(workDir, entry));
      }
    }
    installer.flattenSingleDir(workDir);

    // repack-style DLC with its own setup wizard → its own folder + wizard flow
    if (installer.findInstaller(workDir)) {
      const dlcDir = path.join(baseDir, title);
      fs.rmSync(dlcDir, { recursive: true, force: true });
      fs.renameSync(workDir, dlcDir);
      installed[dlcId] = {
        title, dir: dlcDir, mode: 'installer', status: 'needs-install',
        installer: installer.findInstaller(dlcDir), shortcuts: [], packageId, parentGameId: parentId,
      };
      saveInstalled(installed);
      stagingDone = true;
      task(dlcId, 'needs-install', { message: `Installer found — run it and point it at ${parent.dir}.` });
      return installed[dlcId];
    }

    // 3. drop-in DLC: merge into the game folder, recording every file added
    task(dlcId, 'extracting', { message: `Adding to ${parent.title}…` });
    const added = [];
    const merge = (src, dst) => {
      fs.mkdirSync(dst, { recursive: true });
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name);
        const d = path.join(dst, e.name);
        if (e.isDirectory()) merge(s, d);
        else {
          fs.rmSync(d, { force: true }); // DLC files win over base files
          fs.renameSync(s, d);
          added.push(d);
        }
      }
    };
    try {
      merge(workDir, parent.dir);
    } catch (err) {
      for (const f of added) { try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ } }
      throw err;
    }
    installed[dlcId] = {
      title, mode: 'dlc', status: 'installed', dir: parent.dir,
      parentGameId: parentId, files: added, shortcuts: [], packageId,
    };
    parent.dlc = { ...(parent.dlc || {}), [dlcId]: title };
    saveInstalled(installed);
    stagingDone = true;
    task(dlcId, 'done', { message: `${title} added to ${parent.title}.` });
    return installed[dlcId];
  } finally {
    // Keep downloaded staging on failure so a retry doesn't re-fetch; wipe after success.
    fs.rmSync(workDir, { recursive: true, force: true });
    if (stagingDone) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

ipcMain.handle('game:installDlc', async (e, { gameId, packageId, parentGameId } = {}) => {
  // installing a DLC implies it belongs in your library too
  const list = loadMyLibrary();
  if (!list.includes(gameId)) { list.push(gameId); saveMyLibrary(list); }
  return runJob(
    gameId,
    'dlc',
    { gameId, packageId: packageId ?? gameId, parentGameId },
    (job) => installDlc(gameId, packageId ?? gameId, parentGameId, job)
  );
});

// official DLC list for a base game (proxied from the server)
ipcMain.handle('game:dlc', async (e, gameId) => api.dlc(gameId));

// ---------- one-click update: overlay a patch package onto the install ----------
// Scene update packages are file overlays for an existing install. Download,
// unpack to a work area, then merge-overwrite into the game folder (saves are
// backed up first; the install is audited after). Updates with their own
// setup wizard are extracted next to the game for a manual run.
async function applyUpdate(gameId, packageId, job) {
  const installed = loadInstalled();
  let entry = installed[gameId];
  if (entry) entry = await healLocalEntry(gameId, entry); // organize may have renamed the install
  if (!entry?.dir || !fs.existsSync(entry.dir)) throw new Error('Install the game first.');
  if (entry.inPlace && !inInstallRoot(entry.dir)) {
    throw new Error('This game plays in place from your Store folder, which Gamehub never modifies. Install it into your Library to apply updates.');
  }
  job?.throwIfAborted();
  const pkg = await api.game(packageId);
  const title = sanitizeTitle(pkg.meta_title || pkg.clean_name);
  const baseDir = path.dirname(entry.dir);
  const stagingDir = path.join(baseDir, '_staging', `upd-${gameId}-${packageId}`);
  const workDir = `${stagingDir}-payload`;
  job?.trackStaging(stagingDir);
  job?.trackWork(workDir);

  task(gameId, 'downloading', { pct: 0, message: 'Fetching update…' });
  const files = await api.files(packageId);
  await fetchPackageToStaging(
    gameId, packageId, pkg, files, stagingDir,
    config.mode === 'local' ? 'Copying update' : 'Downloading update',
    job
  );
  job?.throwIfAborted();

  let stagingDone = false;
  try {
    task(gameId, 'extracting', { message: 'Unpacking update…' });
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    const extractedCount = await installer.extractAll(stagingDir, workDir, (m) =>
      task(gameId, 'extracting', { message: m }), job?.signal
    );
    job?.throwIfAborted();
    if (extractedCount === 0) {
      for (const e2 of fs.readdirSync(stagingDir)) {
        fs.renameSync(path.join(stagingDir, e2), path.join(workDir, e2));
      }
    }
    installer.flattenSingleDir(workDir);

    // Wizard-based update: extract beside the game and hand off. We CANNOT see
    // whether the external wizard succeeds, so we do NOT mark it applied — the
    // update stays available and the user dismisses it once done. Many scene
    // update wizards are binary-delta patchers locked to ONE base release
    // (they verify MD5s and refuse a different repack), so say so up front.
    if (installer.findInstaller(workDir)) {
      const updDir = path.join(baseDir, `${entry.title || title} - Update`);
      fs.rmSync(updDir, { recursive: true, force: true });
      fs.renameSync(workDir, updDir);
      await openPathSmart(installer.findInstaller(updDir));
      const grp = (String(pkg.raw_name || '').match(/-([A-Za-z0-9]+)$/) || [])[1];
      stagingDone = true;
      task(gameId, 'update-wizard', {
        message: `Update installer opened — point it at ${entry.dir}. If it reports missing or hash-mismatched files, it's a delta patch built for the ${grp ? `${grp} ` : ''}release and can't update a different repack — grab the newest full release instead. Dismiss the update once it finishes.`,
      });
      return entry;
    }

    // Updates often wrap their files in a folder named after the game
    // ("Age of Mythology Retold/…" + an .nfo) — merge from INSIDE the wrapper,
    // or the whole update would land as a nested subfolder and change nothing.
    let mergeRoot = workDir;
    {
      const tops = fs.readdirSync(workDir, { withFileTypes: true });
      const dirs = tops.filter((t) => t.isDirectory());
      const looseSmall = tops
        .filter((t) => t.isFile())
        .every((f) => { try { return fs.statSync(path.join(workDir, f.name)).size < 5 * 1024 * 1024; } catch { return true; } });
      if (dirs.length === 1 && looseSmall) {
        const nk = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const dn = nk(dirs[0].name);
        const gn = nk(entry.title || title);
        const bn = nk(path.basename(entry.dir));
        if (dn && ((gn && (dn.includes(gn) || gn.includes(dn))) || (bn && (dn.includes(bn) || bn.includes(dn))))) {
          mergeRoot = path.join(workDir, dirs[0].name);
        }
      }
    }

    // protect in-folder saves, then overlay (update files win)
    backupSaves(entry.dir, savesDirFor(baseDir, entry.title || title));
    task(gameId, 'extracting', { message: 'Applying update…' });
    let applied = 0;
    const merge = (src, dst) => {
      fs.mkdirSync(dst, { recursive: true });
      for (const e2 of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e2.name);
        const d = path.join(dst, e2.name);
        if (e2.isDirectory()) merge(s, d);
        else {
          fs.rmSync(d, { force: true });
          fs.renameSync(s, d);
          applied++;
        }
      }
    };
    try {
      merge(mergeRoot, entry.dir);
    } catch (err) {
      // a partial overlay can leave the install inconsistent — say so clearly
      task(gameId, 'error', { message: `Update failed partway (${err.message}) — use “Verify / repair installation”, or reinstall the game.` });
      throw err;
    }
    entry.appliedUpdates = [...new Set([...(entry.appliedUpdates || []), packageId])];
    saveInstalled(installed);
    stagingDone = true;
    // the update may have replaced the exe — flag rather than launch into the void
    const audit = installer.auditInstall(entry);
    if (!audit.ok && audit.issues.some((i) => i.includes('executable'))) {
      entry.status = 'needs-exe';
      entry.exe = null;
      saveInstalled(installed);
      task(gameId, 'needs-exe', { message: 'Updated, but the launcher moved — use “Select launcher”.' });
      return entry;
    }
    task(gameId, 'done', { message: `Update applied (${applied} files).` });
    return entry;
  } finally {
    // Keep downloaded staging on failure so a retry doesn't re-fetch; wipe after success.
    fs.rmSync(workDir, { recursive: true, force: true });
    if (stagingDone) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

ipcMain.handle('game:applyUpdate', async (e, { gameId, packageId } = {}) => {
  return runJob(gameId, 'update', { gameId, packageId }, (job) => applyUpdate(gameId, packageId, job));
});

// Common in-folder save directory names. A game's saves are mirrored to a
// PERSISTENT folder that lives OUTSIDE any single version's install dir, so they
// survive version switches AND uninstalls — switch 1.0→1.1, and back to 1.0, and
// the save is still there. (Saves that games keep in Documents/AppData are already
// external and persist on their own; this covers portable / in-folder saves.)
// The saves folder is always in the client's games folder on THIS PC — never in
// the read-only source library.
const SAVE_DIR_NAMES = ['save', 'saves', 'savegame', 'savegames', 'saved', 'savedata', 'profile', 'profiles'];
function savesDirFor(baseDir, title) { return path.join(baseDir, '_gamehub_saves', title); }
// copy the install's current in-folder saves OUT to the persistent store (latest
// wins). Returns true when the saves are safe — either copied, or there were none
// to copy. Returns false only if there WERE in-folder saves but the copy failed,
// so a caller about to destroy the source install knows to abort instead.
function backupSaves(installDir, savesDir) {
  let names;
  try {
    names = fs.readdirSync(installDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SAVE_DIR_NAMES.includes(e.name.toLowerCase()))
      .map((e) => e.name);
  } catch { return false; }
  if (!names.length) return true; // nothing to preserve
  try {
    fs.mkdirSync(savesDir, { recursive: true });
    for (const name of names) fs.cpSync(path.join(installDir, name), path.join(savesDir, name), { recursive: true });
    return true;
  } catch { return false; }
}
// copy the persistent saves back INTO a freshly installed version (the player's progress wins)
function restoreSavesInto(savesDir, installDir) {
  try {
    if (!fs.existsSync(savesDir)) return;
    for (const name of fs.readdirSync(savesDir)) {
      fs.cpSync(path.join(savesDir, name), path.join(installDir, name), { recursive: true });
    }
  } catch { /* best-effort */ }
}

// Serverless play-in-place: a library folder that already holds a runnable game
// exe is registered exactly where it lives — no download, no copy. Single-file
// archives and setup-only folders return null and fall through to the normal
// extract/install flow (which lands in a separate games dir, not the library).
function registerInPlace(gameId, packageId, title, libPath, installed) {
  let st;
  try { st = fs.statSync(libPath); } catch { return null; }
  if (!st.isDirectory()) return null; // a single archive file — needs real extraction
  const ranked = installer.rankGameExes(libPath, title);
  const topExe = ranked[0];
  const runnerUp = ranked[1];
  const confident =
    topExe &&
    (topExe.score >= 45 ||
      (topExe.score >= 15 && (!runnerUp || topExe.score - runnerUp.score >= 8)) ||
      ranked.length === 1);
  if (!confident) return null; // no clear game exe (repack/setup or ambiguous) — normal flow
  installed[gameId] = { title, dir: libPath, exe: topExe.path, mode: 'portable', status: 'installed', inPlace: true, shortcuts: [], packageId };
  saveInstalled(installed);
  task(gameId, 'done', { message: 'Ready to play — launching in place, no copy.' });
  return installed[gameId];
}

// After library organization renames an install folder, the stored absolute
// dir/exe go stale — for ANY local-mode install, not just in-place ones (organize
// targets gamesDir now). Re-resolve under the entry's own install root (its
// parent dir, so picked alternate roots work too) — never under the Store.
// Every candidate folder must NAME-MATCH this game: a heal may never bind
// another game's folder or exe (the v1.4.7 launcher-picker rule).
async function healLocalEntry(gameId, entry) {
  if (config.mode !== 'local' || !entry?.dir || entry.mode === 'dlc') return entry;
  if (fs.existsSync(entry.dir)) return entry; // dir intact — exe issues go the needs-exe/Verify route
  const root = path.dirname(entry.dir);
  const store = config.storeDir || config.libraryDir;
  if (!root || (store && isInside(root, store))) return entry; // never heal into the Store

  const title = String(entry.title || '').trim();
  const seen = new Set();
  const candidates = [];
  const add = (p) => {
    const k = String(p || '').toLowerCase();
    if (p && !seen.has(k)) { seen.add(k); candidates.push(p); }
  };
  if (title) add(path.join(root, title));
  let pkg = null;
  try { pkg = await api.game(entry.packageId ?? gameId); } catch { /* offline — disk candidates still work */ }
  if (pkg?.rel_path) add(path.join(root, path.basename(pkg.rel_path)));
  // organize renames to "Title (Year)" — folderMatchesGame catches that and any
  // other same-game variant, and nothing else. (An empty title matches nothing.)
  if (title) {
    try {
      for (const name of fs.readdirSync(root)) {
        if (installer.folderMatchesGame(name, title)) add(path.join(root, name));
      }
    } catch { /* root unreadable */ }
  }

  const dirs = candidates.filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });

  // pass 1: a matching folder where the exe remaps (or re-ranks) to a real file
  for (const nextDir of dirs) {
    const resolved = resolveInPlacePaths(
      { ...entry, inPlace: true }, // shim: the resolver only remaps paths; applicability is decided here
      root,
      path.relative(root, nextDir),
      (dir, t) => installer.rankGameExes(dir, t)
    );
    if (!resolved?.dir || !resolved.exe) continue;
    entry.dir = resolved.dir;
    entry.exe = resolved.exe;
    entry.status = 'installed';
    // desktop / Start Menu shortcuts still target the old path — retarget them
    if (entry.shortcuts?.length) {
      try {
        const re = await installer.createShortcuts(entry.title, entry.exe, shortcutOpts({
          title: entry.title,
          winePrefix: entry.winePrefix,
          linuxRunner: entry.linuxRunner,
        }));
        entry.shortcuts = [...new Set([...entry.shortcuts.filter((s) => fs.existsSync(s)), ...re])];
      } catch { /* cosmetic — Verify can re-make them */ }
    }
    const installed = loadInstalled();
    installed[gameId] = entry;
    saveInstalled(installed);
    return entry;
  }

  // pass 2: no exe found anywhere — at least re-point dir at a matching folder so
  // needs-exe / Select-launcher opens in the right place (never a stranger's folder)
  if (dirs.length) {
    entry.dir = dirs[0];
    entry.exe = null;
    entry.status = 'needs-exe';
    const installed = loadInstalled();
    installed[gameId] = entry;
    saveInstalled(installed);
  }
  return entry;
}

// Fetch a package into staging: local mode = filesystem copy from Store (fast);
// remote mode = HTTP download from the Gamehub server (unchanged).
async function fetchPackageToStaging(gameId, packageId, pkg, files, stagingDir, verb = 'Downloading', job) {
  const totalBytes = files.reduce((s, f) => s + f.size, 0) || 1;
  let doneBytes = 0;
  let lastEmit = 0;
  const progress = (chunkLen, rel) => {
    doneBytes += chunkLen;
    const now = Date.now();
    if (now - lastEmit < 200) return;
    lastEmit = now;
    task(gameId, 'downloading', {
      pct: Math.min(99, Math.round((doneBytes / totalBytes) * 100)),
      message: `${verb} ${rel}`,
    });
  };

  fs.mkdirSync(stagingDir, { recursive: true });
  job?.trackStaging(stagingDir);
  job?.throwIfAborted();
  const store = config.mode === 'local' ? (config.storeDir || config.libraryDir) : null;
  if (store) {
    await copyPackageToStaging(store, pkg, files, stagingDir, progress, { signal: job?.signal });
    return;
  }
  for (const f of files) {
    job?.throwIfAborted();
    const rel = f.path || path.basename(pkg.rel_path);
    const dest = path.join(stagingDir, ...String(rel).split(/[/\\]/));
    await api.downloadFile(packageId, f.path, dest, (n) => progress(n, rel), f.size, { signal: job?.signal });
  }
}

// gameId = the logical game (group) id used for state; packageId = which library
// entry's files to download. baseDir is chosen in the renderer's install picker.
async function installGame(gameId, packageId, baseDir, job) {
  job?.throwIfAborted();
  const pkg = await api.game(packageId);
  const title = sanitizeTitle(pkg.meta_title || pkg.clean_name);
  const installed = loadInstalled();

  // Local mode: never play from the Store (seed-safe). Always copy into gamesDir.
  // If a previous install already sits under the Library, reclaim it in place.
  if (config.mode === 'local' && config.gamesDir && !installed[gameId]) {
    const candidate = path.join(config.gamesDir, title);
    if (fs.existsSync(candidate)) {
      const inPlace = registerInPlace(gameId, packageId, title, candidate, installed);
      if (inPlace) return inPlace;
    }
  }
  baseDir = baseDir || config.gamesDir; // archives/repacks extract into the Library

  // switching versions: replace the files in place, keeping saves + metadata.
  // The OLD install is only removed AFTER the new package downloads OK, so a
  // failed download never leaves you with nothing.
  const existing = installed[gameId];
  if (existing && existing.dir) baseDir = path.dirname(existing.dir);
  const savesDir = savesDirFor(baseDir, title); // persistent, outside any version's install dir

  // Staging is keyed by packageId so switching versions never resumes the wrong
  // partials. Partials are kept across retries — only wiped after a successful
  // extract (or when the user cancels).
  const stagingDir = path.join(baseDir, '_staging', `${gameId}-pkg${packageId}-${title}`);
  const installDir = path.join(baseDir, title);
  job?.trackStaging(stagingDir);
  // Do NOT track installDir as work — cancel/pause must never wipe a live install.
  // Extract rollback below handles half-built dirs explicitly.

  // 1. fetch the chosen package into staging (HTTP remote, or local Store copy)
  task(gameId, 'downloading', { pct: 0, message: 'Fetching file list…' });
  const files = await api.files(packageId);
  await fetchPackageToStaging(
    gameId,
    packageId,
    pkg,
    files,
    stagingDir,
    config.mode === 'local' ? 'Copying' : 'Downloading',
    job
  );
  job?.throwIfAborted();

  // download OK — preserve the outgoing version's saves, then move its install
  // ASIDE (renamed, not deleted) so any failure below can roll straight back to
  // the previous version instead of leaving the game with nothing installed.
  let retiredDir = null;
  let rollbackFailed = false;
  let outcome = 'running'; // success | paused | cancelled | error
  if (existing && existing.dir && fs.existsSync(existing.dir)) {
    if (!backupSaves(existing.dir, savesDir)) {
      throw new Error(
        'Couldn’t safely back up your saves before switching — nothing was changed. If the game is running, close it and try again.'
      );
    }
    if (existing.shortcuts) installer.removeShortcuts(existing.shortcuts);
    retiredDir = `${existing.dir}.old-${gameId}`;
    fs.rmSync(retiredDir, { recursive: true, force: true }); // clear any stale leftover
    fs.renameSync(existing.dir, retiredDir);
  }

  try {
    // 2. switch roms and the like: just move into place, nothing to install.
    // Land it next to the rest of the install (same volume as staging) so this
    // is a rename, never a cross-device copy — and honor the folder the user
    // picked, reusing the prior location when switching versions.
    if (pkg.payload_type === 'switch-rom') {
      const romDir = (existing && existing.dir) || path.join(baseDir, 'Switch', title);
      fs.rmSync(romDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(romDir), { recursive: true });
      fs.renameSync(stagingDir, romDir);
      installed[gameId] = { title, dir: romDir, mode: 'rom', status: 'installed', shortcuts: [], packageId };
      saveInstalled(installed);
      outcome = 'success';
      task(gameId, 'done', { message: 'Downloaded (ROM — use your emulator/console tooling).' });
      return installed[gameId];
    }

    // 3. assemble + extract (multi-part rar, zip, 7z, iso…)
    task(gameId, 'extracting', { message: 'Unpacking…' });
    // Fresh extract target — wipe leftovers from a previous paused attempt.
    if (!retiredDir && fs.existsSync(installDir) && !(existing && path.resolve(existing.dir) === path.resolve(installDir))) {
      try { fs.rmSync(installDir, { recursive: true, force: true }); } catch { /* */ }
    }
    fs.mkdirSync(installDir, { recursive: true });
    const extractedCount = await installer.extractAll(stagingDir, installDir, (m) =>
      task(gameId, 'extracting', { message: m }), job?.signal
    );
    job?.throwIfAborted();

    if (extractedCount === 0) {
      // plain folder / loose installer: move staged files into the install dir
      task(gameId, 'extracting', { message: 'Moving files into place…' });
      for (const entry of fs.readdirSync(stagingDir)) {
        fs.renameSync(path.join(stagingDir, entry), path.join(installDir, entry));
      }
    } else {
      // releases often ship loose extras next to the archives (crack dir,
      // readme, patches) — carry everything that isn't an archive volume over
      moveNonArchiveLeftovers(stagingDir, installDir);
    }
    if (config.deleteArchivesAfterExtract || extractedCount === 0) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    // 4. tidy up: releases often nest everything inside one folder
    installer.flattenSingleDir(installDir);
    // restore any persistent in-folder saves into this freshly installed version
    // (covers switching AND reinstalling after an uninstall)
    restoreSavesInto(savesDir, installDir);

    // 5. figure out what we got — decision order matters:
    //    a strong, title-matched game exe means READY TO PLAY even if some
    //    incidental setup.exe exists somewhere in the tree
    const ranked = installer.rankGameExes(installDir, title);
    const topExe = ranked[0];
    const runnerUp = ranked[1];
    const confidentExe =
      topExe &&
      (topExe.score >= 45 || // strong title match
        (topExe.score >= 15 && (!runnerUp || topExe.score - runnerUp.score >= 8)) ||
        ranked.length === 1);
    const installerExe = confidentExe ? null : installer.findInstaller(installDir);
    if (installerExe) {
      // --- Silent installer driver (v1: high-confidence Inno, fresh installs) ---
      const fp = fingerprintInstaller(installerExe);
      const libraryRoots = [config.gamesDir, ...(config.gamesDirs || [])].filter(Boolean);
      const eligibility = canAutoSilentInstall({
        fingerprint: fp,
        existingInstall: !!existing,
        isDlcOrUpdate: false,
        autoSilentPref: config.autoSilentInstall,
        targetDir: installDir,
        libraryRoots,
      });

      let tryAuto = eligibility.ok;
      if (tryAuto && eligibility.needsAsk && process.env.GAMEHUB_NO_CONFIRM !== '1') {
        const choice = await askUser({
          title: 'Setup detected',
          message: existing
            ? `“${title}” needs a setup step to switch versions`
            : `“${title}” needs a setup step`,
          detail: platform.isLinux
            ? `Gamehub can run this ${fp.engineLabel} installer automatically into your Library via Wine/Proton, or open the setup wizard.\n\nAutomatic mode skips optional extras (DirectX / VC++ redistributables, FitGirl site redirects, desktop icons). Your Store copy is never modified.`
            : `Gamehub can run this ${fp.engineLabel} installer automatically into your Library, or open the setup wizard.\n\nAutomatic mode skips optional extras (DirectX / VC++ redistributables, FitGirl site redirects, desktop icons). Windows may still ask for administrator permission once. Your Store copy is never modified.`,
          buttons: ['Install automatically', 'Use setup wizard'],
          defaultId: 0,
        });
        job?.throwIfAborted();
        config.autoSilentInstall = choice === 0;
        saveConfig(config);
        tryAuto = choice === 0;
      } else if (tryAuto && eligibility.needsAsk && process.env.GAMEHUB_NO_CONFIRM === '1') {
        // Headless/tests: honor unset pref as "try automatic"
        tryAuto = true;
      }

      if (tryAuto) {
        const payloadDir = path.join(baseDir, '_staging', `${gameId}-setup-${title}`);
        const logDir = path.join(baseDir, '_staging');
        job?.trackStaging(payloadDir);
        let silent;
        try {
          silent = await attemptSilentInstallSafe({
            setupExe: installerExe,
            installDir,
            payloadDir,
            title,
            libraryRoots,
            signal: job?.signal,
            logDir,
            onPhase: (phase, extra) => task(gameId, phase, extra || {}),
            winePrefix: winePrefixForTitle(title),
            config,
          });
        } catch (err) {
          if (isAbortError(err)) throw err;
          silent = { ok: false, reason: err.message, payloadDir, setupExe: installerExe, fingerprint: fp };
        }
        job?.throwIfAborted();

        // Cancel/pause during silent setup must NOT write needs-install — propagate
        // so runJob emits cancelled/paused and wipes staging.
        if (silent.reason === 'cancelled' || silent.reason === 'paused'
          || job?.state === 'cancelled' || job?.state === 'paused') {
          throw abortError(silent.reason === 'paused' || job?.state === 'paused' ? 'paused' : 'cancelled');
        }

        if (silent.ok) {
          const rankedSilent = silent.verified?.ranked || installer.rankGameExes(installDir, title);
          const topSilent = rankedSilent[0];
          const runnerUpSilent = rankedSilent[1];
          const confidentSilent =
            topSilent &&
            (topSilent.score >= 45
              || (topSilent.score >= 15 && (!runnerUpSilent || topSilent.score - runnerUpSilent.score >= 8))
              || rankedSilent.length === 1);

          // Drop private payload only after verification succeeded
          try { fs.rmSync(silent.payloadDir, { recursive: true, force: true }); } catch { /* */ }

          if (topSilent && confidentSilent) {
            const shortcuts = await installer.createShortcuts(title, topSilent.path, shortcutOpts({
              title,
              winePrefix: silent.winePrefix,
              linuxRunner: silent.linuxRunner || 'wine',
            }));
            installed[gameId] = {
              title, dir: installDir, mode: 'portable', status: 'installed',
              exe: topSilent.path, shortcuts, packageId,
              silentEngine: fp.engine,
              winePrefix: silent.winePrefix || winePrefixForTitle(title),
              // Silent path always uses Wine — pin play/shortcuts to the same runner.
              linuxRunner: platform.isLinux ? (silent.linuxRunner || 'wine') : undefined,
            };
            const audit = installer.auditInstall(installed[gameId]);
            if (!audit.ok && audit.issues.some((i) => i.includes('executable'))) {
              installed[gameId].status = 'needs-exe';
              installed[gameId].exe = null;
              saveInstalled(installed);
              outcome = 'success';
              task(gameId, 'needs-exe', { message: 'Installed, but the launcher looks wrong — use “Select launcher”.' });
              return installed[gameId];
            }
            installed[gameId].verified = audit.ok;
            saveInstalled(installed);
            outcome = 'success';
            task(gameId, 'done', {
              message: audit.ok ? 'Installed & verified. Ready to play.' : `Installed (${audit.issues.join('; ')}).`,
            });
            return installed[gameId];
          }

          // Installed but launcher ambiguous
          installed[gameId] = {
            title, dir: installDir, mode: 'portable', status: 'needs-exe',
            shortcuts: [], packageId, silentEngine: fp.engine,
            winePrefix: silent.winePrefix || winePrefixForTitle(title),
            linuxRunner: platform.isLinux ? (silent.linuxRunner || 'wine') : undefined,
          };
          saveInstalled(installed);
          outcome = 'success';
          task(gameId, 'needs-exe', {
            message: 'Installed automatically — confirm the launcher in “Select launcher”.',
          });
          return installed[gameId];
        }

        // Automatic setup failed — keep payload, fall through to wizard handoff
        const setupPath = silent.setupExe && fs.existsSync(silent.setupExe)
          ? silent.setupExe
          : (fs.existsSync(installerExe) ? installerExe : null);
        const keepDir = silent.payloadDir && fs.existsSync(silent.payloadDir)
          ? silent.payloadDir
          : installDir;
        const failHint = silent.reason === 'uac-cancelled'
          ? 'the Windows permission prompt was declined'
          : silent.reason === 'needs-elevation'
            ? 'Windows permission was required'
            : silent.reason === 'no-game-output'
              ? 'setup finished but no game files were found'
              : 'automatic setup couldn’t finish';
        installed[gameId] = {
          title,
          dir: keepDir,
          mode: 'installer',
          status: 'needs-install',
          installer: setupPath || path.join(keepDir, path.basename(installerExe)),
          shortcuts: [],
          packageId,
          payloadDir: silent.payloadDir || null,
          silentAttempt: { reason: silent.reason, engine: fp.engine },
        };
        saveInstalled(installed);
        outcome = 'success';
        task(gameId, 'needs-install', {
          message: `Automatic setup couldn’t finish (${failHint}). Your Store copy was untouched and the setup files were kept.`,
        });
        if (process.env.GAMEHUB_NO_CONFIRM !== '1') {
          const r = await askUser({
            title: 'Automatic setup couldn’t finish',
            message: `“${title}” — ${failHint}`,
            detail: 'Your Store copy was untouched and the setup files were kept. Open the setup wizard to continue, or try again later.',
            buttons: ['Run setup wizard', 'Later'],
            defaultId: 0,
          });
          job?.throwIfAborted();
          if (r === 0 && installed[gameId].installer) {
            await openPathSmart(installed[gameId].installer, { winePrefix: winePrefixForTitle(title) });
            installed[gameId].status = 'needs-exe';
            installed[gameId].winePrefix = winePrefixForTitle(title);
            saveInstalled(installed);
            task(gameId, 'needs-exe', { message: 'Setup wizard opened — click “Select launcher” when it finishes.' });
          }
        }
        return installed[gameId];
      }

      // Manual / unsupported engine path (unchanged wizard handoff)
      installed[gameId] = {
        title,
        dir: installDir,
        mode: 'installer',
        status: 'needs-install',
        installer: installerExe,
        shortcuts: [],
        packageId,
        silentFingerprint: { engine: fp.engine, support: fp.support },
      };
      saveInstalled(installed);
      outcome = 'success';
      const unsupported = fp.support !== 'auto'
        ? (fp.engine === 'unknown'
          ? 'This setup isn’t safely automatable yet. Open its installer to continue.'
          : `${fp.engineLabel} detected — open the setup wizard to continue.`)
        : `Installer found: ${path.basename(installerExe)}. Click "Run Installer".`;
      task(gameId, 'needs-install', { message: unsupported });
      if (process.env.GAMEHUB_NO_CONFIRM !== '1') {
        const r = await askUser({
          title: 'Ready to install',
          message: `“${title}” unpacked — installer detected`,
          detail: `${path.basename(installerExe)}\n\n${fp.support === 'auto' ? '' : 'Automatic setup isn’t available for this installer. '}Complete the setup wizard (any install location works), then click “Select launcher” in Gamehub — it finds the installed game, sets up shortcuts, and cleans up the leftover repack files.`,
          buttons: ['Run installer now', 'Later'],
        });
        job?.throwIfAborted();
        if (r === 0) {
          await openPathSmart(installerExe, { winePrefix: winePrefixForTitle(title) });
          installed[gameId].status = 'needs-exe';
          installed[gameId].winePrefix = winePrefixForTitle(title);
          saveInstalled(installed);
          task(gameId, 'needs-exe', { message: 'Installer launched — click “Select launcher” when the wizard finishes.' });
        }
      }
      return installed[gameId];
    }

    // ambiguous detection? never guess — hand the ranked candidates to the user
    if (topExe && !confidentExe) {
      installed[gameId] = { title, dir: installDir, mode: 'portable', status: 'needs-exe', shortcuts: [], packageId };
      saveInstalled(installed);
      outcome = 'success';
      task(gameId, 'needs-exe', {
        message: `Found ${ranked.length} possible executables but none is a clear winner — confirm one in “Select launcher”.`,
      });
      return installed[gameId];
    }

    const exe = topExe ? topExe.path : null;
    if (exe) {
      // Portable / already-extracted games: honor the user's Linux runner pref.
      const winePrefix = platform.isLinux ? winePrefixForTitle(title) : null;
      const linuxRunner = platform.isLinux ? (config.linuxRunner || 'wine') : undefined;
      const shortcuts = await installer.createShortcuts(title, exe, shortcutOpts({
        title, winePrefix, linuxRunner,
      }));
      installed[gameId] = {
        title, dir: installDir, mode: 'portable', status: 'installed', exe, shortcuts, packageId,
        winePrefix: winePrefix || undefined,
        linuxRunner,
      };
      // trust, but verify: exe + shortcuts must actually resolve
      const audit = installer.auditInstall(installed[gameId]);
      if (!audit.ok && audit.issues.some((i) => i.includes('executable'))) {
        installed[gameId].status = 'needs-exe';
        installed[gameId].exe = null;
        saveInstalled(installed);
        outcome = 'success';
        task(gameId, 'needs-exe', { message: `Install check failed (${audit.issues.join('; ')}) — use “Select launcher”.` });
        return installed[gameId];
      }
      installed[gameId].verified = audit.ok;
      saveInstalled(installed);
      outcome = 'success';
      task(gameId, 'done', {
        message: audit.ok ? 'Installed & verified. Ready to play.' : `Installed (${audit.issues.join('; ')}).`,
      });
      return installed[gameId];
    }

    installed[gameId] = { title, dir: installDir, mode: 'portable', status: 'needs-exe', shortcuts: [], packageId };
    saveInstalled(installed);
    outcome = 'success';
    task(gameId, 'needs-exe', {
      message: 'Unpacked, but no obvious launcher found — pick it in “Select launcher”.',
    });
    return installed[gameId];
  } catch (err) {
    if (isPausedError(err) || (job && job.state === 'paused' && isAbortError(err))) {
      // Pause during extract: restore the previous version (if any), wipe the
      // half-built install, keep staging so Resume can re-unpack.
      outcome = 'paused';
      try { fs.rmSync(installDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      if (retiredDir && existing && existing.dir) {
        try { fs.renameSync(retiredDir, existing.dir); retiredDir = null; }
        catch { /* keep retired as last resort */ }
      }
      throw err;
    }
    outcome = isCancelledError(err) || (job && job.state === 'cancelled') ? 'cancelled' : 'error';
    // a switch failed after we retired the old version — roll back: drop the
    // half-built new dir and put the previous version back exactly where it was.
    // installed[gameId] was never reassigned on a throwing path, so it still
    // points at the restored dir and the game keeps working.
    try { fs.rmSync(installDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (retiredDir && existing && existing.dir) {
      try { fs.renameSync(retiredDir, existing.dir); }
      catch { rollbackFailed = true; } // couldn't restore — keep the retired copy as a last resort
    }
    throw err;
  } finally {
    // Only drop the retired previous version once the NEW one is fully playable.
    // needs-install / needs-exe handoffs keep Title.old-* so a version switch
    // never leaves the user with only a setup wizard and no working game.
    if (retiredDir && outcome === 'success' && !rollbackFailed
      && installed[gameId]?.status === 'installed') {
      try { fs.rmSync(retiredDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

// ---------- post-install actions ----------
ipcMain.handle('game:runInstaller', async (e, gameId) => {
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry?.installer) throw new Error('No installer recorded for this game.');
  await openPathSmart(entry.installer, { winePrefix: entry.winePrefix || winePrefixForTitle(entry.title) });
  entry.status = 'needs-exe'; // after the wizard, user points us at the installed exe
  if (platform.isLinux) entry.winePrefix = entry.winePrefix || winePrefixForTitle(entry.title);
  saveInstalled(installed);
  return entry;
});

ipcMain.handle('game:pickExe', async (e, gameId) => {
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry) throw new Error('Not installed.');
  const r = await dialog.showOpenDialog(win, {
    title: 'Select the game launcher',
    defaultPath: entry.dir,
    filters: [{ name: 'Programs', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (r.canceled) return entry;
  const exe = r.filePaths[0];
  const winePrefix = entry.winePrefix || winePrefixForTitle(entry.title);
  const linuxRunner = entry.linuxRunner || (platform.isLinux ? (config.linuxRunner || 'wine') : undefined);
  const shortcuts = await installer.createShortcuts(entry.title, exe, shortcutOpts({
    title: entry.title, winePrefix, linuxRunner,
  }));
  Object.assign(entry, {
    exe, shortcuts, status: 'installed',
    winePrefix: platform.isLinux ? winePrefix : entry.winePrefix,
    linuxRunner: platform.isLinux ? linuxRunner : entry.linuxRunner,
  });
  saveInstalled(installed);
  task(gameId, 'done', { message: 'Ready to play.' });
  return entry;
});

ipcMain.handle('game:play', async (e, gameId) => {
  const installed = loadInstalled();
  let entry = installed[gameId];
  if (!entry) throw new Error('Game is not installed.');
  // local mode: if organize renamed the install folder, heal dir/exe/shortcuts first
  entry = await healLocalEntry(gameId, entry);
  if (!entry?.exe) throw new Error('No launcher set — use “Select launcher”.');
  // never launch into the void: if the exe vanished (moved/uninstalled outside
  // Gamehub), flip to needs-exe instead of silently doing nothing
  if (!fs.existsSync(entry.exe)) {
    entry.status = 'needs-exe';
    entry.exe = null;
    const cur = loadInstalled();
    cur[gameId] = entry;
    saveInstalled(cur);
    task(gameId, 'needs-exe', { message: 'Game executable is missing — select it again.' });
    throw new Error('Game executable is missing (moved or deleted?) — select it again.');
  }
  const started = Date.now();
  const launchCfg = {
    ...config,
    winePrefix: entry.winePrefix || winePrefixForTitle(entry.title),
    // Prefer the runner used at install time (silent installs pin Wine).
    linuxRunner: entry.linuxRunner || config.linuxRunner || 'wine',
  };
  let launch;
  try {
    launch = platform.launchCommand(entry.exe, launchCfg);
  } catch (err) {
    task(gameId, 'play-failed', { message: String(err?.message || err) });
    throw err;
  }

  // record "last played" up front, regardless of how it launches
  const pt = loadPlaytime();
  pt[gameId] = { ...(pt[gameId] || { seconds: 0 }), lastPlayed: new Date().toISOString() };
  savePlaytime(pt);

  // Fallback when CreateProcess can't start the exe (often ERROR_ELEVATION_REQUIRED
  // / compat "Run as administrator"). Prefer the one-time elevated helper (no UAC
  // per launch), then an unelevated explorer hand-off, then ShellExecute.
  let shellFallbackUsed = false;
  const launchViaShell = async (why) => {
    if (shellFallbackUsed) return;
    shellFallbackUsed = true;
    console.warn(`[play] spawn couldn't launch "${entry.title}" (${why}); using fallback`);
    if (platform.isLinux) {
      try {
        const child2 = platform.openWindowsExe(entry.exe, launchCfg);
        child2?.unref?.();
        api.setStatus(Number(gameId));
        setTimeout(() => { try { api.setStatus(null); } catch { /* */ } }, 90_000);
        win?.webContents.send('task:update', {
          gameId: Number(gameId),
          phase: 'shell-launched',
          message: 'Launched via Wine — playtime isn’t tracked for this fallback session.',
        });
      } catch (err) {
        task(gameId, 'play-failed', { message: `Launch failed: ${err.message}` });
      }
      return;
    }

    const elevationish = elevatedLaunch.looksLikeElevationFailure(why);

    // One-time elevated helper: UAC once at enable, then schtasks launches games
    // elevated with no prompt — overlay/playtime still attach via the returned PID.
    if (elevationish || elevatedLaunch.isRegistered()) {
      if (!elevatedLaunch.isRegistered() && config.elevatedLaunchPrompted !== true) {
        const choice = await askUser({
          title: 'Administrator games',
          message: `“${entry.title}” needs administrator permission to start.`,
          detail: 'Gamehub can set this up once (Windows will ask for approval). After that, admin-required games launch without a UAC prompt every time.\n\nGamehub itself stays normal — only game starts use the helper.',
          buttons: ['Allow once', 'Not now'],
          defaultId: 0,
        });
        config = { ...config, elevatedLaunchPrompted: true };
        saveConfig(config);
        if (choice === 0) {
          const en = await elevatedLaunch.enable();
          if (!en.ok && en.error === 'uac-cancelled') {
            task(gameId, 'play-failed', { message: 'Administrator approval was cancelled — couldn’t start the game.' });
            return;
          }
          if (!en.ok) {
            console.warn('[play] elevated helper enable failed:', en.error);
          }
        }
      }

      if (elevatedLaunch.isRegistered()) {
        const elev = await elevatedLaunch.launchElevated(entry.exe);
        if (elev.ok && elev.pid) {
          const session = beginTrackedSession({
            gameId,
            title: entry.title,
            pid: elev.pid,
            started,
            exePath: entry.exe,
          });
          session.watchAdoptedPid();
          return;
        }
        console.warn('[play] elevated helper launch failed:', elev.error);
      }
    }

    const before = await winGameProcess.pidsForExe(entry.exe).catch(() => []);
    let startedOk = await winGameProcess.launchUnelevated(entry.exe).catch(() => false);
    if (!startedOk) {
      const shellErr = await shell.openPath(entry.exe).catch((err) => String(err?.message || err));
      if (shellErr) {
        task(gameId, 'play-failed', { message: `Launch failed: ${shellErr}` });
        return;
      }
      startedOk = true;
    }

    const pid = await winGameProcess.waitForNewPid(entry.exe, before, { timeoutMs: 45_000 });
    if (!pid) {
      // Game may still be up (elevated / odd image name) — brief presence only.
      api.setStatus(Number(gameId));
      setTimeout(() => { try { api.setStatus(null); } catch { /* */ } }, 90_000);
      win?.webContents.send('task:update', {
        gameId: Number(gameId),
        phase: 'shell-launched',
        message: 'Launched — couldn’t attach playtime/overlay for this session. If Windows asked for admin every time, enable “Admin game launches” in Settings → In-game, or uncheck “Run this program as an administrator” on the .exe Compatibility tab.',
      });
      return;
    }

    const session = beginTrackedSession({
      gameId,
      title: entry.title,
      pid,
      started,
      exePath: entry.exe,
    });
    session.watchAdoptedPid();
  };

  // platform seam: on Windows this is a direct spawn; on Linux it wraps the exe
  // in wine/proton (see lib/platform.js + lib/wineRunner.js)
  let child;
  try {
    child = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd,
      env: launch.env || process.env,
      detached: true,
      stdio: 'ignore',
    });
  } catch (err) {
    await launchViaShell(err.code || err.message);
    return true;
  }

  child.once('error', (err) => { launchViaShell(err.code || err.message); });
  child.once('spawn', () => {
    const session = beginTrackedSession({
      gameId,
      title: entry.title,
      pid: child.pid,
      started,
      exePath: entry.exe,
    });
    child.once('exit', (code) => session.onChildExit(code));
  });
  child.unref();
  return true;
});

// ranked executable candidates for the Edit-entry UI
// Folders in the games dir that no installed entry owns. After an external
// setup wizard (FitGirl/DODI-style repack) runs, the actual game lands in a
// fresh folder the user picked — usually right here in the games dir — while
// entry.dir still points at the unpacked repack. Scanning orphans lets the
// launcher picker surface the real, installed exe automatically.
function orphanGameDirs(installed, excludeDir) {
  if (!config.gamesDir || !fs.existsSync(config.gamesDir)) return [];
  const norm = (p) => path.normalize(p || '').toLowerCase().replace(/[\\/]+$/, '');
  const owned = new Set(Object.values(installed).map((en) => norm(en.dir)).filter(Boolean));
  owned.add(norm(excludeDir));
  const out = [];
  try {
    for (const d of fs.readdirSync(config.gamesDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(config.gamesDir, d.name);
      if (!owned.has(norm(p))) out.push(p);
    }
  } catch { /* games dir unreadable — nothing to scan */ }
  return out;
}

ipcMain.handle('game:candidates', async (e, gameId) => {
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry) return { current: null, candidates: [] };

  // How big should the install be? The store package's size is a coarse yard-
  // stick (repacks unpack larger) — used as folder-level evidence, not a gate.
  let expected = 0;
  try { expected = (await api.game(entry.packageId ?? gameId))?.size_bytes || 0; } catch { /* offline — evidence degrades gracefully */ }

  // Rank a folder's exes, weighted by whether the FOLDER actually holds the
  // game: a checksum/readme husk sinks, the folder with the game's data rises.
  const pool = [];
  const rankDir = (dir, relBase) => {
    const ev = installer.folderEvidence(dir, expected);
    for (const c of installer.rankGameExes(dir, entry.title)) {
      let { score } = c;
      const reasons = [...c.reasons];
      if (ev.desolate) { score -= 25; reasons.push('folder holds no game data'); }
      else if (ev.sizeMatches) { score += 12; reasons.push('folder size matches the download'); }
      else if (ev.substantial) { score += 8; reasons.push('folder holds the game data'); }
      pool.push({ ...c, score, reasons, rel: path.relative(relBase, c.path) });
    }
    return ev;
  };

  // Exes in the game's OWN install dir — the normal, correct source.
  const ownEv = entry.dir && fs.existsSync(entry.dir) ? rankDir(entry.dir, entry.dir) : null;

  // Fallback for wizard/repack installs whose game landed in a NEW folder:
  // only when the own dir has no confident launcher — a desolate own dir is
  // never confident, even if a title-named stub survived in it — AND only in
  // orphan folders whose NAME matches THIS game, never other games' folders.
  const ownConfident = !!ownEv && !ownEv.desolate && pool.some((c) => c.score >= 45);
  if (!ownConfident) {
    for (const dir of orphanGameDirs(installed, entry.dir)) {
      if (!installer.folderMatchesGame(path.basename(dir), entry.title)) continue;
      rankDir(dir, config.gamesDir);
    }
  }
  pool.sort((a, b) => b.score - a.score);

  // The likely launcher plus at most two alternates that still make sense —
  // junk-scored noise is never padded in (Browse… covers the long tail).
  const top = pool.filter((c, i) => i === 0 || c.score > 0).slice(0, 3);
  return {
    current: entry.exe || null,
    dir: entry.dir,
    candidates: top.map((c) => ({
      path: c.path,
      rel: c.rel,
      size: c.size,
      score: Math.round(c.score),
      reasons: c.reasons,
      isCurrent: entry.exe === c.path,
    })),
  };
});

// The top-level folder the chosen exe lives in: for exes inside the games dir
// that's the games dir's immediate child (the wizard's install folder); for
// anything else, the exe's own folder.
function installRootFor(exePath) {
  if (config.gamesDir) {
    const rel = path.relative(config.gamesDir, exePath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.includes(path.sep)) {
      return path.join(config.gamesDir, rel.split(path.sep)[0]);
    }
  }
  return path.dirname(exePath);
}

// After a wizard install the unpacked repack (installer volumes, checksum and
// readme files) is dead weight — the game itself now lives elsewhere. Ask in
// Gamehub's own dialog and reclaim the space. Only ever deletes inside the
// client's own games dir — never a library folder.
async function offerRepackCleanup(gameId, title, repackDir) {
  let size = 0;
  for (const f of installer.walkFiles(repackDir)) {
    try { size += fs.statSync(f).size; } catch { /* racing a delete — skip */ }
  }
  const gb = size / 1024 ** 3;
  const r = await askUser({
    title: 'Clean up repack files',
    message: `“${title}” is installed — the repack files are no longer needed`,
    detail: `${repackDir}${gb >= 0.1 ? ` (${gb.toFixed(1)} GB)` : ''}\n\nThis only deletes the leftover installer archives and checksum files Gamehub downloaded — the installed game is untouched.`,
    buttons: ['Delete repack files', 'Keep them'],
  });
  if (r !== 0) return;
  try {
    fs.rmSync(repackDir, { recursive: true, force: true });
    task(gameId, 'done', { message: `Repack files removed${gb >= 0.1 ? ` — ${gb.toFixed(1)} GB freed` : ''}.` });
  } catch (err) {
    task(gameId, 'done', { message: `Could not remove repack files: ${err.message}` });
  }
}

// set/replace the play target: validates, swaps shortcuts atomically, audits
ipcMain.handle('game:setExe', async (e, { gameId, exePath }) => {
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry) throw new Error('Not installed.');
  if (!exePath || !fs.existsSync(exePath)) throw new Error('That executable does not exist.');
  if (!/\.exe$/i.test(exePath)) throw new Error('Play target must be an .exe file.');

  // Launcher chosen OUTSIDE the folder we unpacked into = a wizard installed
  // the game elsewhere (the FitGirl flow). Adopt the real install folder so
  // Open Folder / uninstall / save-backup all track the actual game, and offer
  // to clear the now-redundant repack copy.
  const norm = (p) => path.normalize(p || '').toLowerCase().replace(/[\\/]+$/, '');
  const repackDir = entry.dir;
  const relToOld = repackDir ? path.relative(repackDir, exePath) : '..';
  if (!entry.inPlace && (relToOld.startsWith('..') || path.isAbsolute(relToOld))) {
    const root = installRootFor(exePath);
    if (norm(root) !== norm(config.gamesDir)) entry.dir = root;
    const oldInGames =
      repackDir && config.gamesDir && norm(repackDir) !== norm(config.gamesDir) &&
      !path.relative(config.gamesDir, repackDir).startsWith('..') &&
      !path.isAbsolute(path.relative(config.gamesDir, repackDir));
    if (entry.mode === 'installer' && oldInGames && norm(repackDir) !== norm(entry.dir) && fs.existsSync(repackDir)) {
      // fire-and-forget: prompt appears right after the picker closes
      setTimeout(() => { offerRepackCleanup(gameId, entry.title, repackDir).catch(() => {}); }, 400);
    }
  }

  installer.removeShortcuts(entry.shortcuts || []);
  const winePrefix = entry.winePrefix || winePrefixForTitle(entry.title);
  const linuxRunner = entry.linuxRunner || (platform.isLinux ? (config.linuxRunner || 'wine') : undefined);
  const shortcuts = await installer.createShortcuts(entry.title, exePath, shortcutOpts({
    title: entry.title, winePrefix, linuxRunner,
  }));
  Object.assign(entry, {
    exe: exePath, shortcuts, status: 'installed',
    winePrefix: platform.isLinux ? winePrefix : entry.winePrefix,
    linuxRunner: platform.isLinux ? linuxRunner : entry.linuxRunner,
  });
  const audit = installer.auditInstall(entry);
  entry.verified = audit.ok;
  saveInstalled(installed);
  task(gameId, 'done', {
    message: audit.ok ? 'Play target updated & verified.' : `Updated (${audit.issues.join('; ')}).`,
  });
  return entry;
});

// re-audit an install: recreate missing shortcuts, re-detect a lost exe,
// and report exactly what state things are in
ipcMain.handle('game:verify', async (e, gameId) => {
  const installed = loadInstalled();
  let entry = installed[gameId];
  if (!entry) throw new Error('Not installed.');
  entry = await healLocalEntry(gameId, entry);
  const fixed = [];

  if (entry.exe && !fs.existsSync(entry.exe)) {
    // try to re-detect before giving up
    const redetected = entry.dir && fs.existsSync(entry.dir) ? installer.findGameExe(entry.dir, entry.title) : null;
    if (redetected) {
      entry.exe = redetected;
      fixed.push('re-detected game executable');
    } else {
      entry.status = 'needs-exe';
      entry.exe = null;
      saveInstalled(installed);
      task(gameId, 'needs-exe', { message: 'Executable missing and could not be re-detected — select it manually.' });
      return { ok: false, issues: ['game executable missing'], fixed };
    }
  }

  const audit = installer.auditInstall(entry);
  if (audit.missingShortcuts.length && entry.exe) {
    entry.shortcuts = (entry.shortcuts || []).filter((s) => fs.existsSync(s));
    const recreated = await installer.createShortcuts(entry.title, entry.exe, shortcutOpts({
      title: entry.title,
      winePrefix: entry.winePrefix,
      linuxRunner: entry.linuxRunner,
    }));
    entry.shortcuts = [...new Set([...entry.shortcuts, ...recreated])];
    fixed.push(`recreated ${recreated.length} shortcut(s)`);
  }
  const finalAudit = installer.auditInstall(entry);
  entry.verified = finalAudit.ok;
  saveInstalled(installed);
  return { ok: finalAudit.ok, issues: finalAudit.issues, fixed };
});

ipcMain.handle('game:openFolder', async (e, gameId) => {
  let entry = loadInstalled()[gameId];
  if (!entry) return true;
  entry = await healLocalEntry(gameId, entry);
  if (entry?.dir) await shell.openPath(entry.dir);
  return true;
});

ipcMain.handle('game:uninstall', async (e, gameId) => {
  if (getJob(gameId) || activeTasks.has(gameId)) {
    throw new Error('Wait for the current install to finish or cancel it first.');
  }
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry) return true;

  // DLC entry: remove exactly the files it added to the base game's folder —
  // never the folder itself (that's the base game).
  if (entry.mode === 'dlc') {
    for (const f of entry.files || []) {
      try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ }
    }
    // prune directories the removal emptied (deepest first)
    const dirs = [...new Set((entry.files || []).map((f) => path.dirname(f)))].sort((a, b) => b.length - a.length);
    for (const d of dirs) {
      try { if (d !== entry.dir && fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch { /* keep */ }
    }
    const parent = installed[entry.parentGameId];
    if (parent?.dlc) delete parent.dlc[gameId];
    delete installed[gameId];
    saveInstalled(installed);
    task(gameId, 'uninstalled', { message: 'DLC removed.' });
    return true;
  }

  installer.removeShortcuts(entry.shortcuts);

  if (entry.mode === 'installer' && entry.exe) {
    const unins = installer.findUninstaller(entry.exe);
    if (unins) await openPathSmart(unins, { winePrefix: entry.winePrefix || winePrefixForTitle(entry.title) });
  }
  // In-place serverless games ARE the user's library files — uninstall just drops
  // them from Gamehub's list; never back up into or delete from the library.
  if (!entry.inPlace) {
    // keep the game's in-folder saves in the persistent store so a later reinstall restores them
    if (entry.dir) backupSaves(entry.dir, savesDirFor(path.dirname(entry.dir), entry.title || sanitizeTitle(gameId)));
    // delete the unpacked copy (only ever inside the client's own games dir)
    if (entry.dir && config.gamesDir && entry.dir.startsWith(config.gamesDir)) {
      fs.rmSync(entry.dir, { recursive: true, force: true });
    }
  }
  // the base game's folder is gone — its merged DLC entries went with it
  for (const [k, v] of Object.entries(installed)) {
    if (v.mode === 'dlc' && String(v.parentGameId) === String(gameId)) delete installed[k];
  }
  delete installed[gameId];
  saveInstalled(installed);
  task(gameId, 'uninstalled', { message: 'Removed.' });
  return true;
});
