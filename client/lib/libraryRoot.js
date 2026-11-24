// Where games live by default, and making sure Gamehub can write there.
//
// Windows follows Steam: C:\Program Files (x86)\Gamehub\games\<Game>. Program
// Files is admin-only, so — exactly like Steam's own installer does for
// C:\Program Files (x86)\Steam — Gamehub asks ONCE (one UAC prompt) to create
// its folder and give the local Users group modify rights on it. From then on
// every download, unpack and portable install writes there without elevation.
// Installers that need admin for other reasons still get their own prompt.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const isWindows = process.platform === 'win32';

function programFilesX86(env = process.env) {
  return env['ProgramFiles(x86)'] || env.ProgramFiles || 'C:\\Program Files (x86)';
}

/** The Gamehub folder (Windows: Program Files (x86)\Gamehub). */
function defaultGamehubRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') return path.win32.join(programFilesX86(env), 'Gamehub');
  return path.join(home, 'Games');
}

/** Default install location for games. */
function defaultGamesDir(opts = {}) {
  const platform = opts.platform || process.platform;
  const root = defaultGamehubRoot(opts);
  return platform === 'win32' ? path.win32.join(root, 'games') : root;
}

/** Can this process create files in dir (creating dir first if needed)? */
function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.gamehub-write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The folder to open up: for anything under Program Files that's the first
 * folder below it (…\Program Files (x86)\Gamehub), so games, staging and saves
 * all inherit the rights. Elsewhere it's the folder itself.
 */
function grantRootFor(dir, env = process.env) {
  const p = path.win32;
  const target = p.resolve(dir);
  for (const pf of [env['ProgramFiles(x86)'], env.ProgramFiles, env.ProgramW6432].filter(Boolean)) {
    const base = p.resolve(pf);
    if (target.toLowerCase().startsWith(base.toLowerCase() + '\\')) {
      return p.join(base, target.slice(base.length + 1).split('\\')[0]);
    }
  }
  return target;
}

/** PowerShell run elevated: create the folder, give Users modify (inherited). */
function grantScript(root) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$root = ${q(root)}`,
    'New-Item -ItemType Directory -Force -Path $root | Out-Null',
    // *S-1-5-32-545 = BUILTIN\\Users (language-independent). (OI)(CI) = files and
    // folders inherit it; M = modify (read/write/delete, not change permissions).
    "& icacls.exe $root /grant '*S-1-5-32-545:(OI)(CI)M' /T /C /Q | Out-Null",
    'exit $LASTEXITCODE',
  ].join('\n');
}

function encodePs(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Run the grant with ONE UAC prompt (or directly when Gamehub is already
 * elevated). Resolves { ok, error? } — error 'uac-cancelled' when declined.
 */
function runGrant(root, { elevated = false, _spawn = spawn } = {}) {
  const inner = encodePs(grantScript(root));
  const script = elevated
    ? null
    : [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      `  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${inner}'`,
      '} catch { exit 1223 }',
      'exit 0',
    ].join('\n');
  const args = elevated
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', inner]
    : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(script)];
  return new Promise((resolve) => {
    let child;
    try {
      child = _spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => resolve(code === 1223 ? { ok: false, error: 'uac-cancelled' } : { ok: true, code }));
  });
}

/**
 * Make sure Gamehub can write into dir. Writable already → nothing to do.
 * Windows + not writable → one-time elevated grant on the Gamehub folder, then
 * re-check. Returns { ok, granted?, root?, error? }.
 */
async function ensureLibraryRoot(dir, {
  platform = process.platform,
  elevated = false,
  env = process.env,
  _isWritable = isWritable,
  _runGrant = runGrant,
} = {}) {
  if (!dir) return { ok: false, error: 'no-folder' };
  if (_isWritable(dir)) return { ok: true, granted: false };
  if (platform !== 'win32') return { ok: false, error: 'not-writable' };
  const root = grantRootFor(dir, env);
  const r = await _runGrant(root, { elevated });
  if (!r.ok) return { ok: false, root, error: r.error || 'grant-failed' };
  return _isWritable(dir) ? { ok: true, granted: true, root } : { ok: false, root, error: 'not-writable' };
}

module.exports = {
  defaultGamehubRoot,
  defaultGamesDir,
  programFilesX86,
  isWritable,
  grantRootFor,
  grantScript,
  runGrant,
  ensureLibraryRoot,
  isWindows,
};
