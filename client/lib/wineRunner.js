// Linux Wine / Proton / umu helpers for running Windows .exe installers & games.
// Windows never imports the runtime path of this module for launch — platform.js
// gates on process.platform. Pure path helpers are safe to unit-test anywhere.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const WINE_CANDIDATES = ['wine64', 'wine', '/usr/bin/wine64', '/usr/bin/wine', '/usr/local/bin/wine'];
const UMU_CANDIDATES = ['umu-run', '/usr/bin/umu-run', '/usr/local/bin/umu-run'];

function which(cmd) {
  try {
    const r = spawnSync('which', [cmd], { encoding: 'utf8' });
    if (r.status === 0) {
      const p = String(r.stdout || '').trim().split('\n')[0];
      if (p && fs.existsSync(p)) return p;
    }
  } catch { /* */ }
  return null;
}

function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes('/') || c.startsWith('.')) {
      if (fs.existsSync(c)) return c;
      continue;
    }
    const hit = which(c);
    if (hit) return hit;
  }
  return null;
}

function findWineBinary() {
  return firstExisting(WINE_CANDIDATES);
}

function findUmuBinary() {
  return firstExisting(UMU_CANDIDATES);
}

/** Common Steam / Proton install roots on Linux. */
function steamRoots() {
  const home = os.homedir();
  return [
    path.join(home, '.steam', 'steam'),
    path.join(home, '.steam', 'root'),
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
    '/usr/share/steam',
  ].filter((p) => fs.existsSync(p));
}

/** Locate a Proton runner script under Steam common (prefer newest Proton folder). */
function findProtonBinary() {
  const found = [];
  for (const root of steamRoots()) {
    const common = path.join(root, 'steamapps', 'common');
    if (!fs.existsSync(common)) continue;
    let ents;
    try { ents = fs.readdirSync(common, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (!/^Proton/i.test(e.name)) continue;
      const proton = path.join(common, e.name, 'proton');
      if (fs.existsSync(proton)) found.push({ name: e.name, path: proton, steam: root });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' }));
  return found[0];
}

/**
 * Convert an absolute Linux path to a Wine Z: path (default Z: → /).
 * Does not shell out — deterministic for silent-install argv.
 */
function toWinePath(linuxPath) {
  const abs = path.resolve(String(linuxPath || ''));
  // Wine on Linux maps Z: to the Unix root by default.
  return `Z:${abs.replace(/\//g, '\\')}`;
}

function sanitizePrefixKey(key) {
  let s = String(key || 'default')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .trim()
    .slice(0, 80);
  // Reject empty / dot / parent refs so the prefix cannot escape _wineprefixes.
  if (!s || s === '.' || s === '..' || /^\.+$/.test(s)) s = 'default';
  return s;
}

/**
 * Per-game (or shared) Wine prefix under the Library. Never inside the install
 * target itself — installers write there.
 */
function winePrefixPath(baseDir, key = 'default') {
  const root = baseDir && String(baseDir)
    ? path.resolve(baseDir)
    : path.join(os.homedir(), '.local', 'share', 'gamehub');
  const prefixesRoot = path.join(root, '_wineprefixes');
  const resolved = path.resolve(prefixesRoot, sanitizePrefixKey(key));
  // Belt-and-suspenders: must stay under _wineprefixes.
  if (resolved !== prefixesRoot && !resolved.startsWith(prefixesRoot + path.sep)) {
    return path.join(prefixesRoot, 'default');
  }
  return resolved;
}

/**
 * Convert a Linux path for use as an installer target under Wine.
 * NSIS `/D=` must stay unquoted on the Windows command line — Wine re-quotes
 * argv that contain spaces, which breaks NSIS. For spaced targets we create a
 * temporary space-free symlink and return its Z: path (caller must cleanup).
 *
 * Returns { winePath, cleanupLink|null }.
 */
function wineInstallTarget(linuxPath, { nsis = false } = {}) {
  const abs = path.resolve(String(linuxPath || ''));
  fs.mkdirSync(abs, { recursive: true });
  if (!nsis || !/\s/.test(abs)) {
    return { winePath: toWinePath(abs), cleanupLink: null };
  }
  // Prefer a space-free parent for the symlink. os.tmpdir() can itself contain
  // spaces on some hosts, which would reintroduce the Wine quoting problem.
  const linkRoot = (!/\s/.test(os.tmpdir()) && os.tmpdir()) || '/tmp';
  const link = path.join(
    linkRoot,
    `gamehub-nsis-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    fs.symlinkSync(abs, link);
  } catch (err) {
    // Fall back to long path — better than failing before spawn; may still break
    // real NSIS, but Inno-style CRT parsers tolerate quoted /D=.
    return { winePath: toWinePath(abs), cleanupLink: null, symlinkError: err.message };
  }
  return { winePath: toWinePath(link), cleanupLink: link };
}

function ensureWinePrefix(prefixDir, { wineBin = null } = {}) {
  fs.mkdirSync(prefixDir, { recursive: true });
  const systemReg = path.join(prefixDir, 'system.reg');
  if (fs.existsSync(systemReg)) return prefixDir;
  const bin = wineBin || findWineBinary();
  if (!bin) return prefixDir;
  // First-time init — quiet, non-interactive.
  try {
    spawnSync(bin, ['wineboot', '-u'], {
      env: {
        ...process.env,
        WINEPREFIX: prefixDir,
        WINEARCH: 'win64',
        WINEDLLOVERRIDES: 'winemenubuilder.exe=d',
        WINEDEBUG: '-all',
        DISPLAY: process.env.DISPLAY || '',
      },
      timeout: 120_000,
      stdio: 'ignore',
    });
  } catch { /* prefix still usable; wine will init on first run */ }
  return prefixDir;
}

/**
 * Resolve how to wrap a Windows .exe on this Linux host.
 * Returns { kind, cmd, argsBefore, env, available, label }.
 */
function resolveRunner(config = {}, { prefixDir = null, forInstall = false } = {}) {
  const preferred = String(config.linuxRunner || 'wine').toLowerCase();
  const wineBin = findWineBinary();
  const umu = findUmuBinary();
  const proton = findProtonBinary();

  const baseEnv = {
    WINEDEBUG: '-all',
    WINEDLLOVERRIDES: 'winemenubuilder.exe=d',
  };
  if (prefixDir) {
    baseEnv.WINEPREFIX = prefixDir;
    baseEnv.WINEARCH = 'win64';
  }

  const tryOrder = [];
  if (preferred === 'umu') tryOrder.push('umu', 'proton', 'wine');
  else if (preferred === 'proton') tryOrder.push('proton', 'umu', 'wine');
  else tryOrder.push('wine', 'umu', 'proton');
  // Silent installers are most reliable under plain Wine (Inno/NSIS argv).
  // Do NOT fall back to Proton/umu for install — their prefix layout differs
  // (STEAM_COMPAT_DATA_PATH/pfx) and we pin silent installs to Wine for play.
  if (forInstall) {
    if (wineBin) {
      return {
        kind: 'wine',
        cmd: wineBin,
        argsBefore: [],
        env: baseEnv,
        available: true,
        label: 'Wine',
        wineBin,
      };
    }
    return {
      kind: 'wine',
      cmd: null,
      argsBefore: [],
      env: baseEnv,
      available: false,
      label: 'wine',
      wineBin: null,
    };
  }

  for (const kind of tryOrder) {
    if (kind === 'wine' && wineBin) {
      return {
        kind: 'wine',
        cmd: wineBin,
        argsBefore: [],
        env: baseEnv,
        available: true,
        label: 'Wine',
        wineBin,
      };
    }
    if (kind === 'umu' && umu) {
      const env = { ...baseEnv };
      if (prefixDir) env.STEAM_COMPAT_DATA_PATH = prefixDir;
      return {
        kind: 'umu',
        cmd: umu,
        argsBefore: [],
        env,
        available: true,
        label: 'umu-launcher',
        wineBin,
      };
    }
    if (kind === 'proton' && proton) {
      const compat = prefixDir || winePrefixPath(os.homedir(), 'proton-default');
      fs.mkdirSync(compat, { recursive: true });
      return {
        kind: 'proton',
        cmd: proton.path,
        argsBefore: ['run'],
        env: {
          ...baseEnv,
          STEAM_COMPAT_DATA_PATH: compat,
          STEAM_COMPAT_CLIENT_INSTALL_PATH: proton.steam,
        },
        available: true,
        label: proton.name,
        wineBin,
        proton,
      };
    }
  }

  return {
    kind: preferred,
    cmd: null,
    argsBefore: [],
    env: baseEnv,
    available: false,
    label: preferred,
    wineBin: wineBin || null,
  };
}

function hasCompatibleRunner(config = {}) {
  return resolveRunner(config).available;
}

/**
 * Build { cmd, args, cwd, env } to launch a Windows game/installer exe under Wine.
 */
function launchWindowsExe(exePath, config = {}, { prefixDir = null, extraArgs = [], forInstall = false } = {}) {
  const abs = path.resolve(exePath);
  const prefix = prefixDir || config.winePrefix || null;
  if (prefix && (config.linuxRunner || 'wine') === 'wine') {
    ensureWinePrefix(prefix, { wineBin: findWineBinary() });
  }
  const runner = resolveRunner(config, { prefixDir: prefix, forInstall });
  if (!runner.available) {
    const err = new Error(
      'No Wine/Proton runner found. Install wine (or Steam Proton / umu-launcher) to play Windows games on Linux.'
    );
    err.code = 'NO_WINE';
    throw err;
  }
  return {
    cmd: runner.cmd,
    args: [...runner.argsBefore, abs, ...extraArgs],
    cwd: path.dirname(abs),
    env: { ...process.env, ...runner.env },
    runner,
  };
}

/**
 * Spawn a Windows .exe via Wine/Proton (wizard / uninstall / play fallback).
 * Returns the ChildProcess.
 */
function spawnWindowsExe(exePath, config = {}, opts = {}) {
  const launch = launchWindowsExe(exePath, config, {
    prefixDir: opts.prefixDir || config.winePrefix || null,
    extraArgs: opts.extraArgs || [],
    forInstall: !!opts.forInstall,
  });
  return spawn(launch.cmd, launch.args, {
    cwd: opts.cwd || launch.cwd,
    env: launch.env,
    detached: opts.detached !== false,
    stdio: opts.stdio || 'ignore',
  });
}

module.exports = {
  findWineBinary,
  findUmuBinary,
  findProtonBinary,
  steamRoots,
  toWinePath,
  wineInstallTarget,
  winePrefixPath,
  ensureWinePrefix,
  resolveRunner,
  hasCompatibleRunner,
  launchWindowsExe,
  spawnWindowsExe,
  sanitizePrefixKey,
};
