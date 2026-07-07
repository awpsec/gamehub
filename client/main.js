const { app, BrowserWindow, ipcMain, dialog, shell, screen, safeStorage } = require('electron');
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
const { makeApi } = require('./lib/serverApi');
const installer = require('./lib/installer');
const platform = require('./lib/platform');
const centerWindow = require('./lib/centerwindow');

let win;
let config = null;
let localServer = null; // handle from the in-process server (serverless mode)
const api = makeApi(() => config);

// Serverless mode: boot the Gamehub server in-process against a local library
// folder and point the client at it. The embedded server is a build-time copy
// of server/src (client/embedded); its better-sqlite3 is rebuilt for Electron.
// Returns true once serverUrl points at the local instance.
async function startLocalLibrary() {
  if (!config.libraryDir) return false;
  if (localServer) { await localServer.close().catch(() => {}); localServer = null; }
  const embedDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'embedded')
    : path.join(__dirname, 'embedded');
  const { startEmbeddedServer } = await import(pathToFileURL(path.join(embedDir, 'embed.js')).href);
  localServer = startEmbeddedServer({
    dataDir: path.join(app.getPath('userData'), 'localdb'),
    libraryDir: config.libraryDir,
    port: 0, // OS-assigned, loopback only
    host: '127.0.0.1',
    localMode: true,
  });
  const port = await localServer.ready;
  config.serverUrl = `http://127.0.0.1:${port}`;
  console.log(`[gamehub] local library on ${config.serverUrl} (folder: ${config.libraryDir})`);
  return true;
}
const activeTasks = new Set();
// games launched this session (detached children). Tracked so we can still bank
// their time if Gamehub is closed while a game is open — the child's own 'exit'
// never reaches a main process that has already quit.
const running = new Map(); // gameId -> { started }

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
  win?.webContents.send('task:update', { gameId, phase, ...extra });
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
    backgroundColor: '#0a0a0b',
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
  config = loadConfig();
  markGamesDir();
  if (config.mode === 'local') {
    try {
      await startLocalLibrary();
    } catch (err) {
      console.error('[gamehub] local library failed to start:', err);
      dialog.showErrorBox('Local library', `Couldn't start the local library:\n\n${err.message}\n\nOpening in server mode — check Settings.`);
      config.mode = 'remote';
    }
  }
  createWindow();
  setTimeout(() => checkForUpdates(false), 4000); // silent auto-check shortly after launch
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { if (localServer) localServer.close().catch(() => {}); });
// closing Gamehub while a game is still running would otherwise lose that
// session's time — bank whatever has accrued so far on the way out
app.on('before-quit', () => {
  const now = Date.now();
  for (const [gameId, sess] of running) bankPlaytime(gameId, Math.round((now - sess.started) / 1000));
  running.clear();
});

// ---------- config ----------
ipcMain.handle('config:get', () => {
  // never hand the raw update token to the renderer — only whether one is set
  const { updateTokenEnc, updateToken, ...safe } = config;
  return {
    ...safe,
    hasUpdateToken: !!(updateTokenEnc || updateToken),
    // sensible pre-fill for the first-run games-folder step
    suggestedGamesDir: path.join(os.homedir(), 'Games'),
    // host OS for compatibility messaging (win32 | linux | darwin)
    hostPlatform: process.platform,
  };
});
ipcMain.handle('config:set', (e, next) => {
  config = { ...config, ...next };
  saveConfig(config);
  markGamesDir();
  return config;
});

// Serverless onboarding: switch to local mode against a chosen library folder and
// boot the in-process server. After this resolves, serverUrl points at the local
// instance and the renderer can refresh as if it were a normal server.
ipcMain.handle('local:enable', async (e, { libraryDir }) => {
  if (!libraryDir) return { error: 'pick a library folder first' };
  config = { ...config, mode: 'local', libraryDir };
  saveConfig(config);
  try {
    await startLocalLibrary();
    return { ok: true, serverUrl: config.serverUrl };
  } catch (err) {
    console.error('[gamehub] local:enable failed:', err);
    return { error: err.message };
  }
});

// Refresh button → scan the library folder for newly-added games (local mode
// scans in-process; a remote admin triggers a server scan; guests just reload).
ipcMain.handle('library:rescan', () => api.rescan());

// ---------- auto-update (electron-updater ← private GitHub releases) ----------
// The repo is private, so downloads need a GitHub token. It's supplied by the
// user (Settings), stored DPAPI-encrypted via safeStorage — never shipped in the
// app — and fed to electron-updater through GH_TOKEN at check time.
autoUpdater.autoDownload = true;          // fetch in the background once found
autoUpdater.autoInstallOnAppQuit = false; // install only when the user clicks
autoUpdater.logger = { info: () => {}, warn: () => {}, error: (m) => console.error('[update]', m), debug: () => {} };

function updateToken() {
  if (config.updateTokenEnc) {
    try { return safeStorage.decryptString(Buffer.from(config.updateTokenEnc, 'base64')); }
    catch { return ''; }
  }
  return config.updateToken || process.env.GH_TOKEN || '';
}
function sendUpdate(status, extra = {}) {
  if (win && !win.isDestroyed()) win.webContents.send('update:status', { status, ...extra });
}
autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
autoUpdater.on('update-available', (info) => sendUpdate('available', { version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdate('none'));
autoUpdater.on('download-progress', (p) => sendUpdate('downloading', { percent: Math.round(p.percent || 0) }));
autoUpdater.on('update-downloaded', (info) => sendUpdate('ready', { version: info.version }));
autoUpdater.on('error', (err) => sendUpdate('error', { message: String(err?.message || err) }));

async function checkForUpdates(interactive) {
  const token = updateToken();
  if (!token) { if (interactive) sendUpdate('no-token'); return; }
  process.env.GH_TOKEN = token; // electron-updater reads this for the private repo
  if (!app.isPackaged) { if (interactive) sendUpdate('dev'); return; } // only a packaged build can self-update
  try { await autoUpdater.checkForUpdates(); }
  catch (err) { sendUpdate('error', { message: String(err?.message || err) }); }
}

ipcMain.handle('update:check', () => checkForUpdates(true));
ipcMain.handle('update:install', () => { setImmediate(() => autoUpdater.quitAndInstall()); return true; });
ipcMain.handle('update:setToken', (e, token) => {
  token = String(token || '').trim();
  if (!token) { delete config.updateTokenEnc; delete config.updateToken; saveConfig(config); return { hasToken: false }; }
  if (safeStorage.isEncryptionAvailable()) {
    config.updateTokenEnc = safeStorage.encryptString(token).toString('base64');
    delete config.updateToken;
  } else {
    config.updateToken = token; // fallback if the OS keychain is unavailable (rare)
  }
  saveConfig(config);
  checkForUpdates(false); // token just set — look right away
  return { hasToken: true };
});

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
    title: 'Select the game executable',
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
  if (activeTasks.has(gameId)) throw new Error('Already installing.');
  activeTasks.add(gameId);
  // installing implies it belongs in your library (keyed by the logical game id)
  const list = loadMyLibrary();
  if (!list.includes(gameId)) {
    list.push(gameId);
    saveMyLibrary(list);
  }
  try {
    return await installGame(gameId, packageId ?? gameId, baseDir);
  } finally {
    activeTasks.delete(gameId);
  }
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

// gameId = the logical game (group) id used for state; packageId = which library
// entry's files to download. baseDir is chosen in the renderer's install picker.
async function installGame(gameId, packageId, baseDir) {
  const pkg = await api.game(packageId);
  const title = sanitizeTitle(pkg.meta_title || pkg.clean_name);
  const installed = loadInstalled();

  // Serverless: if the game already sits unpacked-and-playable in the local
  // library, play it from there instead of copying it anywhere.
  if (config.mode === 'local' && config.libraryDir && pkg.rel_path && !installed[gameId]) {
    const inPlace = registerInPlace(gameId, packageId, title, path.join(config.libraryDir, pkg.rel_path), installed);
    if (inPlace) return inPlace;
  }
  baseDir = baseDir || config.gamesDir; // archives/repacks still extract to a separate folder

  // switching versions: replace the files in place, keeping saves + metadata.
  // The OLD install is only removed AFTER the new package downloads OK, so a
  // failed download never leaves you with nothing.
  const existing = installed[gameId];
  if (existing && existing.dir) baseDir = path.dirname(existing.dir);
  const savesDir = savesDirFor(baseDir, title); // persistent, outside any version's install dir

  const stagingDir = path.join(baseDir, '_staging', `${gameId}-${title}`);
  const installDir = path.join(baseDir, title);

  // 1. download the chosen package (to staging — old install untouched yet)
  task(gameId, 'downloading', { pct: 0, message: 'Fetching file list…' });
  const files = await api.files(packageId);
  const totalBytes = files.reduce((s, f) => s + f.size, 0) || 1;
  let doneBytes = 0;
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  let lastEmit = 0; // throttle progress IPC — chunks fire hundreds of times a second
  for (const f of files) {
    // single-file payloads (zip/nsp/iso/exe) report one file with an empty
    // relative path — its name comes from the library entry itself
    const rel = f.path || path.basename(pkg.rel_path);
    const dest = path.join(stagingDir, ...rel.split('/'));
    await api.downloadFile(packageId, f.path, dest, (chunkLen) => {
      doneBytes += chunkLen;
      const now = Date.now();
      if (now - lastEmit < 200) return; // at most ~5 progress updates/second
      lastEmit = now;
      task(gameId, 'downloading', {
        pct: Math.min(99, Math.round((doneBytes / totalBytes) * 100)),
        message: `Downloading ${rel}`,
      });
    });
  }

  // download OK — preserve the outgoing version's saves, then move its install
  // ASIDE (renamed, not deleted) so any failure below can roll straight back to
  // the previous version instead of leaving the game with nothing installed.
  let retiredDir = null;
  let rollbackFailed = false;
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
      task(gameId, 'done', { message: 'Downloaded (ROM — use your emulator/console tooling).' });
      return installed[gameId];
    }

    // 3. assemble + extract (multi-part rar, zip, 7z, iso…)
    task(gameId, 'extracting', { message: 'Unpacking…' });
    fs.mkdirSync(installDir, { recursive: true });
    const extractedCount = await installer.extractAll(stagingDir, installDir, (m) =>
      task(gameId, 'extracting', { message: m })
    );

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
      installed[gameId] = {
        title,
        dir: installDir,
        mode: 'installer',
        status: 'needs-install',
        installer: installerExe,
        shortcuts: [],
        packageId,
      };
      saveInstalled(installed);
      task(gameId, 'needs-install', {
        message: `Installer found: ${path.basename(installerExe)}. Click "Run Installer".`,
      });
      // offer to launch the installer right away
      if (process.env.GAMEHUB_NO_CONFIRM !== '1') {
        const r = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['Run installer now', 'Later'],
          defaultId: 0,
          title: 'Ready to install',
          message: `“${title}” unpacked — installer detected`,
          detail: `${path.basename(installerExe)}\n\nComplete the setup wizard, then click “Select game .exe” in Gamehub so it can create shortcuts and launch the game.`,
        });
        if (r.response === 0) {
          await shell.openPath(installerExe);
          installed[gameId].status = 'needs-exe';
          saveInstalled(installed);
          task(gameId, 'needs-exe', { message: 'Installer launched — select the game .exe when done.' });
        }
      }
      return installed[gameId];
    }

    // ambiguous detection? never guess — hand the ranked candidates to the user
    if (topExe && !confidentExe) {
      installed[gameId] = { title, dir: installDir, mode: 'portable', status: 'needs-exe', shortcuts: [], packageId };
      saveInstalled(installed);
      task(gameId, 'needs-exe', {
        message: `Found ${ranked.length} possible executables but none is a clear winner — pick one in “Edit entry”.`,
      });
      return installed[gameId];
    }

    const exe = topExe ? topExe.path : null;
    if (exe) {
      const shortcuts = await installer.createShortcuts(title, exe, {
        desktop: config.createDesktopShortcut,
        startMenu: config.createStartMenuShortcut,
      });
      installed[gameId] = { title, dir: installDir, mode: 'portable', status: 'installed', exe, shortcuts, packageId };
      // trust, but verify: exe + shortcuts must actually resolve
      const audit = installer.auditInstall(installed[gameId]);
      if (!audit.ok && audit.issues.some((i) => i.includes('executable'))) {
        installed[gameId].status = 'needs-exe';
        installed[gameId].exe = null;
        saveInstalled(installed);
        task(gameId, 'needs-exe', { message: `Install check failed (${audit.issues.join('; ')}) — select the game .exe.` });
        return installed[gameId];
      }
      installed[gameId].verified = audit.ok;
      saveInstalled(installed);
      task(gameId, 'done', {
        message: audit.ok ? 'Installed & verified. Ready to play.' : `Installed (${audit.issues.join('; ')}).`,
      });
      return installed[gameId];
    }

    installed[gameId] = { title, dir: installDir, mode: 'portable', status: 'needs-exe', shortcuts: [], packageId };
    saveInstalled(installed);
    task(gameId, 'needs-exe', {
      message: 'Unpacked, but no obvious game .exe found — pick it manually.',
    });
    return installed[gameId];
  } catch (err) {
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
    // success: the retired old install is now obsolete → remove it. rollback:
    // it was already renamed back (so this no-ops), UNLESS the restore itself
    // failed, in which case it holds the only copy and must be kept.
    if (retiredDir && !rollbackFailed) {
      try { fs.rmSync(retiredDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

// ---------- post-install actions ----------
ipcMain.handle('game:runInstaller', async (e, gameId) => {
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry?.installer) throw new Error('No installer recorded for this game.');
  await shell.openPath(entry.installer);
  entry.status = 'needs-exe'; // after the wizard, user points us at the installed exe
  saveInstalled(installed);
  return entry;
});

ipcMain.handle('game:pickExe', async (e, gameId) => {
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry) throw new Error('Not installed.');
  const r = await dialog.showOpenDialog(win, {
    title: 'Select the game executable',
    defaultPath: entry.dir,
    filters: [{ name: 'Programs', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (r.canceled) return entry;
  const exe = r.filePaths[0];
  const shortcuts = await installer.createShortcuts(entry.title, exe, {
    desktop: config.createDesktopShortcut,
    startMenu: config.createStartMenuShortcut,
  });
  Object.assign(entry, { exe, shortcuts, status: 'installed' });
  saveInstalled(installed);
  task(gameId, 'done', { message: 'Ready to play.' });
  return entry;
});

ipcMain.handle('game:play', async (e, gameId) => {
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry?.exe) throw new Error('No executable set — use “Select game .exe”.');
  // never launch into the void: if the exe vanished (moved/uninstalled outside
  // Gamehub), flip to needs-exe instead of silently doing nothing
  if (!fs.existsSync(entry.exe)) {
    entry.status = 'needs-exe';
    entry.exe = null;
    saveInstalled(installed);
    task(gameId, 'needs-exe', { message: 'Game executable is missing — select it again.' });
    throw new Error('Game executable is missing (moved or deleted?) — select it again.');
  }
  const started = Date.now();
  // platform seam: on Windows this is a direct spawn; on Linux it wraps the
  // exe in wine/proton (groundwork — see lib/platform.js TODO(linux) notes)
  const launch = platform.launchCommand(entry.exe, config);
  const child = spawn(launch.cmd, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: 'ignore',
  });
  // QoL: some games open windowed in an awkward spot — best-effort re-center
  // (Windows only; skips fullscreen/maximized; never steals focus)
  if (config.centerGameWindow !== false) centerWindow.centerGameWindow(child.pid);
  task(gameId, 'playing'); // renderer shows the "In game" button until exit
  running.set(gameId, { started }); // so before-quit can bank the time if we close first
  // live "now playing" presence for the social tab — refresh every 60s (server
  // TTL 2.5min) until the game exits, so a crash still clears it on its own
  api.setStatus(Number(gameId));
  const heartbeat = setInterval(() => api.setStatus(Number(gameId)), 60000);
  const clearPresence = () => { clearInterval(heartbeat); api.setStatus(null); };
  // playtime: measured while Gamehub stays open (survives if we close first)
  child.on('exit', (code) => {
    clearPresence();
    running.delete(gameId);
    const seconds = Math.round((Date.now() - started) / 1000);
    // "hit play and nothing happens" guard: an immediate non-zero exit means
    // the game never really started — tell the user WHY nothing appeared
    if (seconds < 10 && code !== 0 && code !== null) {
      task(gameId, 'play-failed', {
        message: `“${entry.title}” exited immediately (code ${code}). It may need dependencies (VC++ / DirectX — check the game folder for a _CommonRedist or similar), or the wrong .exe is mapped — use “Edit entry” to pick another.`,
      });
      return;
    }
    bankPlaytime(gameId, seconds); // local total + server report for profiles/leaderboard
    win?.webContents.send('task:update', { gameId: Number(gameId), phase: 'playtime' });
  });
  child.on('error', (err) => {
    clearPresence();
    running.delete(gameId);
    task(gameId, 'play-failed', { message: `Launch failed: ${err.message}` });
  });
  child.unref();
  const pt = loadPlaytime();
  pt[gameId] = { ...(pt[gameId] || { seconds: 0 }), lastPlayed: new Date().toISOString() };
  savePlaytime(pt);
  return true;
});

// ranked executable candidates for the Edit-entry UI
ipcMain.handle('game:candidates', async (e, gameId) => {
  const entry = loadInstalled()[gameId];
  if (!entry?.dir || !fs.existsSync(entry.dir)) return { current: entry?.exe || null, candidates: [] };
  const ranked = installer.rankGameExes(entry.dir, entry.title);
  return {
    current: entry.exe || null,
    dir: entry.dir,
    candidates: ranked.slice(0, 10).map((c) => ({
      path: c.path,
      rel: path.relative(entry.dir, c.path),
      size: c.size,
      score: Math.round(c.score),
      reasons: c.reasons,
      isCurrent: entry.exe === c.path,
    })),
  };
});

// set/replace the play target: validates, swaps shortcuts atomically, audits
ipcMain.handle('game:setExe', async (e, { gameId, exePath }) => {
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry) throw new Error('Not installed.');
  if (!exePath || !fs.existsSync(exePath)) throw new Error('That executable does not exist.');
  if (!/\.exe$/i.test(exePath)) throw new Error('Play target must be an .exe file.');

  installer.removeShortcuts(entry.shortcuts || []);
  const shortcuts = await installer.createShortcuts(entry.title, exePath, {
    desktop: config.createDesktopShortcut,
    startMenu: config.createStartMenuShortcut,
  });
  Object.assign(entry, { exe: exePath, shortcuts, status: 'installed' });
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
  const entry = installed[gameId];
  if (!entry) throw new Error('Not installed.');
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
    const recreated = await installer.createShortcuts(entry.title, entry.exe, {
      desktop: config.createDesktopShortcut,
      startMenu: config.createStartMenuShortcut,
    });
    entry.shortcuts = [...new Set([...entry.shortcuts, ...recreated])];
    fixed.push(`recreated ${recreated.length} shortcut(s)`);
  }
  const finalAudit = installer.auditInstall(entry);
  entry.verified = finalAudit.ok;
  saveInstalled(installed);
  return { ok: finalAudit.ok, issues: finalAudit.issues, fixed };
});

ipcMain.handle('game:openFolder', async (e, gameId) => {
  const entry = loadInstalled()[gameId];
  if (entry?.dir) await shell.openPath(entry.dir);
  return true;
});

ipcMain.handle('game:uninstall', async (e, gameId) => {
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry) return true;

  installer.removeShortcuts(entry.shortcuts);

  if (entry.mode === 'installer' && entry.exe) {
    const unins = installer.findUninstaller(entry.exe);
    if (unins) await shell.openPath(unins); // let the real uninstaller do its thing
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
  delete installed[gameId];
  saveInstalled(installed);
  task(gameId, 'uninstalled', { message: 'Removed.' });
  return true;
});
