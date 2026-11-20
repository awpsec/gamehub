// Where did a setup wizard actually put the game?
//
// Inno Setup, NSIS and most repack installers register an "Uninstall" key
// (Add/Remove Programs) with InstallLocation + UninstallString. Snapshot those
// keys before a wizard runs, diff afterwards, and we know the real install
// folder — even when the user (or FitGirl's default) picked C:\Games\…, far
// outside Gamehub's games folder — plus the game's own uninstaller.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const platform = require('./platform');
const { folderMatchesGame } = require('./installer');

const ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

// Runtime installers a repack kicks off — never "the game".
const REDIST_NAME = /visual c\+\+|vc_?redist|directx|\.net (framework|runtime|desktop)|redistributable|physx|openal|xna framework|windows sdk/i;

const FIELD = {
  displayname: 'displayName',
  displayversion: 'displayVersion',
  installlocation: 'installLocation',
  'inno setup: app path': 'innoAppPath',
  uninstallstring: 'uninstallString',
  quietuninstallstring: 'quietUninstallString',
  displayicon: 'displayIcon',
};

/** Parse `reg query <root> /s` output → Map(keyPath → fields). */
function parseRegQuery(text) {
  const out = new Map();
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (/^HKEY_/i.test(raw)) {
      cur = { key: raw.trim() };
      out.set(cur.key.toLowerCase(), cur);
      continue;
    }
    if (!cur) continue;
    const m = raw.match(/^\s+(.+?)\s+(REG_[A-Z_]+)\s*(.*)$/);
    if (!m) continue;
    const field = FIELD[m[1].trim().toLowerCase()];
    if (field) cur[field] = m[3].trim();
  }
  return out;
}

/** Executable path from an UninstallString / DisplayIcon value. */
function exeFromCommand(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return null;
  let exe;
  if (s.startsWith('"')) exe = s.slice(1, s.indexOf('"', 1) > 0 ? s.indexOf('"', 1) : undefined);
  else {
    const m = s.match(/^(.*?\.exe)\b/i);
    exe = m ? m[1] : null;
  }
  if (!exe || /msiexec/i.test(path.win32.basename(exe))) return null;
  return exe.replace(/,\s*-?\d+$/, ''); // DisplayIcon "…\game.exe,0"
}

function argsFromCommand(cmd) {
  const s = String(cmd || '').trim();
  const exe = exeFromCommand(s);
  if (!exe) return '';
  const idx = s.toLowerCase().indexOf(exe.toLowerCase());
  return s.slice(idx + exe.length).replace(/^"/, '').trim();
}

function installDirOf(e) {
  const clean = (p) => (p ? String(p).replace(/^"|"$/g, '').replace(/[\\/]+$/, '') : null);
  const candidates = [
    clean(e.installLocation),
    clean(e.innoAppPath),
    // Inno puts unins000.exe in the app root — its folder is the install dir
    exeFromCommand(e.uninstallString) && /unins\d*\.exe$/i.test(exeFromCommand(e.uninstallString))
      ? path.win32.dirname(exeFromCommand(e.uninstallString)) : null,
  ].filter(Boolean);
  return candidates[0] || null;
}

function runReg(root) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', root, '/s'], {
      windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 20000,
    }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
  });
}

/** Snapshot every Uninstall key (Windows only; empty Map elsewhere). */
async function snapshot({ _isWindows = platform.isWindows, _run = runReg } = {}) {
  const all = new Map();
  if (!_isWindows) return all;
  const texts = await Promise.all(ROOTS.map((r) => _run(r).catch(() => '')));
  for (const t of texts) for (const [k, v] of parseRegQuery(t)) all.set(k, v);
  return all;
}

/**
 * Entries the wizard created or changed, plus any whose name matches the game
 * (a reinstall over the same AppId keeps the same key). Redists are dropped;
 * title matches sort first. Each item: { key, displayName, installDir,
 * uninstallExe, uninstallArgs, quietUninstall }.
 */
function newEntries(before, after, title = '', { _exists = fs.existsSync } = {}) {
  const hits = [];
  for (const [k, e] of after) {
    if (!e.displayName || REDIST_NAME.test(e.displayName)) continue;
    const prev = before.get(k);
    const changed = !prev
      || (prev.installLocation || '') !== (e.installLocation || '')
      || (prev.displayVersion || '') !== (e.displayVersion || '')
      || (prev.uninstallString || '') !== (e.uninstallString || '');
    const named = !!title && folderMatchesGame(e.displayName, title);
    if (!changed && !named) continue;
    const installDir = installDirOf(e);
    if (!installDir || !_exists(installDir)) continue;
    hits.push({
      key: e.key,
      displayName: e.displayName,
      installDir,
      uninstallExe: exeFromCommand(e.uninstallString),
      uninstallArgs: argsFromCommand(e.uninstallString),
      quietUninstall: e.quietUninstallString || null,
      named,
      fresh: changed,
    });
  }
  hits.sort((a, b) => (Number(b.named) - Number(a.named)) || (Number(b.fresh) - Number(a.fresh)));
  return hits;
}

module.exports = {
  ROOTS,
  parseRegQuery,
  exeFromCommand,
  argsFromCommand,
  installDirOf,
  snapshot,
  newEntries,
};
