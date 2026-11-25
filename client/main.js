const { app, BrowserWindow, ipcMain, dialog, shell, screen, nativeTheme } = require('electron');
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
  runGuardedInstaller, runSilentInno,
} = require('./lib/silentInstall');
const uninstallReg = require('./lib/uninstallRegistry');
const gameOverlay = require('./lib/gameOverlay');
const shots = require('./lib/screenshots');
const linuxDesktop = require('./lib/linuxDesktop');
const winGameProcess = require('./lib/winGameProcess');
const elevatedLaunch = require('./lib/elevatedLaunch');
const appLifecycle = require('./lib/appLifecycle');
const sceneRelease = require('./lib/sceneRelease');
const libraryRoot = require('./lib/libraryRoot');
const consolePlatforms = require('./lib/platforms');
const emulators = require('./lib/emulators');

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
function beginTrackedSession({ gameId, title, pid, started, exePath = null, elevated = false }) {
  const gid = Number(gameId);
  const prev = running.get(gid);
  try { prev?.stopWatch?.(); } catch { /* */ }

  if (platform.isWindows && config.centerGameWindow !== false && pid) {
    centerWindow.centerGameWindow(pid);
  }
  task(gid, 'playing');
  gameOverlay.gameStarted({ gameId: gid, title, pid, started, elevated: !!elevated });
  api.setStatus(gid);
  const heartbeat = setInterval(() => api.setStatus(gid), 60000);

  const endSession = (seconds, { immediateFailCode = null } = {}) => {
    clearInterval(heartbeat);
    api.setStatus(null);
    running.delete(gid);
    gameOverlay.gameEnded(gid);
    if (seconds < 10 && immediateFailCode != null && immediateFailCode !== 0) {
      // Unfinished repack / setup still present: flip to Run Installer.
      try {
        const cur = loadInstalled();
        const ent = cur[gid];
        if (ent?.dir && fs.existsSync(ent.dir) && installer.isInstallerPrimary(ent.dir, ent.title || title)) {
          const setup = installer.findInstaller(ent.dir);
          if (setup) {
            cur[gid] = {
              ...ent,
              status: 'needs-install',
              mode: 'installer',
              installer: setup,
              exe: null,
            };
            saveInstalled(cur);
            task(gid, 'needs-install', {
              message: `“${title}” still needs its setup — click Run Installer.`,
            });
            return;
          }
        }
      } catch { /* best-effort demote */ }
      // crack files that antivirus removed, or Windows' own "DLL not found"
      let why = null;
      try {
        const ent = loadInstalled()[gid];
        const gone = ent?.crack?.files?.length && ent.dir ? sceneRelease.missingCrackFiles(ent.dir, ent.crack.files) : [];
        if (gone.length) why = `“${title}” couldn’t start: ${crackMissingText(gone)}`;
        else if (DLL_NOT_FOUND_CODES.has(Number(immediateFailCode))) {
          why = `“${title}” couldn’t start — Windows reported a missing DLL next to the game’s .exe. If it’s a crack file (e.g. rune64.dll, steam_api64.dll), antivirus probably removed it: Windows Security → Protection history → Allow on device, then Options → Verify / repair. Otherwise install the game’s _CommonRedist (VC++ / DirectX).`;
        } else if (BAD_IMAGE_CODES.has(Number(immediateFailCode))) {
          why = `“${title}” couldn’t start — a DLL in the game folder doesn’t match the game (32/64-bit or damaged). Options → Verify / repair, or reinstall the game.`;
        }
      } catch { /* fall back to the generic hint */ }
      task(gid, 'play-failed', {
        message: why || `“${title}” exited immediately (code ${immediateFailCode}). It may need dependencies (VC++ / DirectX — check the game folder for a _CommonRedist or similar), or the wrong .exe is mapped — use “Select launcher” to pick another.`,
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
      elevated: !!elevated,
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
        onPidChange: (nextPid) => {
          try { gameOverlay.updateSessionPid?.(gid, nextPid); } catch { /* */ }
        },
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
    /\.[r-z]\d{2}$/.test(l) || // scene RAR: .r00–.r99, then .s00, .t00 …
    /\.(7z|zip|rar)\.\d{2,3}$/.test(l) ||
    /\.\d{3}$/.test(l)
  );
}

// Scene releases carry the group's crack in a folder (RUNE/, CODEX/, Crack/ …)
// that people copy over the installed game by hand. Do that step for them.
// crackRoots: folders that may hold crack folders (the release payload);
// targetDir: the installed game. Returns a summary, or null when there was
// nothing to apply (or the user turned it off in Settings).
async function applyReleaseCracks(gameId, crackRoots, targetDir, gameExe = null) {
  if (config.applyReleaseCrack === false || !targetDir || !fs.existsSync(targetDir)) return null;
  const dirs = [...new Set(crackRoots.filter(Boolean).flatMap((r) => sceneRelease.findCrackDirs(r)))];
  if (!dirs.length) return null;
  const summary = { dirs: dirs.map((d) => path.basename(d)), replaced: 0, added: 0, files: [], missing: [], at: Date.now() };
  for (const d of dirs) {
    task(gameId, 'verifying', { message: `Applying ${path.basename(d)} files…` });
    const r = sceneRelease.applyCrack(d, targetDir, { gameExe });
    summary.replaced += r.replaced.length;
    summary.added += r.added.length;
    summary.files.push(...r.replaced, ...r.added);
    sceneRelease.keepCrack(d, targetDir); // for "Verify / repair" later
    logUpdate('info', `crack ${path.basename(d)} → ${targetDir}: ${r.replaced.length} replaced, ${r.added.length} added, ${r.skipped.length} skipped`);
  }
  // Antivirus quarantines crack loaders (rune64.dll, steam_api64.dll …) a moment
  // after they're written — look again before calling the game ready.
  await new Promise((r) => setTimeout(r, 2500));
  summary.missing = sceneRelease.missingCrackFiles(targetDir, summary.files);
  if (summary.missing.length) logUpdate('warn', `crack files gone right after copying (antivirus?): ${summary.missing.join(', ')}`);
  return summary;
}

// The release's own notes (.nfo / readme) — the group's install instructions.
// Setup payloads are deleted after a silent install, so keep a copy with the
// game (<game>\_gamehub\release-notes) for Options → Release notes.
const NOTE_RE = /(\.(nfo|diz)|(^|[\\/])(read[ _-]?me|install|instructions|info)[^\\/]*\.(txt|md))$/i;
function keepReleaseNotes(srcDirs, gameDir) {
  if (!gameDir || !fs.existsSync(gameDir)) return [];
  const dest = path.join(gameDir, '_gamehub', 'release-notes');
  const kept = [];
  for (const src of srcDirs.filter((d) => d && fs.existsSync(d))) {
    const stack = [[src, 0]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < 2 && e.name !== '_gamehub') stack.push([p, depth + 1]); continue; }
        if (!NOTE_RE.test(e.name)) continue;
        try {
          if (fs.statSync(p).size > 512 * 1024) continue;
          fs.mkdirSync(dest, { recursive: true });
          const out = path.join(dest, e.name);
          if (path.resolve(out) !== path.resolve(p)) fs.copyFileSync(p, out);
          kept.push(e.name);
        } catch { /* best-effort */ }
      }
    }
  }
  return [...new Set(kept)];
}

// .nfo files are DOS code page 437 (box-drawing art)
const CP437_HI = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function decodeNote(buf, name) {
  if (/\.(nfo|diz)$/i.test(name)) {
    let out = '';
    for (const b of buf) out += b < 128 ? String.fromCharCode(b) : CP437_HI[b - 128];
    return out;
  }
  return buf.toString('utf8');
}

ipcMain.handle('game:releaseNotes', async (e, gameId) => {
  const entry = loadInstalled()[gameId];
  if (!entry?.dir) return [];
  const dirs = [path.join(entry.dir, '_gamehub', 'release-notes'), entry.dir];
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d).filter((n) => NOTE_RE.test(n)); } catch { continue; }
    for (const n of names) {
      if (seen.has(n.toLowerCase())) continue;
      seen.add(n.toLowerCase());
      try { out.push({ name: n, text: decodeNote(fs.readFileSync(path.join(d, n)), n).replace(/\r\n/g, '\n') }); } catch { /* */ }
    }
  }
  return out;
});

// Steam-style launch options: extra arguments for the game exe
function parseLaunchArgs(str) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || '')))) out.push(m[1] ?? m[2]);
  return out;
}
ipcMain.handle('game:setLaunchArgs', async (e, { gameId, args }) => {
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry) throw new Error('Not installed.');
  const v = String(args || '').trim();
  if (v) entry.launchArgs = v; else delete entry.launchArgs;
  saveInstalled(installed);
  return entry;
});

// What to tell the user when crack files went missing (almost always
// Windows Security quarantining them).
function crackMissingText(files) {
  const names = [...new Set(files.map((f) => path.basename(f)))];
  const list = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
  return `Windows Security (or another antivirus) removed ${list} — the game can’t start without ${names.length > 1 ? 'them' : 'it'}. `
    + 'Open Windows Security → Virus & threat protection → Protection history, choose the item → Actions → Allow on device (it’s restored), then use Options → Verify / repair.';
}
// Windows loader failures that mean "a DLL the exe needs isn't there / doesn't fit"
const DLL_NOT_FOUND_CODES = new Set([-1073741515, 3221225781]); // 0xC0000135
const BAD_IMAGE_CODES = new Set([-1073741701, 3221225595]);     // 0xC000007B
function crackSourceFor(...dirs) {
  return dirs.filter(Boolean).filter((d) => sceneRelease.findCrackDirs(d).length);
}

// "setup.exe" that is really a 7z/RAR/ZIP/CAB self-extractor: unpack it like
// any archive (no wizard, nothing to click) — twice, for SFX-in-SFX.
async function unwrapSfxInstallers(gameId, dir, job) {
  for (let i = 0; i < 2; i++) {
    const probe = installer.findInstaller(dir);
    if (!probe || !/\.exe$/i.test(probe)) return;
    if (fingerprintInstaller(probe).automatable) return; // a real Inno/NSIS/… setup
    const type = await installer.unwrapSelfExtractor(probe, path.dirname(probe), {
      onLine: (m) => task(gameId, 'extracting', { message: m }),
      signal: job?.signal,
    }).catch((err) => { if (isAbortError(err)) throw err; return null; });
    if (!type) return;
    installer.flattenSingleDir(dir);
  }
}

// Every file under dir with size + mtime — to see what a DLC/update setup added.
function fileIndex(dir) {
  const out = new Map();
  for (const f of installer.walkFiles ? installer.walkFiles(dir) : []) {
    try { const st = fs.statSync(f); out.set(f, `${st.size}:${st.mtimeMs}`); } catch { /* */ }
  }
  return out;
}

/**
 * DLC / update packages that ship their own setup: run it SILENTLY, aimed at
 * the base game's folder (Inno /DIR=, NSIS /D=, …) instead of opening a wizard
 * the user has to point at the right place. Returns { ok, added, changed, fp }
 * or { ok:false, reason } when the setup can't be automated (→ wizard).
 */
async function runSetupIntoGame(gameId, setupExe, targetDir, { job = null, winePrefix = null } = {}) {
  const fp = fingerprintInstaller(setupExe);
  const elig = canAutoSilentInstall({ fingerprint: fp, autoSilentPref: config.autoSilentInstall });
  if (!elig.ok) return { ok: false, reason: elig.reason, fp };
  const before = fileIndex(targetDir);
  task(gameId, 'installing-auto', { message: `Installing automatically — ${fp.engineLabel}` });
  const run = await runSilentInno(setupExe, targetDir, {
    engine: fp.engine,
    requiresAdmin: !!fp.requiresAdmin,
    logPath: path.join(path.dirname(setupExe), `_gamehub-${fp.engine}.log`),
    signal: job?.signal,
    winePrefix,
    config,
    onElevate: () => task(gameId, 'installing-auto', { message: 'Waiting for administrator permission…' }),
  });
  if (!run.ok) return { ok: false, reason: run.error || 'installer-failed', fp, run };
  const after = fileIndex(targetDir);
  const added = [...after.keys()].filter((f) => !before.has(f));
  const changed = [...after.keys()].filter((f) => before.has(f) && before.get(f) !== after.get(f));
  logUpdate('info', `setup ${path.basename(setupExe)} → ${targetDir}: ${added.length} added, ${changed.length} changed`);
  return { ok: true, added, changed, fp };
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
    const mapped = mapAuthError(err);
    task(gameId, 'error', { message: mapped.message || 'Install failed' });
    endJob(gameId, { keepIfPaused: false });
    throw mapped;
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
    backgroundColor: windowBg(),
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

// One Gamehub at a time. A second launch (double-clicked shortcut, game
// shortcut, …) just brings the existing window forward. Two copies fought over
// config/installed.json and kept the updater from closing Gamehub.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });
}

/** Hand off to a relaunched copy: it must be able to take the lock. */
function releaseInstanceLock() {
  try { app.releaseSingleInstanceLock(); } catch { /* */ }
}

let updateLog = null;
function logUpdate(level, ...parts) {
  if (!updateLog) {
    try { updateLog = appLifecycle.makeLogger(path.join(app.getPath('userData'), 'logs')); } catch { return; }
  }
  updateLog.write(level, ...parts);
}

if (gotSingleInstanceLock) app.whenReady().then(async () => {
  // If a prior silent install crashed while system-muted, undo that first.
  try { restoreInstallerAudioIfNeeded(); } catch { /* */ }
  config = loadConfig();
  applyTheme(config.theme);
  // Repo is public — drop any leftover private-update tokens from older builds.
  if (config.updateTokenEnc || config.updateToken) {
    delete config.updateTokenEnc;
    delete config.updateToken;
    saveConfig(config);
  }

  // Preference: always run elevated. Relaunch via pre-approved task (no UAC)
  // before the window appears — avoids a flash of unelevated UI.
  if (
    platform.isWindows
    && config.runGamehubElevated
    && !elevatedLaunch.isProcessElevated()
    && elevatedLaunch.isAppTaskRegistered()
  ) {
    releaseInstanceLock();
    const r = elevatedLaunch.restartElevatedApp();
    if (r.ok) {
      app.quit();
      return;
    }
    app.requestSingleInstanceLock();
    console.warn('[gamehub] could not auto-restart elevated:', r.error);
  }

  // Record version changes — the first thing to check when "the update didn't
  // take": did a new build ever start?
  const ver = app.getVersion();
  if (config.lastRunVersion !== ver) {
    logUpdate('info', `started v${ver}${config.lastRunVersion ? ` (previously v${config.lastRunVersion})` : ''}`,
      platform.isWindows ? `elevated=${elevatedLaunch.isProcessElevated()}` : '');
    config = { ...config, lastRunVersion: ver };
    saveConfig(config);
  }
  // The Windows installer asks a running Gamehub to quit before it checks for
  // one (build/installer.nsh) — needed when Gamehub runs as administrator and
  // the per-user installer can't close it.
  appLifecycle.watchQuitRequest(app.getPath('userData'), () => {
    logUpdate('info', 'installer asked Gamehub to quit');
    app.quit();
  });

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
    // Windows: C:\Program Files (x86)\Gamehub\games — where Steam users expect games
    suggestedGamesDir: libraryRoot.defaultGamesDir(),
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
// Appearance: 'system' follows Windows' app mode; light/dark pin it. The
// renderer's CSS follows prefers-color-scheme, which nativeTheme drives.
const THEMES = new Set(['system', 'light', 'dark']);
function windowBg() { return nativeTheme.shouldUseDarkColors ? '#232323' : '#F7F7F5'; }
function applyTheme(theme) {
  nativeTheme.themeSource = THEMES.has(theme) ? theme : 'system';
  if (win && !win.isDestroyed()) win.setBackgroundColor(windowBg());
}
nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setBackgroundColor(windowBg()); });
ipcMain.handle('theme:set', (e, theme) => {
  const t = THEMES.has(theme) ? theme : 'system';
  config = { ...config, theme: t };
  saveConfig(config);
  applyTheme(t);
  return t;
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
  const r = await elevatedLaunch.disable();
  if (r.ok && config.runGamehubElevated) {
    // Helper gone — don't leave preference/shortcuts claiming elevated starts.
    config = { ...config, runGamehubElevated: false };
    saveConfig(config);
  }
  return r;
});
ipcMain.handle('elevatedLaunch:restart', async () => {
  if (!platform.isWindows) return { ok: false, error: 'unsupported' };
  if (elevatedLaunch.isProcessElevated()) return { ok: true, already: true };
  if (!elevatedLaunch.isAppTaskRegistered()) {
    const en = await elevatedLaunch.enable();
    if (!en.ok) return en;
  }
  releaseInstanceLock();
  const r = elevatedLaunch.restartElevatedApp();
  if (r.ok) setTimeout(() => { try { app.quit(); } catch { /* */ } }, 500);
  else app.requestSingleInstanceLock();
  return r;
});
ipcMain.handle('elevatedLaunch:restartUnelevated', async () => {
  if (!platform.isWindows) return { ok: false, error: 'unsupported' };
  if (!elevatedLaunch.isProcessElevated()) return { ok: true, already: true };
  releaseInstanceLock();
  const r = elevatedLaunch.restartUnelevatedApp();
  if (r.ok) setTimeout(() => { try { app.quit(); } catch { /* */ } }, 500);
  else app.requestSingleInstanceLock();
  return r;
});
ipcMain.handle('linuxDesktop:status', () => linuxDesktop.status());
ipcMain.handle('linuxDesktop:install', () => linuxDesktop.installUserDesktopEntry());
ipcMain.handle('linuxDesktop:remove', () => linuxDesktop.removeUserDesktopEntry());

ipcMain.handle('config:set', async (e, next) => {
  const prevRunElev = !!config.runGamehubElevated;
  const patch = { ...next };
  // Don't let callers persist ephemeral keys.
  delete patch.restartRequired;
  delete patch.error;

  config = { ...config, ...patch };
  if (typeof config.serverUrl === 'string') {
    config.serverUrl = normalizeServerUrl(config.serverUrl);
  }

  let restartRequired = null;
  let elevateError = null;
  if (
    platform.isWindows
    && Object.prototype.hasOwnProperty.call(next || {}, 'runGamehubElevated')
    && !!next.runGamehubElevated !== prevRunElev
  ) {
    if (next.runGamehubElevated) {
      const en = await elevatedLaunch.enable();
      if (!en.ok) {
        config.runGamehubElevated = false;
        elevateError = en.error || 'enable-failed';
      } else {
        config.elevatedLaunchPrompted = true;
        await elevatedLaunch.syncAppShortcuts({ elevated: true });
        if (!elevatedLaunch.isProcessElevated()) restartRequired = 'elevated';
      }
    } else {
      await elevatedLaunch.syncAppShortcuts({ elevated: false });
      if (elevatedLaunch.isProcessElevated()) restartRequired = 'unelevated';
    }
  }

  saveConfig(config);
  markGamesDir();
  gameOverlay.configChanged(); // pick up hotkey changes mid-game
  const { updateTokenEnc, updateToken, ...safe } = config;
  return { ...safe, restartRequired, error: elevateError };
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
// Written to %APPDATA%\Gamehub\logs\updater.log (Linux: ~/.config/Gamehub/logs)
// so a failed update leaves a trace someone can read.
autoUpdater.logger = {
  info: (m) => { console.log('[update]', m); logUpdate('info', m); },
  warn: (m) => { console.warn('[update]', m); logUpdate('warn', m); },
  error: (m) => { console.error('[update]', m); logUpdate('error', m); },
  debug: () => {},
};

let lastUpdateStatus = { status: 'idle' }; // replayed to the renderer after load
let lastUpdateCheckAt = 0;
let updateCheckInFlight = false;
let suppressUpdateError = false;

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
/** Missing latest.yml mid-publish (or draft not ready) — treat as up-to-date, not a scary error. */
function isTransientUpdateMetaError(err) {
  const msg = String(err?.message || err || '');
  return /cannot find latest\.yml|cannot find latest-linux\.yml|latest\.yml.*404|HttpError:\s*404/i.test(msg);
}
function formatUpdateError(err) {
  const msg = String(err?.message || err || 'Update check failed');
  if (isTransientUpdateMetaError(err)) return null; // caller maps to "up to date"
  // Drop electron-updater's auth-token boilerplate (public repo; 404 ≠ bad token).
  const cleaned = msg
    .replace(/\s*Please double check that your authentication token is correct\.[^\n]*/gi, '')
    .replace(/\s*RequestOptions:\s*[\s\S]*$/i, '')
    .replace(/\s*Headers:\s*[\s\S]*$/i, '')
    .trim();
  // Keep the status line short — no stack dumps in Settings.
  const first = cleaned.split(/\n/)[0].trim();
  return first.length > 160 ? `${first.slice(0, 157)}…` : (first || 'Update check failed');
}
autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
autoUpdater.on('update-available', (info) => sendUpdate('available', { version: info.version }));
autoUpdater.on('update-not-available', (info) => sendUpdate('none', { version: info?.version }));
autoUpdater.on('download-progress', (p) => sendUpdate('downloading', {
  version: lastUpdateStatus.version,
  percent: Math.round(p.percent || 0),
}));
autoUpdater.on('update-downloaded', (info) => sendUpdate('ready', { version: info.version }));
autoUpdater.on('error', (err) => {
  if (suppressUpdateError) return;
  if (isTransientUpdateMetaError(err)) {
    sendUpdate('none', { version: app.getVersion() });
    return;
  }
  sendUpdate('error', { message: formatUpdateError(err) });
});

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
  suppressUpdateError = true;
  const maxAttempts = interactive ? 3 : 2;
  let lastErr = null;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
        lastErr = err;
        if (!isTransientUpdateMetaError(err) || attempt === maxAttempts) break;
        sendUpdate('checking');
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (isTransientUpdateMetaError(lastErr)) {
      // Release still publishing or metadata race — not worth alarming the user.
      sendUpdate('none', { version: app.getVersion() });
      return null;
    }
    if (lastErr) sendUpdate('error', { message: formatUpdateError(lastErr) });
    return null;
  } finally {
    suppressUpdateError = false;
    updateCheckInFlight = false;
  }
}

ipcMain.handle('update:check', () => checkForUpdates(true));
ipcMain.handle('update:status', () => lastUpdateStatus);
ipcMain.handle('update:install', () => {
  logUpdate('info', `install requested: v${app.getVersion()} → v${lastUpdateStatus.version || '?'}`,
    platform.isWindows ? `elevated=${elevatedLaunch.isProcessElevated()}` : '');
  // Not silent: the one-click installer shows its progress bar, and any problem
  // is a visible dialog rather than a quiet no-op. Always reopen Gamehub after.
  setImmediate(() => {
    try { autoUpdater.quitAndInstall(false, true); } catch (err) { logUpdate('error', 'quitAndInstall failed:', err); sendUpdate('error', { message: formatUpdateError(err) }); }
  });
  return true;
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
    title: 'Select the game launcher',
    defaultPath: defaultPath || config.gamesDir,
    filters: [{ name: 'Programs', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- library ----------
/** Sweep saved installs: promote finished wizards; demote false Play only. */
function reconcileInstallerPrimary(installed) {
  let changed = false;
  const cleanups = [];
  for (const [id, entry] of Object.entries(installed || {})) {
    const promoted = tryPromoteAfterWizard(entry, installed);
    if (promoted.changed) {
      installed[id] = promoted.entry;
      changed = true;
      if (promoted.repackDir) cleanups.push({ id, title: promoted.entry.title, repackDir: promoted.repackDir });
      continue;
    }
    const demoted = demoteInstallerPrimary(installed[id]);
    if (demoted.changed) {
      installed[id] = demoted.entry;
      changed = true;
    }
  }
  if (changed) saveInstalled(installed);
  // Offer repack cleanup after auto-adopt (same as manual Select launcher).
  for (const c of cleanups) {
    const oldInGames =
      c.repackDir && config.gamesDir &&
      !path.relative(config.gamesDir, c.repackDir).startsWith('..') &&
      !path.isAbsolute(path.relative(config.gamesDir, c.repackDir));
    if (oldInGames && fs.existsSync(c.repackDir)) {
      setTimeout(() => { offerRepackCleanup(c.id, c.title, c.repackDir).catch(() => {}); }, 600);
    }
  }
  return installed;
}

ipcMain.handle('library:get', async () => {
  const [status, games] = await Promise.all([api.status(), api.library()]);
  return {
    status,
    games,
    installed: reconcileInstallerPrimary(loadInstalled()),
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

/** Drop a dead session token but keep username for the sign-in form prefill. */
function clearStaleAuth() {
  if (!config.authToken) return false;
  config = { ...config, authToken: '' };
  saveConfig(config);
  cachedAvatar = null;
  avatarFetchedAt = 0;
  return true;
}

/**
 * Confirm the saved token still works on the server. Browse works as a guest,
 * so a stale token looks "signed in" in the UI until Install/download hits 401.
 */
async function validateAuthSession() {
  if (config.mode === 'local') return { ok: true, local: true };
  if (config.apiKey && !config.authToken) return { ok: true, apiKey: true };
  if (!config.authToken) return { ok: false, guest: true, username: config.username || '' };
  try {
    const me = await api.whoami();
    if (me && me.username && me.role && me.role !== 'guest') {
      // Keep local username in sync with the live session.
      if (me.username !== config.username) {
        config = { ...config, username: me.username };
        saveConfig(config);
      }
      return { ok: true, user: me };
    }
  } catch { /* offline / unreachable — don't wipe the token yet */ return { ok: true, offline: true }; }
  clearStaleAuth();
  return { ok: false, expired: true, username: config.username || '' };
}

/** Remote installs need a live session — fail fast with a clear message. */
async function requireRemoteAuth() {
  if (config.mode === 'local') return;
  const st = await validateAuthSession();
  if (st.ok) return;
  const err = new Error(
    st.expired
      ? 'Session expired — sign in again to download and install.'
      : 'Sign in required to download and install.'
  );
  err.code = 'AUTH_REQUIRED';
  err.expired = !!st.expired;
  err.username = st.username || config.username || '';
  throw err;
}

function authRequiredError(err) {
  if (!err) return false;
  if (err.code === 'AUTH_REQUIRED' || err.status === 401) return true;
  return /sign in required/i.test(String(err.message || ''));
}

function mapAuthError(err) {
  if (!authRequiredError(err)) return err;
  clearStaleAuth();
  const e = new Error('Session expired — sign in again to download and install.');
  e.code = 'AUTH_REQUIRED';
  e.expired = true;
  e.username = config.username || '';
  return e;
}

ipcMain.handle('auth:validate', () => validateAuthSession());

ipcMain.handle('auth:logout', async () => {
  try {
    await api.logout();
  } catch { /* token may already be dead */ }
  config = { ...config, authToken: '' };
  saveConfig(config);
  cachedAvatar = null;
  avatarFetchedAt = 0;
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
// Make sure Gamehub can write into an install folder. Program Files needs a
// one-time UAC grant (Steam does the same for its folder) — after that every
// install writes there without prompts.
async function prepareInstallRoot(dir, gameId = null) {
  if (libraryRoot.isWritable(dir)) return;
  if (gameId != null) {
    task(gameId, 'downloading', { pct: 0, message: 'Setting up the Gamehub folder — approve the Windows prompt…' });
  }
  const r = await libraryRoot.ensureLibraryRoot(dir, {
    elevated: platform.isWindows && elevatedLaunch.isProcessElevated(),
  });
  logUpdate('info', `library root ${dir}: ${JSON.stringify(r)}`);
  if (r.ok) { markGamesDir(); return; }
  if (r.error === 'uac-cancelled') {
    throw new Error(`Gamehub needs your OK once to set up its games folder (${dir}), like Steam does for its own. Click Install again and choose Yes — or pick another folder in Settings → Downloads.`);
  }
  throw new Error(`Gamehub can’t write to ${dir}. Pick another games folder in Settings → Downloads.`);
}
ipcMain.handle('library:prepare', async (e, dir) => {
  try { await prepareInstallRoot(dir || config.gamesDir); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('game:install', async (e, { gameId, packageId, installDir } = {}) => {
  // One click: no folder chosen yet → the default library (Program Files on
  // Windows), set up on the spot.
  if (!installDir && !config.gamesDir) {
    config = { ...config, gamesDir: libraryRoot.defaultGamesDir() };
    saveConfig(config);
  }
  const baseDir = installDir || config.gamesDir;
  if (!baseDir) throw new Error('Set your games folder in Settings first.');
  await prepareInstallRoot(baseDir, gameId);
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
    const mapped = mapAuthError(err);
    task(gameId, 'error', { message: mapped.message || 'Install failed' });
    endJob(gameId, { keepIfPaused: false });
    throw mapped;
  } finally {
    activeTasks.delete(gameId);
    if (getJob(gameId)?.state === 'paused') activeTasks.add(gameId);
  }
});

ipcMain.handle('game:cancel', async (e, gameId) => {
  const wiz = wizardAborts.get(gameId);
  if (wiz && !getJob(gameId)) { wiz.abort('cancelled'); return { ok: true }; }
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
  job?.throwIfAborted?.();
  await requireRemoteAuth();
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
    const extractedCount = await installer.extractAll(stagingDir, workDir, (m, pct) =>
      task(dlcId, 'extracting', { message: m, pct }), job?.signal
    );
    job?.throwIfAborted();
    if (extractedCount === 0) {
      for (const entry of fs.readdirSync(stagingDir)) {
        fs.renameSync(path.join(stagingDir, entry), path.join(workDir, entry));
      }
    }
    installer.flattenSingleDir(workDir);
    await unwrapSfxInstallers(dlcId, workDir, job);

    // DLC with its own setup → run it silently into the base game's folder
    {
      const setup = installer.findInstaller(workDir);
      if (setup) {
        const r = await runSetupIntoGame(dlcId, setup, parent.dir, { job, winePrefix: parent.winePrefix });
        job?.throwIfAborted();
        if (r.ok) {
          installed[dlcId] = {
            title, mode: 'dlc', status: 'installed', dir: parent.dir, parentGameId: parentId,
            files: r.added, shortcuts: [], packageId, silentEngine: r.fp.engine,
          };
          parent.dlc = { ...(parent.dlc || {}), [dlcId]: title };
          saveInstalled(installed);
          stagingDone = true;
          task(dlcId, 'done', { message: `${title} installed into ${parent.title}.` });
          return installed[dlcId];
        }
      }
    }

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
  job?.throwIfAborted?.();
  await requireRemoteAuth();
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
    const extractedCount = await installer.extractAll(stagingDir, workDir, (m, pct) =>
      task(gameId, 'extracting', { message: m, pct }), job?.signal
    );
    job?.throwIfAborted();
    if (extractedCount === 0) {
      for (const e2 of fs.readdirSync(stagingDir)) {
        fs.renameSync(path.join(stagingDir, e2), path.join(workDir, e2));
      }
    }
    installer.flattenSingleDir(workDir);
    await unwrapSfxInstallers(gameId, workDir, job);

    // Update with its own setup → silently into the game's folder first.
    {
      const setup = installer.findInstaller(workDir);
      if (setup) {
        backupSaves(entry.dir, savesDirFor(baseDir, entry.title || title));
        const r = await runSetupIntoGame(gameId, setup, entry.dir, { job, winePrefix: entry.winePrefix });
        job?.throwIfAborted();
        if (r.ok && (r.added.length || r.changed.length)) {
          entry.appliedUpdates = [...new Set([...(entry.appliedUpdates || []), packageId])];
          saveInstalled(installed);
          stagingDone = true;
          const audit = installer.auditInstall(entry);
          if (!audit.ok && audit.issues.some((i) => i.includes('executable'))) {
            entry.status = 'needs-exe';
            entry.exe = null;
            saveInstalled(installed);
            task(gameId, 'needs-exe', { message: 'Updated, but the launcher moved — use “Select launcher”.' });
            return entry;
          }
          task(gameId, 'done', { message: `Update installed (${r.added.length + r.changed.length} files).` });
          return entry;
        }
        // ran but touched nothing (delta patcher for another release, …) → wizard below
      }
    }

    // Wizard-based update: extract beside the game and hand off. We CANNOT see
    // whether the external wizard succeeds, so we do NOT mark it applied — the
    // update stays available and the user dismisses it once done. Many scene
    // update wizards are binary-delta patchers locked to ONE base release
    // (they verify MD5s and refuse a different repack), so say so up front.
    if (installer.findInstaller(workDir)) {
      const updDir = path.join(baseDir, `${entry.title || title} - Update`);
      fs.rmSync(updDir, { recursive: true, force: true });
      fs.renameSync(workDir, updDir);
      const updExe = installer.findInstaller(updDir);
      const grp = (String(pkg.raw_name || '').match(/-([A-Za-z0-9]+)$/) || [])[1];
      stagingDone = true;
      const hint = `If it reported missing or hash-mismatched files, it's a delta patch built for the ${grp ? `${grp} ` : ''}release and can't update a different repack — grab the newest full release instead.`;
      task(gameId, 'installing-wizard', { message: `Update installer is open — point it at ${entry.dir}. Installer audio is muted.` });
      const run = await runGuardedInstaller(updExe, { watchDirs: [updDir], signal: job?.signal });
      if (run.error === 'guard-unavailable') await openPathSmart(updExe, { winePrefix: entry.winePrefix || winePrefixForTitle(entry.title) });
      task(gameId, 'update-wizard', {
        message: run.ok
          ? `Update installer closed. ${hint} Dismiss the update once you've confirmed it applied.`
          : `Update installer opened — point it at ${entry.dir}. ${hint} Dismiss the update once it finishes.`,
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
  if (installer.isInstallerPrimary(libPath, title)) return null; // FitGirl/setup payload — normal flow
  const ranked = installer.rankGameExes(libPath, title);
  const topExe = ranked[0];
  if (!installer.isConfidentGameExe(ranked, { installerPath: null })) return null; // ambiguous — normal flow
  installed[gameId] = { title, dir: libPath, exe: topExe.path, mode: 'portable', status: 'installed', inPlace: true, shortcuts: [], packageId };
  saveInstalled(installed);
  task(gameId, 'done', { message: 'Ready to play — launching in place, no copy.' });
  return installed[gameId];
}

/**
 * Already-saved “installed” entries that are really setup-primary (FitGirl bins
 * + setup.exe, or setup + weak helper) get demoted back to Run Installer.
 * Never demote needs-exe — that means the wizard was already launched and the
 * user should pick / auto-adopt the launcher (demoting trapped them on Run Installer).
 */
function demoteInstallerPrimary(entry) {
  if (!entry?.dir || !fs.existsSync(entry.dir)) return { entry, changed: false };
  if (entry.status !== 'installed') return { entry, changed: false };
  // User finished setup / picked a launcher — leftover bins must not undo that.
  if (entry.setupComplete) return { entry, changed: false };
  if (entry.exe && installer.isRealInstalledGameBinary(entry.exe)) return { entry, changed: false };
  if (installer.folderHasInstalledGameData(entry.dir)) return { entry, changed: false };
  if (!installer.isInstallerPrimary(entry.dir, entry.title || '')) return { entry, changed: false };
  const installerPath = installer.findInstaller(entry.dir);
  if (!installerPath) return { entry, changed: false };
  const next = {
    ...entry,
    status: 'needs-install',
    mode: 'installer',
    installer: installerPath,
    exe: null,
  };
  return { entry: next, changed: true };
}

/**
 * After a FitGirl/DODI wizard finishes, the real game often lives in a sibling
 * folder (or the same folder once Engine/Content appear). Find a real launcher
 * and promote needs-install / needs-exe → installed.
 */
function findPostWizardLauncher(entry, installed) {
  const title = entry.title || '';
  const pool = [];
  const consider = (dir) => {
    if (!dir || !fs.existsSync(dir)) return;
    const primary = installer.isInstallerPrimary(dir, title);
    for (const c of installer.rankGameExes(dir, title)) {
      let { score } = c;
      const real = installer.isRealInstalledGameBinary(c.path);
      if (real) score += 40;
      else if (primary) score -= 60; // unfinished payload stubs must not win
      pool.push({ ...c, score, dir, real });
    }
  };
  consider(entry.dir);
  for (const d of orphanGameDirs(installed, entry.dir)) {
    if (!installer.folderMatchesGame(path.basename(d), title)) continue;
    consider(d);
  }
  pool.sort((a, b) => b.score - a.score);
  const top = pool[0];
  if (!top || top.score < 20) return null;
  const dirPrimary = installer.isInstallerPrimary(top.dir, title);
  if (dirPrimary && !top.real) return null;
  if (!top.real && top.score < 45) return null;
  return top;
}

function tryPromoteAfterWizard(entry, installed) {
  if (!entry || (entry.status !== 'needs-install' && entry.status !== 'needs-exe')) {
    return { entry, changed: false };
  }
  const found = findPostWizardLauncher(entry, installed);
  if (!found) {
    // Setup finished into this folder enough that it's no longer installer-primary,
    // but we still need the user to confirm the launcher.
    if (
      entry.status === 'needs-install'
      && entry.dir
      && fs.existsSync(entry.dir)
      && !installer.isInstallerPrimary(entry.dir, entry.title || '')
    ) {
      return { entry: { ...entry, status: 'needs-exe', mode: entry.mode === 'installer' ? 'portable' : entry.mode }, changed: true };
    }
    return { entry, changed: false };
  }
  const prevDir = entry.dir;
  let nextDir = found.dir;
  try {
    const root = installRootFor(found.path);
    if (root && fs.existsSync(root)) nextDir = root;
  } catch { /* keep found.dir */ }
  const next = {
    ...entry,
    dir: nextDir,
    exe: found.path,
    status: 'installed',
    mode: 'portable',
    setupComplete: true,
  };
  return {
    entry: next,
    changed: true,
    repackDir: prevDir && path.normalize(prevDir).toLowerCase() !== path.normalize(nextDir).toLowerCase()
      ? prevDir
      : null,
  };
}

// After library organization renames an install folder, the stored absolute
// dir/exe go stale — for ANY local-mode install, not just in-place ones (organize
// targets gamesDir now). Re-resolve under the entry's own install root (its
// parent dir, so picked alternate roots work too) — never under the Store.
// Every candidate folder must NAME-MATCH this game: a heal may never bind
// another game's folder or exe (the v1.4.7 launcher-picker rule).
async function healLocalEntry(gameId, entry) {
  if (config.mode !== 'local' || !entry?.dir || entry.mode === 'dlc') return entry;
  if (fs.existsSync(entry.dir)) {
    // Fix false “Play” on setup-primary folders (saved before the confidence gate).
    const demoted = demoteInstallerPrimary(entry);
    if (demoted.changed) {
      const cur = loadInstalled();
      cur[gameId] = demoted.entry;
      saveInstalled(cur);
      task(gameId, 'needs-install', {
        message: `“${demoted.entry.title || 'Game'}” still needs its setup — click Run Installer.`,
      });
      return demoted.entry;
    }
    return entry; // dir intact — exe issues go the needs-exe/Verify route
  }
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

function fmtRate(bps) {
  const mb = bps / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB/s` : mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}
function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Fetch a package into staging: local mode = filesystem copy from Store (fast);
// remote mode = HTTP download from the Gamehub server (unchanged).
async function fetchPackageToStaging(gameId, packageId, pkg, files, stagingDir, verb = 'Downloading', job) {
  const totalBytes = files.reduce((s, f) => s + f.size, 0) || 1;
  let doneBytes = 0;
  let lastEmit = 0;
  // Smoothed throughput for "42 MB/s · 3 min left" (EWMA over ~2 s windows so
  // the number doesn't jitter on every chunk).
  let rate = 0;
  let winStart = Date.now();
  let winBytes = 0;
  const progress = (chunkLen, rel) => {
    doneBytes += chunkLen;
    winBytes += chunkLen;
    const now = Date.now();
    if (now - winStart >= 1000) {
      const inst = (winBytes * 1000) / (now - winStart);
      rate = rate ? rate * 0.7 + inst * 0.3 : inst;
      winStart = now;
      winBytes = 0;
    }
    if (now - lastEmit < 250) return;
    lastEmit = now;
    const left = Math.max(0, totalBytes - doneBytes);
    // Steam-style: "48.3 MB/s · 6 min left" (the phase label already says
    // Downloading/Copying); the file name only until there's a rate to show.
    const parts = [];
    if (rate > 0) {
      parts.push(fmtRate(rate));
      if (doneBytes > 0 && left > 0) parts.push(`${fmtEta(left / rate)} left`);
    } else {
      parts.push(`${verb} ${path.basename(String(rel))}`);
    }
    task(gameId, 'downloading', {
      pct: Math.min(99, Math.round((doneBytes / totalBytes) * 100)),
      message: parts.join(' · '),
      rate: Math.round(rate),
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
  await requireRemoteAuth();
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
    // 3. assemble + extract (multi-part rar, zip, 7z, iso…)
    task(gameId, 'extracting', { message: 'Unpacking…' });
    // Fresh extract target — wipe leftovers from a previous paused attempt.
    if (!retiredDir && fs.existsSync(installDir) && !(existing && path.resolve(existing.dir) === path.resolve(installDir))) {
      try { fs.rmSync(installDir, { recursive: true, force: true }); } catch { /* */ }
    }
    fs.mkdirSync(installDir, { recursive: true });
    const extractedCount = await installer.extractAll(stagingDir, installDir, (m, pct) =>
      task(gameId, 'extracting', { message: m, pct }), job?.signal
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

    // Console game (Switch / Wii / GameCube)? File it under <library>\<Platform>
    // and play it in an emulator — never run setup / exe detection on it.
    {
      const found = consolePlatforms.detectPath(installDir);
      if (found) {
        const folder = { switch: 'Switch', wii: 'Wii', gamecube: 'GameCube' }[found.platform] || found.platform;
        const romDir = path.join(baseDir, folder, title);
        if (path.resolve(romDir) !== path.resolve(installDir)) {
          fs.rmSync(romDir, { recursive: true, force: true });
          fs.mkdirSync(path.dirname(romDir), { recursive: true });
          fs.renameSync(installDir, romDir);
        }
        const again = consolePlatforms.detectPath(romDir);
        installed[gameId] = {
          title, dir: romDir, mode: 'rom', status: 'installed', shortcuts: [], packageId,
          platform: again.platform,
          romPath: again.launch,
          romFiles: again.files.map((f) => ({ path: f.path, kind: f.kind, role: f.ids?.role || 'base', titleId: f.ids?.titleId || null })),
        };
        saveInstalled(installed);
        outcome = 'success';
        const emu = emulatorFor(again.platform);
        const need = emu ? emulators.missingRequirements(emu.id, emu.exe) : ['emulator'];
        const pname = consolePlatforms.PLATFORMS[again.platform]?.short || again.platform;
        task(gameId, 'done', {
          message: !need.length ? `Installed — plays with ${emulators.EMULATORS[emu.id].name}.`
            : need.includes('emulator') ? `Installed — set up a ${pname} emulator to play.`
              : `Installed — finish ${pname} setup (${need.join(', ')}) to play.`,
        });
        return installed[gameId];
      }
    }
    await unwrapSfxInstallers(gameId, installDir, job);
    // restore any persistent in-folder saves into this freshly installed version
    // (covers switching AND reinstalling after an uninstall). Deferred until we
    // know the final install tree — silent installs move this folder to payload
    // first, so restoring here would put saves into the disposable payload.

    // 5. figure out what we got — decision order matters:
    //    FitGirl/DODI payloads (setup + fg-*.bin) always need Run Installer.
    //    A strong, engine-backed game exe means READY TO PLAY even if some
    //    incidental setup.exe exists somewhere in the tree.
    const ranked = installer.rankGameExes(installDir, title);
    const topExe = ranked[0];
    const installerExeProbe = installer.findInstaller(installDir);
    const installerPrimary = installer.isInstallerPrimary(installDir, title);
    const confidentExe = !installerPrimary
      && installer.isConfidentGameExe(ranked, { installerPath: installerExeProbe });
    const installerExe = confidentExe ? null : installerExeProbe;
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
          // MSI / InstallShield / WiX bundles may have put the game in their own
          // folder (found via the Uninstall registry) — that is the install now.
          const gameDir = silent.targetDir || installDir;
          let rankedSilent = silent.verified?.ranked || installer.rankGameExes(gameDir, title);
          // scene ISO: the group's crack folder sits next to setup.exe in the payload
          const crack = await applyReleaseCracks(gameId, [silent.payloadDir], gameDir, rankedSilent[0]?.path);
          if (crack) rankedSilent = installer.rankGameExes(gameDir, title);
          const topSilent = rankedSilent[0];
          const leftoverSetup = installer.findInstaller(gameDir);
          const confidentSilent = installer.isConfidentGameExe(rankedSilent, { installerPath: leftoverSetup });

          const notes = keepReleaseNotes([silent.payloadDir], gameDir);
          if (notes.length) logUpdate('info', `release notes kept: ${notes.join(', ')}`);
          // Drop private payload only after verification succeeded
          try { fs.rmSync(silent.payloadDir, { recursive: true, force: true }); } catch { /* */ }
          // Saves go into the FINAL install tree (not the disposable payload).
          restoreSavesInto(savesDir, gameDir);

          if (topSilent && confidentSilent) {
            const shortcuts = await installer.createShortcuts(title, topSilent.path, shortcutOpts({
              title,
              winePrefix: silent.winePrefix,
              linuxRunner: silent.linuxRunner || 'wine',
            }));
            installed[gameId] = {
              title, dir: gameDir, mode: 'portable', status: 'installed',
              exe: topSilent.path, shortcuts, packageId,
              silentEngine: fp.engine,
              crack: crack || undefined,
              // registered uninstaller (MSI: msiexec /x {GUID}) — used by Uninstall
              uninstaller: silent.uninstaller || undefined,
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
            task(gameId, crack?.missing?.length ? 'play-failed' : 'done', {
              message: crack?.missing?.length
                ? `Installed, but ${crackMissingText(crack.missing)}`
                : audit.ok ? 'Installed & verified. Ready to play.' : `Installed (${audit.issues.join('; ')}).`,
            });
            return installed[gameId];
          }

          // Installed but launcher ambiguous
          installed[gameId] = {
            title, dir: gameDir, mode: 'portable', status: 'needs-exe',
            shortcuts: [], packageId, silentEngine: fp.engine, crack: crack || undefined,
            uninstaller: silent.uninstaller || undefined,
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

        // Automatic setup failed — keep payload for the wizard, but NEVER point
        // entry.dir at _staging (that poisons the next install's baseDir into
        // nesting under _staging). Title folder stays the install root.
        const setupPath = silent.setupExe && fs.existsSync(silent.setupExe)
          ? silent.setupExe
          : (fs.existsSync(installerExe) ? installerExe : null);
        try { fs.mkdirSync(installDir, { recursive: true }); } catch { /* */ }
        const failHint = silent.reason === 'uac-cancelled'
          ? 'the Windows permission prompt was declined'
          : silent.reason === 'needs-elevation'
            ? 'Windows permission was required'
            : silent.reason === 'no-game-output'
              ? 'setup finished but no game files were found'
              : 'automatic setup couldn’t finish';
        installed[gameId] = {
          title,
          dir: installDir,
          mode: 'installer',
          status: 'needs-install',
          installer: setupPath || (silent.payloadDir
            ? path.join(silent.payloadDir, path.basename(installerExe))
            : path.join(installDir, path.basename(installerExe))),
          shortcuts: [],
          packageId,
          payloadDir: silent.payloadDir || null,
          silentAttempt: { reason: silent.reason, engine: fp.engine },
          crackFrom: crackSourceFor(silent.payloadDir, installDir),
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
            installed[gameId] = await runWizardAndAdopt(gameId, installed[gameId].installer, { job });
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
        crackFrom: crackSourceFor(installDir),
      };
      saveInstalled(installed);
      outcome = 'success';
      const unsupported = fp.support !== 'auto'
        ? (fp.engine === 'unknown'
          ? 'This setup isn’t safely automatable yet. Open its installer to continue.'
          : `${fp.engineLabel} detected — open the setup wizard to continue.`)
        : `Installer found: ${path.basename(installerExe)}. Click "Run Installer".`;
      restoreSavesInto(savesDir, installDir);
      if (process.env.GAMEHUB_NO_CONFIRM === '1') {
        task(gameId, 'needs-install', { message: unsupported });
      } else {
        // Steam-like: you already said Install — open the wizard now (audio
        // guarded) and finish the job automatically when it closes.
        installed[gameId] = await runWizardAndAdopt(gameId, installerExe, { job });
      }
      return installed[gameId];
    }

    // Portable release with the crack still in its own folder → apply it now.
    const portableCrack = topExe ? await applyReleaseCracks(gameId, [installDir], installDir, topExe.path) : null;
    if (topExe) keepReleaseNotes([installDir], installDir);

    // ambiguous detection? never guess — hand the ranked candidates to the user
    if (topExe && !confidentExe) {
      restoreSavesInto(savesDir, installDir);
      installed[gameId] = {
        title, dir: installDir, mode: 'portable', status: 'needs-exe', shortcuts: [], packageId,
        crack: portableCrack || undefined,
      };
      saveInstalled(installed);
      outcome = 'success';
      task(gameId, 'needs-exe', {
        message: `Found ${ranked.length} possible executables but none is a clear winner — confirm one in “Select launcher”.`,
      });
      return installed[gameId];
    }

    const exe = topExe ? topExe.path : null;
    if (exe) {
      restoreSavesInto(savesDir, installDir);
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
        crack: portableCrack || undefined,
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
      task(gameId, portableCrack?.missing?.length ? 'play-failed' : 'done', {
        message: portableCrack?.missing?.length
          ? `Installed, but ${crackMissingText(portableCrack.missing)}`
          : audit.ok ? 'Installed & verified. Ready to play.' : `Installed (${audit.issues.join('; ')}).`,
      });
      return installed[gameId];
    }

    restoreSavesInto(savesDir, installDir);
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
  // Fire-and-forget: the wizard can stay open for a long time; progress and
  // the final state arrive as task updates.
  runWizardAndAdopt(gameId, entry.installer).catch((err) => {
    task(gameId, 'error', { message: err.message || 'Setup failed' });
  });
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
  const base = path.basename(exe);
  if (/^(setup|install)/i.test(base) && !/unins|dxweb|vcredist|directx/i.test(base)) {
    throw new Error('That’s the installer — pick the game’s .exe (often under bin64 or Binaries\\Win64).');
  }
  const winePrefix = entry.winePrefix || winePrefixForTitle(entry.title);
  const linuxRunner = entry.linuxRunner || (platform.isLinux ? (config.linuxRunner || 'wine') : undefined);
  const shortcuts = await installer.createShortcuts(entry.title, exe, shortcutOpts({
    title: entry.title, winePrefix, linuxRunner,
  }));
  Object.assign(entry, {
    exe, shortcuts, status: 'installed', mode: 'portable', setupComplete: true,
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
  if (entry.mode === 'rom') return playInEmulator(gameId, entry);
  // local mode: if organize renamed the install folder, heal dir/exe/shortcuts first
  entry = await healLocalEntry(gameId, entry);
  // Also catch setup-primary false Play outside local heal (remote installs).
  {
    const demoted = demoteInstallerPrimary(entry);
    if (demoted.changed) {
      const cur = loadInstalled();
      cur[gameId] = demoted.entry;
      saveInstalled(cur);
      task(gameId, 'needs-install', {
        message: `“${demoted.entry.title || 'Game'}” still needs its setup — click Run Installer.`,
      });
      throw new Error('This download still needs its setup — click Run Installer.');
    }
    entry = demoted.entry;
  }
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
    if (entry.launchArgs) launch = { ...launch, args: [...launch.args, ...parseLaunchArgs(entry.launchArgs)] };
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
      } else if (
        elevatedLaunch.isRegistered()
        && elevatedLaunch.taskNeedsSilentUpgrade()
        && config.elevatedLaunchSilentUpgraded !== true
      ) {
        // v1.9.16 registered powershell.exe directly (blue console flash). One
        // repair swaps in a silent wscript wrapper.
        const choice = await askUser({
          title: 'Update admin launches',
          message: 'A quick update makes admin game launches fully silent (no PowerShell window).',
          detail: 'Windows will ask for approval once more, then you’re done.',
          buttons: ['Update', 'Skip'],
          defaultId: 0,
        });
        config = { ...config, elevatedLaunchSilentUpgraded: true };
        saveConfig(config);
        if (choice === 0) {
          const en = await elevatedLaunch.enable();
          if (!en.ok) console.warn('[play] elevated helper silent upgrade failed:', en.error);
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
            elevated: true,
          });
          session.watchAdoptedPid();
          return;
        }
        console.warn('[play] elevated helper launch failed:', elev.error);
        // CRITICAL: if schtasks already fired, the game may be starting elevated.
        // Never fall through to shell.openPath — that causes a delayed second UAC.
        if (elev.ran) {
          api.setStatus(Number(gameId));
          setTimeout(() => { try { api.setStatus(null); } catch { /* */ } }, 90_000);
          win?.webContents.send('task:update', {
            gameId: Number(gameId),
            phase: 'shell-launched',
            message: 'Game start was sent, but Gamehub couldn’t attach the overlay/playtime. Try Settings → In-game → Administrator mode → Repair helper, then Play again.',
          });
          return;
        }
      }
    }

    const before = await winGameProcess.pidsForExe(entry.exe).catch(() => []);
    let startedOk = await winGameProcess.launchUnelevated(entry.exe).catch(() => false);
    if (!startedOk) {
      // Last resort — may UAC. Avoid when we already know elevation is required
      // and the helper isn't available (user declined setup).
      if (elevationish && !elevatedLaunch.isRegistered()) {
        task(gameId, 'play-failed', {
          message: 'This game needs administrator permission. Turn on “Run Gamehub as administrator” (or Repair helper) in Settings → In-game → Administrator mode, then try Play again.',
        });
        return;
      }
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
        message: 'Launched — couldn’t attach playtime/overlay for this session. If Windows asked for admin every time, use Settings → In-game → Administrator mode, or uncheck “Run this program as an administrator” on the .exe Compatibility tab.',
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

// ---------- emulators (console games) ----------
const EMULATOR_PLATFORMS = Object.keys(emulators.PLATFORM_EMULATORS);

function emulatorsRoot() {
  return platform.isWindows
    ? path.join(libraryRoot.defaultGamehubRoot(), 'emulators')
    : path.join(os.homedir(), '.local', 'share', 'gamehub', 'emulators');
}

/**
 * The emulator a platform (or one game) plays with: the per-game choice, the
 * platform default from Settings, or — first time — an existing install we
 * can find (adopted and remembered). null = needs setting up.
 */
function emulatorFor(plat, entry = null) {
  const pick = (c) => (c && c.exe && fs.existsSync(c.exe) ? c : null);
  if (entry?.emulator) {
    const own = pick(entry.emulator);
    if (own) return own;
  }
  const saved = pick(config.emulators?.[plat]);
  if (saved) return saved;
  for (const id of emulators.PLATFORM_EMULATORS[plat] || []) {
    const found = emulators.detectInstalled(id, { roots: [emulatorsRoot()] });
    if (found) {
      setPlatformEmulator(plat, found);
      return found;
    }
  }
  return null;
}

function setPlatformEmulator(plat, emu) {
  const all = { ...(config.emulators || {}) };
  // one emulator often covers several platforms (Dolphin: Wii + GameCube)
  for (const p of emulators.EMULATORS[emu.id].platforms) {
    if (p === plat || !all[p] || !fs.existsSync(all[p].exe || '')) all[p] = { id: emu.id, exe: emu.exe, version: emu.version || null, managed: !!emu.managed };
  }
  config = { ...config, emulators: all };
  saveConfig(config);
}

function emulatorStatus() {
  return EMULATOR_PLATFORMS.map((plat) => {
    const cur = emulatorFor(plat);
    return {
      platform: plat,
      name: consolePlatforms.PLATFORMS[plat]?.name || plat,
      current: cur ? { ...cur, name: emulators.EMULATORS[cur.id]?.name || cur.id } : null,
      missing: cur ? emulators.missingRequirements(cur.id, cur.exe) : ['emulator'],
      dataDir: cur ? emulators.dataDir(cur.id, cur.exe) : null,
      options: (emulators.PLATFORM_EMULATORS[plat] || []).map((id, i) => ({
        id, name: emulators.EMULATORS[id].name, recommended: i === 0,
        canDownload: emulators.EMULATORS[id].sources.some((src) => (src.asset || src.link || {})[process.platform]),
      })),
    };
  });
}

ipcMain.handle('emulators:status', () => emulatorStatus());

ipcMain.handle('emulators:install', async (e, { platform: plat, emuId }) => {
  const id = emuId || (emulators.PLATFORM_EMULATORS[plat] || [])[0];
  if (!emulators.EMULATORS[id]) throw new Error('Unknown emulator.');
  const root = emulatorsRoot();
  await prepareInstallRoot(root);
  const send = (p) => win?.webContents.send('emulator:progress', { platform: plat, emuId: id, ...p });
  try {
    const got = await emulators.installEmulator(id, {
      root,
      extract: (archive, dest) => installer.extractFile(archive, dest),
      onProgress: send,
    });
    setPlatformEmulator(plat, got);
    logUpdate('info', `emulator ${id} ${got.version} installed → ${got.exe}`);
    return emulatorStatus();
  } catch (err) {
    send({ phase: 'error', message: err.message });
    throw err;
  }
});

ipcMain.handle('emulators:useExisting', async (e, { platform: plat, emuId }) => {
  const emu = emulators.EMULATORS[emuId];
  if (!emu) throw new Error('Unknown emulator.');
  const r = await dialog.showOpenDialog(win, {
    title: `Select ${emu.name}`,
    properties: ['openFile'],
    filters: platform.isWindows ? [{ name: emu.name, extensions: ['exe'] }] : [],
  });
  if (r.canceled || !r.filePaths[0]) return emulatorStatus();
  setPlatformEmulator(plat, { id: emuId, exe: r.filePaths[0], managed: false });
  return emulatorStatus();
});

ipcMain.handle('emulators:importKeys', async (e, { platform: plat }) => {
  const cur = emulatorFor(plat);
  if (!cur) throw new Error('Set up an emulator first.');
  const r = await dialog.showOpenDialog(win, {
    title: 'Select your prod.keys (and title.keys)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Switch keys', extensions: ['keys'] }],
  });
  if (r.canceled || !r.filePaths.length) return emulatorStatus();
  emulators.importKeys(cur.id, cur.exe, r.filePaths);
  return emulatorStatus();
});

ipcMain.handle('emulators:openData', async (e, { platform: plat }) => {
  const cur = emulatorFor(plat);
  const dir = cur && emulators.dataDir(cur.id, cur.exe);
  if (!dir) throw new Error('Set up an emulator first.');
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

// open the emulator on its own (e.g. to install Switch firmware from its menu)
ipcMain.handle('emulators:open', async (e, { platform: plat }) => {
  const cur = emulatorFor(plat);
  if (!cur) throw new Error('Set up an emulator first.');
  spawn(cur.exe, [], { cwd: path.dirname(cur.exe), detached: true, stdio: 'ignore' }).unref();
  return true;
});

ipcMain.handle('game:setEmulator', async (e, { gameId, emuId }) => {
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry || entry.mode !== 'rom') throw new Error('Not a console game.');
  if (!emuId) delete entry.emulator;
  else {
    const found = (config.emulators?.[entry.platform]?.id === emuId && config.emulators[entry.platform])
      || emulators.detectInstalled(emuId, { roots: [emulatorsRoot()] });
    if (!found) throw new Error(`${emulators.EMULATORS[emuId]?.name || emuId} isn’t set up yet — install it in Settings → Emulators.`);
    entry.emulator = { id: emuId, exe: found.exe };
  }
  saveInstalled(installed);
  return entry;
});

async function playInEmulator(gameId, entry) {
  const plat = entry.platform || (entry.romPath && consolePlatforms.detectFile(entry.romPath)?.platform) || 'switch';
  const rom = entry.romPath && fs.existsSync(entry.romPath) ? entry.romPath : consolePlatforms.detectPath(entry.dir || '')?.launch;
  if (!rom) throw new Error('The game file is missing — reinstall the game.');
  const emu = emulatorFor(plat, entry);
  const pname = consolePlatforms.PLATFORMS[plat]?.short || plat;
  if (!emu) {
    const err = new Error(`Set up a ${pname} emulator first.`);
    err.code = 'EMULATOR_REQUIRED';
    throw err;
  }
  const missing = emulators.missingRequirements(emu.id, emu.exe).filter((m) => m !== 'firmware');
  if (missing.length) {
    const err = new Error(`${emulators.EMULATORS[emu.id].name} needs your ${missing.join(' and ')} first — Settings → Emulators.`);
    err.code = 'EMULATOR_SETUP';
    throw err;
  }
  const launch = emulators.launchCommand(emu.id, emu.exe, rom, { fullscreen: config.emulatorFullscreen !== false });
  const pt = loadPlaytime();
  pt[gameId] = { ...(pt[gameId] || { seconds: 0 }), lastPlayed: new Date().toISOString() };
  savePlaytime(pt);
  const started = Date.now();
  const child = spawn(launch.cmd, launch.args, { cwd: launch.cwd, detached: true, stdio: 'ignore' });
  child.once('error', (err) => task(gameId, 'play-failed', { message: `Couldn’t start ${emulators.EMULATORS[emu.id].name}: ${err.message}` }));
  child.once('spawn', () => {
    const session = beginTrackedSession({ gameId, title: entry.title, pid: child.pid, started, exePath: emu.exe });
    child.once('exit', (code) => session.onChildExit(code));
  });
  child.unref();
  return true;
}

// ranked executable candidates for the Edit-entry UI
// Folders in the games dir that no installed entry owns. After an external
// setup wizard (FitGirl/DODI-style repack) runs, the actual game lands in a
// fresh folder the user picked — usually right here in the games dir — while
// entry.dir still points at the unpacked repack. Scanning orphans lets the
// launcher picker surface the real, installed exe automatically.
function orphanGameDirs(installed, excludeDir) {
  const roots = [config.gamesDir, ...(config.gamesDirs || [])].filter(Boolean);
  if (!roots.length) return [];
  const norm = (p) => path.normalize(p || '').toLowerCase().replace(/[\\/]+$/, '');
  const owned = new Set(Object.values(installed).map((en) => norm(en.dir)).filter(Boolean));
  owned.add(norm(excludeDir));
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const p = path.join(root, d.name);
        const key = norm(p);
        if (owned.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push(p);
      }
    } catch { /* root unreadable — skip */ }
  }
  return out;
}

// Ranked launcher candidates for a game. Sources, best first:
//   1. folders a setup wizard registered (Uninstall InstallLocation) — proof
//      of where the game actually went, even outside the games folder
//   2. the game's own install dir
//   3. orphan games-folder dirs whose NAME matches this game (fallback)
async function launcherCandidates(gameId) {
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
  const seen = new Set();
  const rankDir = (dir, relBase, bonus = 0, why = null) => {
    const ev = installer.folderEvidence(dir, expected);
    for (const c of installer.rankGameExes(dir, entry.title)) {
      const k = c.path.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      let { score } = c;
      const reasons = [...c.reasons];
      if (ev.desolate) { score -= 25; reasons.push('folder holds no game data'); }
      else if (ev.sizeMatches) { score += 12; reasons.push('folder size matches the download'); }
      else if (ev.substantial) { score += 8; reasons.push('folder holds the game data'); }
      if (bonus) { score += bonus; if (why) reasons.push(why); }
      pool.push({ ...c, score, reasons, rel: path.relative(relBase, c.path) });
    }
    return ev;
  };

  for (const dir of entry.wizardDirs || []) {
    if (dir && fs.existsSync(dir)) rankDir(dir, path.dirname(dir), 10, 'where setup installed the game');
  }

  // Exes in the game's OWN install dir — the normal, correct source.
  const ownEv = entry.dir && fs.existsSync(entry.dir) ? rankDir(entry.dir, entry.dir) : null;

  // Fallback for wizard/repack installs whose game landed in a NEW folder:
  // only when nothing is confident yet — a desolate own dir is never
  // confident, even if a title-named stub survived in it — AND only in
  // orphan folders whose NAME matches THIS game, never other games' folders.
  const ownConfident = !!ownEv && !ownEv.desolate && pool.some((c) => (
    c.score >= 45
    || (c.reasons || []).some((r) => /UE shipping/i.test(r))
  ));
  if (!ownConfident) {
    for (const dir of orphanGameDirs(installed, entry.dir)) {
      if (!installer.folderMatchesGame(path.basename(dir), entry.title)) continue;
      rankDir(dir, path.dirname(dir));
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
}

// Same bar the install pipeline uses for "ready to play without asking".
function confidentPick(candidates) {
  const [top, next] = candidates || [];
  if (!top || top.score <= 0) return null;
  if (top.score >= 45 && (!next || top.score - next.score >= 8)) return top;
  if (top.score >= 15 && (!next || top.score - next.score >= 15)) return top;
  return null;
}

ipcMain.handle('game:candidates', async (e, gameId) => launcherCandidates(gameId));

// The top-level folder the chosen exe lives in: for exes inside the games dir
// that's the games dir's immediate child (the wizard's install folder); for
// anything else, the exe's own folder.
function installRootFor(exePath, wizardDirs = []) {
  for (const d of wizardDirs || []) {
    if (d && isInside(exePath, d)) return d; // the folder setup registered
  }
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
async function adoptLauncher(gameId, exePath, { quiet = false } = {}) {
  const installed = loadInstalled();
  const entry = installed[gameId];
  if (!entry) throw new Error('Not installed.');
  if (!exePath || !fs.existsSync(exePath)) throw new Error('That executable does not exist.');
  if (!/\.exe$/i.test(exePath)) throw new Error('Play target must be an .exe file.');
  const base = path.basename(exePath);
  if (/^(setup|install)/i.test(base) && !/unins|dxweb|vcredist|directx/i.test(base)) {
    throw new Error('That’s the installer — pick the game’s .exe (often under bin64 or Binaries\\Win64).');
  }

  // Launcher chosen OUTSIDE the folder we unpacked into = a wizard installed
  // the game elsewhere (the FitGirl flow). Adopt the real install folder so
  // Open Folder / uninstall / save-backup all track the actual game, and offer
  // to clear the now-redundant repack copy.
  const norm = (p) => path.normalize(p || '').toLowerCase().replace(/[\\/]+$/, '');
  const repackDir = entry.dir;
  const relToOld = repackDir ? path.relative(repackDir, exePath) : '..';
  if (!entry.inPlace && (relToOld.startsWith('..') || path.isAbsolute(relToOld))) {
    const root = installRootFor(exePath, entry.wizardDirs);
    if (norm(root) !== norm(config.gamesDir)) entry.dir = root;
    const oldInGames =
      repackDir && config.gamesDir && norm(repackDir) !== norm(config.gamesDir) &&
      !path.relative(config.gamesDir, repackDir).startsWith('..') &&
      !path.isAbsolute(path.relative(config.gamesDir, repackDir));
    if (oldInGames && norm(repackDir) !== norm(entry.dir) && fs.existsSync(repackDir)) {
      // fire-and-forget: prompt appears right after the picker closes
      setTimeout(() => { offerRepackCleanup(gameId, entry.title, repackDir).catch(() => {}); }, 400);
    }
  } else if (!entry.inPlace && entry.dir && fs.existsSync(exePath)) {
    // Same-folder / nested pick — adopt the games-dir root that holds this exe.
    const root = installRootFor(exePath);
    if (root && fs.existsSync(root)) entry.dir = root;
  }

  // Setup wizard installed a scene release: put the crack over it now that we
  // know where the game went (once — a later launcher change won't redo it).
  if (entry.crackFrom?.length && !entry.crack && entry.dir) {
    const c = await applyReleaseCracks(gameId, entry.crackFrom.filter((d) => fs.existsSync(d)), entry.dir, exePath);
    if (c) entry.crack = c;
    keepReleaseNotes(entry.crackFrom, entry.dir);
  }

  installer.removeShortcuts(entry.shortcuts || []);
  const winePrefix = entry.winePrefix || winePrefixForTitle(entry.title);
  const linuxRunner = entry.linuxRunner || (platform.isLinux ? (config.linuxRunner || 'wine') : undefined);
  const shortcuts = await installer.createShortcuts(entry.title, exePath, shortcutOpts({
    title: entry.title, winePrefix, linuxRunner,
  }));
  Object.assign(entry, {
    exe: exePath,
    shortcuts,
    status: 'installed',
    mode: 'portable',
    // Trust an explicit Select launcher choice — leftover FitGirl bins must not
    // bounce this back to “setup hasn’t been run”.
    setupComplete: true,
    winePrefix: platform.isLinux ? winePrefix : entry.winePrefix,
    linuxRunner: platform.isLinux ? linuxRunner : entry.linuxRunner,
  });
  const audit = installer.auditInstall(entry);
  entry.verified = audit.ok;
  saveInstalled(installed);
  task(gameId, 'done', {
    message: quiet
      ? 'Installed. Ready to play.'
      : (audit.ok ? 'Ready to play.' : `Updated (${audit.issues.join('; ')}).`),
  });
  return entry;
}
ipcMain.handle('game:setExe', async (e, { gameId, exePath }) => adoptLauncher(gameId, exePath));

// ---------- setup wizards: guarded, tracked, and finished automatically ----------
// Every wizard Gamehub opens runs under the installer audio guard (repack music
// muted before it can start), and Gamehub WAITS for it: when the wizard closes
// we read the Uninstall registry to see where it put the game, pick the
// launcher, make shortcuts, and offer to delete the repack files — the
// "Select launcher" step only appears when the result is genuinely ambiguous.
const wizardAborts = new Map(); // gameId -> AbortController

// Without the guard (Linux via Wine, or PowerShell unavailable) Gamehub can't
// see the wizard close — poll a few times for the installed game instead.
function scheduleAdoptRetries(gameId) {
  const tryAdopt = () => {
    try {
      const cur = loadInstalled();
      const ent = cur[gameId];
      if (!ent || ent.status === 'installed') return;
      const promoted = tryPromoteAfterWizard(ent, cur);
      if (promoted.changed) {
        cur[gameId] = promoted.entry;
        saveInstalled(cur);
        task(gameId, 'done', { message: 'Found the installed game. Ready to play.' });
        if (promoted.repackDir && config.gamesDir) {
          const rel = path.relative(config.gamesDir, promoted.repackDir);
          if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(promoted.repackDir)) {
            setTimeout(() => { offerRepackCleanup(gameId, promoted.entry.title, promoted.repackDir).catch(() => {}); }, 600);
          }
        }
      }
    } catch { /* best-effort */ }
  };
  setTimeout(tryAdopt, 8_000);
  setTimeout(tryAdopt, 30_000);
  setTimeout(tryAdopt, 90_000);
}

async function runWizardAndAdopt(gameId, exe, { job = null } = {}) {
  let installed = loadInstalled();
  let entry = installed[gameId];
  if (!entry) throw new Error('Not installed.');
  if (wizardAborts.has(gameId)) return entry; // already open
  const ctrl = new AbortController();
  const onJobAbort = () => ctrl.abort(job?.signal?.reason);
  job?.signal?.addEventListener('abort', onJobAbort, { once: true });
  wizardAborts.set(gameId, ctrl);
  const finish = (status, phase, message, extra = {}) => {
    installed = loadInstalled();
    entry = installed[gameId] || entry;
    entry.status = status;
    // setup actually ran: leftover setup files must not flip this back to needs-install
    if (status === 'needs-exe') entry.installerLaunched = true;
    if (platform.isLinux) entry.winePrefix = entry.winePrefix || winePrefixForTitle(entry.title);
    installed[gameId] = entry;
    saveInstalled(installed);
    task(gameId, phase, { message, ...extra });
    return entry;
  };
  try {
    const before = await uninstallReg.snapshot();
    task(gameId, 'installing-wizard', {
      message: 'Finish the wizard — Gamehub takes it from there. Installer audio is muted.',
    });
    const res = await runGuardedInstaller(exe, {
      watchDirs: [entry.dir, entry.payloadDir].filter(Boolean),
      signal: ctrl.signal,
    });

    if (res.error === 'guard-unavailable' || res.error === 'setup-missing') {
      if (res.error === 'setup-missing') {
        return finish('needs-install', 'needs-install', 'The setup file is missing — reinstall the game to fetch it again.');
      }
      const err = await openPathSmart(exe, { winePrefix: entry.winePrefix || winePrefixForTitle(entry.title) });
      if (err) return finish('needs-install', 'needs-install', `Couldn’t open setup: ${err}`);
      scheduleAdoptRetries(gameId);
      return finish('needs-exe', 'needs-exe', 'Setup opened. When it finishes, Gamehub looks for the game, or click Select launcher.');
    }
    if (res.error === 'uac-cancelled') {
      return finish('needs-install', 'needs-install', 'Setup needs administrator permission — click “Run Installer” to try again.');
    }
    if (res.cancelled) {
      return finish('needs-exe', 'needs-exe', 'Stopped watching setup — click “Select launcher” once the wizard is done.');
    }
    if (!res.ok) {
      return finish('needs-install', 'needs-install', `Setup couldn’t start (${res.error}).`);
    }

    task(gameId, 'finding-launcher', { message: 'Setup finished — finding the game…' });
    const after = await uninstallReg.snapshot();
    const found = uninstallReg.newEntries(before, after, entry.title);
    installed = loadInstalled();
    entry = installed[gameId] || entry;
    if (found.length) {
      entry.wizardDirs = [...new Set([...(entry.wizardDirs || []), ...found.map((f) => f.installDir)])];
      const u = found.find((f) => f.uninstallExe);
      if (u) entry.uninstaller = { exe: u.uninstallExe, args: u.uninstallArgs || '' };
      saveInstalled(installed);
    }

    // Repack-style DLC: nothing to launch — the base game plays it.
    if (entry.parentGameId) {
      return finish('installed', 'done', `${entry.title} setup finished.`);
    }
    const { candidates } = await launcherCandidates(gameId);
    const pick = confidentPick(candidates);
    if (pick) return await adoptLauncher(gameId, pick.path, { quiet: true });
    return finish('needs-exe', 'needs-exe', 'Setup finished — confirm which program starts the game.', { openPicker: true });
  } finally {
    job?.signal?.removeEventListener('abort', onJobAbort);
    wizardAborts.delete(gameId);
  }
}

// re-audit an install: recreate missing shortcuts, re-detect a lost exe,
// and report exactly what state things are in
ipcMain.handle('game:verify', async (e, gameId) => {
  const installed = loadInstalled();
  let entry = installed[gameId];
  if (!entry) throw new Error('Not installed.');
  entry = await healLocalEntry(gameId, entry);
  installed[gameId] = entry;

  // Release crack files that antivirus removed: put them back from the copy
  // kept with the game, then look again.
  if (entry.dir && entry.crack?.files?.length) {
    const gone = sceneRelease.missingCrackFiles(entry.dir, entry.crack.files);
    if (gone.length) {
      for (const kept of sceneRelease.keptCrackDirs(entry.dir)) sceneRelease.applyCrack(kept, entry.dir, { gameExe: entry.exe });
      await new Promise((r) => setTimeout(r, 2500));
      const still = sceneRelease.missingCrackFiles(entry.dir, entry.crack.files);
      entry.crack = { ...entry.crack, missing: still };
      saveInstalled(installed);
      if (still.length) return { ok: false, issues: [crackMissingText(still)], fixed: [] };
      return { ok: true, issues: [], fixed: [`restored ${gone.map((f) => path.basename(f)).join(', ')}`] };
    }
  }

  // Wizard may have finished — adopt the real game before complaining about setup.
  {
    const promoted = tryPromoteAfterWizard(entry, installed);
    if (promoted.changed && promoted.entry.status === 'installed') {
      installed[gameId] = promoted.entry;
      saveInstalled(installed);
      task(gameId, 'done', { message: 'Found the installed game — ready to play.' });
      if (promoted.repackDir && config.gamesDir) {
        const rel = path.relative(config.gamesDir, promoted.repackDir);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(promoted.repackDir)) {
          setTimeout(() => { offerRepackCleanup(gameId, promoted.entry.title, promoted.repackDir).catch(() => {}); }, 600);
        }
      }
      return { ok: true, issues: [], fixed: ['found installed game after setup'] };
    }
    if (promoted.changed) {
      entry = promoted.entry;
      installed[gameId] = entry;
      saveInstalled(installed);
    }
  }

  // Unfinished FitGirl/setup payloads must not "verify OK" while showing Play.
  {
    const demoted = demoteInstallerPrimary(entry);
    if (demoted.changed) {
      installed[gameId] = demoted.entry;
      saveInstalled(installed);
      task(gameId, 'needs-install', {
        message: `“${demoted.entry.title || 'Game'}” still needs its setup — click Run Installer.`,
      });
      return {
        ok: false,
        issues: ['setup has not been run yet — use Run Installer'],
        fixed: ['switched to Run Installer'],
      };
    }
    entry = demoted.entry;
  }

  // Stuck on needs-install with no auto-detected game → at least offer Select launcher.
  if (entry.status === 'needs-install' && entry.installerLaunched) {
    entry.status = 'needs-exe';
    installed[gameId] = entry;
    saveInstalled(installed);
    task(gameId, 'needs-exe', {
      message: 'Setup was opened earlier — click Select launcher to point at the installed game.',
    });
    return {
      ok: false,
      issues: ['select the game launcher after setup'],
      fixed: ['switched to Select launcher'],
    };
  }

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
  // If audit now says setup is needed, demote so the UI matches (Play only).
  if (
    entry.status === 'installed'
    && !finalAudit.ok
    && entry.dir
    && installer.isInstallerPrimary(entry.dir, entry.title || '')
  ) {
    const setup = installer.findInstaller(entry.dir);
    if (setup) {
      entry.status = 'needs-install';
      entry.mode = 'installer';
      entry.installer = setup;
      entry.exe = null;
      entry.verified = false;
      installed[gameId] = entry;
      saveInstalled(installed);
      task(gameId, 'needs-install', {
        message: `“${entry.title || 'Game'}” still needs its setup — click Run Installer.`,
      });
      return { ok: false, issues: finalAudit.issues, fixed };
    }
  }
  entry.verified = finalAudit.ok;
  installed[gameId] = entry;
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

  // Run the game's own uninstaller FIRST and wait for it — the old flow
  // launched it and immediately deleted its folder out from under it, and
  // silent installs never cleaned up their Add/Remove Programs entry.
  const fromSetup = entry.mode === 'installer' || !!entry.silentEngine || !!entry.uninstaller;
  const unins = fromSetup ? installer.findUninstaller(entry) : null;
  if (unins && !entry.inPlace) {
    // Installs Gamehub ran silently are removed silently too.
    const silent = !!entry.silentEngine;
    let args = unins.args
      || (silent ? (entry.silentEngine === 'nsis' ? '/S' : '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART') : '');
    if (silent && entry.uninstaller?.quiet) {
      // the installer registered its own quiet uninstall command — use it
      unins.exe = uninstallReg.exeFromCommand(entry.uninstaller.quiet) || unins.exe;
      args = uninstallReg.argsFromCommand(entry.uninstaller.quiet) || args;
    } else if (silent && /msiexec(\.exe)?$/i.test(unins.exe)) {
      // MSI: remove (not "modify") with a progress bar — Windows prompts for admin itself
      args = `${String(args).replace(/\/I(\s*\{)/i, '/X$1')} /qb! /norestart`;
    } else if (silent && entry.silentEngine === 'burn' && /\/uninstall/i.test(args)) {
      args = `${args} /quiet /norestart`;
    }
    task(gameId, 'uninstalling', { message: silent ? 'Removing…' : 'Running the game’s uninstaller…' });
    const run = await runGuardedInstaller(unins.exe, { args, watchDirs: [entry.dir].filter(Boolean) });
    if (run.error === 'guard-unavailable') {
      await openPathSmart(unins.exe, { winePrefix: entry.winePrefix || winePrefixForTitle(entry.title) });
    } else if (run.cancelled) {
      task(gameId, 'done', { message: 'Uninstall cancelled — nothing was removed.' });
      return false;
    }
  }
  installer.removeShortcuts(entry.shortcuts);

  // In-place serverless games ARE the user's library files — uninstall just drops
  // them from Gamehub's list; never back up into or delete from the library.
  if (!entry.inPlace) {
    // keep the game's in-folder saves in the persistent store so a later reinstall restores them
    if (entry.dir && fs.existsSync(entry.dir)) {
      backupSaves(entry.dir, savesDirFor(path.dirname(entry.dir), entry.title || sanitizeTitle(gameId)));
    }
    // delete what's left — only ever strictly inside one of the client's own
    // install roots (never the root itself, never a wizard's C:\Games\… folder)
    if (entry.dir && inInstallRoot(entry.dir)) {
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
