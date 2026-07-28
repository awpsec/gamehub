// One-time UAC approval → Scheduled Task that launches games elevated (and
// optionally Gamehub itself via GamehubElevatedApp). Unelevated Gamehub drops
// a request and `schtasks /Run` the pre-approved task — no per-launch UAC.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TASK_NAME = 'GamehubElevatedLaunch';
const APP_TASK_NAME = 'GamehubElevatedApp';

/** Serialize launch/capture so they don't clobber the shared request/response files. */
let bridgeChain = Promise.resolve();
function withBridge(fn) {
  const run = bridgeChain.then(() => fn(), () => fn());
  bridgeChain = run.then(() => {}, () => {});
  return run;
}

let elevCache = { at: 0, value: false };
let statusCache = { at: 0, value: null };
const CACHE_MS = 2500;

function invalidateStatusCache() {
  elevCache = { at: 0, value: false };
  statusCache = { at: 0, value: null };
}

function userDataRoot() {
  try {
    // Lazy: unit tests import this module without Electron.
    const { app } = require('electron');
    if (app?.getPath) return app.getPath('userData');
  } catch { /* not in Electron */ }
  return path.join(os.tmpdir(), 'gamehub-elevated-launch-test');
}

function isWindows() {
  return process.platform === 'win32';
}

function bridgeDir() {
  return path.join(userDataRoot(), 'elevated-launch');
}

function launcherPs1Path() {
  return path.join(userDataRoot(), 'elevatedGameLauncher.ps1');
}

function launcherVbsPath() {
  return path.join(userDataRoot(), 'elevatedGameLauncher.vbs');
}

function materializeLauncher() {
  const destDir = userDataRoot();
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of ['elevatedGameLauncher.ps1', 'elevatedGameLauncher.vbs']) {
    const bundled = path.join(__dirname, name);
    const dest = path.join(destDir, name);
    const body = fs.readFileSync(bundled, 'utf8');
    let same = false;
    try { same = fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === body; } catch { /* */ }
    if (!same) fs.writeFileSync(dest, body, 'utf8');
  }
  return { ps1: launcherPs1Path(), vbs: launcherVbsPath() };
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Run a .ps1 elevated via UAC; resolves with the script's exit code (1223 = cancel). */
function runPs1Elevated(scriptPath, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const done = path.join(os.tmpdir(), `gamehub-elev-ps-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    try { fs.unlinkSync(done); } catch { /* */ }
    const wrapper = `
$ErrorActionPreference='Stop'
$done=${psQuote(done)}
$script=${psQuote(scriptPath)}
try {
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File', $script
  )
  $code = if ($null -eq $p.ExitCode) { 1 } else { [int]$p.ExitCode }
  Set-Content -LiteralPath $done -Value ([string]$code) -Encoding ASCII
} catch {
  # 1223 = UAC declined / Start-Process -Verb RunAs threw
  Set-Content -LiteralPath $done -Value '1223' -Encoding ASCII
}
`;
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(wrapper, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: 'ignore' }
      );
    } catch (err) {
      resolve({ code: 1, error: err.message });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* */ }
      resolve({ code: 1, error: 'timeout' });
    }, timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      let code = 1;
      try {
        code = parseInt(fs.readFileSync(done, 'utf8').trim(), 10);
        if (!Number.isFinite(code)) code = 1;
      } catch { code = 1223; }
      try { fs.unlinkSync(done); } catch { /* */ }
      resolve({ code });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, error: err.message });
    });
  });
}

/** Is this Gamehub process already running elevated? */
function isProcessElevated() {
  if (!isWindows()) return false;
  const now = Date.now();
  if (now - elevCache.at < CACHE_MS) return elevCache.value;
  let value = false;
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
    value = true;
  } catch {
    value = false;
  }
  elevCache = { at: now, value };
  return value;
}

function isRegistered() {
  if (!isWindows()) return false;
  try {
    execFileSync('schtasks', ['/Query', '/TN', TASK_NAME], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** True when an older helper task still launches powershell.exe (console flash). */
function taskNeedsSilentUpgrade(registered = null) {
  const yes = registered == null ? isRegistered() : !!registered;
  if (!yes) return false;
  try {
    const xml = execFileSync('schtasks', ['/Query', '/TN', TASK_NAME, '/XML'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8_000,
    });
    return !/wscript\.exe/i.test(String(xml));
  } catch {
    return false;
  }
}

function status() {
  if (!isWindows()) {
    return {
      supported: false,
      registered: false,
      appTaskRegistered: false,
      gamehubElevated: false,
      needsSilentUpgrade: false,
      taskName: TASK_NAME,
    };
  }
  const now = Date.now();
  if (statusCache.value && now - statusCache.at < CACHE_MS) return statusCache.value;
  const registered = isRegistered();
  const value = {
    supported: true,
    registered,
    appTaskRegistered: isAppTaskRegistered(),
    gamehubElevated: isProcessElevated(),
    needsSilentUpgrade: taskNeedsSilentUpgrade(registered),
    taskName: TASK_NAME,
  };
  statusCache = { at: now, value };
  return value;
}

function writeRegisterScript(regScript, vbs, bridge, appExe) {
  const body = `
$ErrorActionPreference='Stop'
$task = ${psQuote(TASK_NAME)}
$appTask = ${psQuote(APP_TASK_NAME)}
$exe = 'wscript.exe'
$arg = '//B //Nologo "' + ${psQuote(vbs)} + '" "' + ${psQuote(bridge)} + '"'
$action = New-ScheduledTaskAction -Execute $exe -Argument $arg
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Hidden
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null
# Optional: restart Gamehub itself elevated (overlay can cover admin games).
$appExe = ${psQuote(appExe)}
if ($appExe -and (Test-Path -LiteralPath $appExe)) {
  $appAction = New-ScheduledTaskAction -Execute $appExe
  $appSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 12) -Hidden
  Unregister-ScheduledTask -TaskName $appTask -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
  Register-ScheduledTask -TaskName $appTask -Action $appAction -Principal $principal -Settings $appSettings -Force | Out-Null
}
exit 0
`;
  fs.writeFileSync(regScript, body, 'utf8');
}

function packagedGamehubExe() {
  try {
    const { app } = require('electron');
    if (app?.isPackaged) return process.execPath;
  } catch { /* */ }
  return process.execPath;
}

async function enable() {
  if (!isWindows()) return { ok: false, error: 'unsupported' };
  const { vbs } = materializeLauncher();
  const bridge = bridgeDir();
  fs.mkdirSync(bridge, { recursive: true });

  const regScript = path.join(os.tmpdir(), `gamehub-register-elev-${Date.now()}.ps1`);
  writeRegisterScript(regScript, vbs, bridge, packagedGamehubExe());
  try {
    const r = await runPs1Elevated(regScript);
    if (r.code === 1223) return { ok: false, error: 'uac-cancelled' };
    invalidateStatusCache();
    if (r.code !== 0 || !isRegistered()) {
      return { ok: false, error: r.error || `exit ${r.code}` };
    }
    return { ok: true, registered: true };
  } finally {
    try { fs.unlinkSync(regScript); } catch { /* */ }
  }
}

async function disable() {
  if (!isWindows()) return { ok: false, error: 'unsupported' };
  if (!isRegistered() && !isAppTaskRegistered()) return { ok: true, registered: false };
  const unregScript = path.join(os.tmpdir(), `gamehub-unregister-elev-${Date.now()}.ps1`);
  fs.writeFileSync(unregScript, `
$ErrorActionPreference='Stop'
Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName ${psQuote(APP_TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue
exit 0
`, 'utf8');
  try {
    const r = await runPs1Elevated(unregScript);
    if (r.code === 1223) return { ok: false, error: 'uac-cancelled' };
    invalidateStatusCache();
    if (isRegistered()) return { ok: false, error: 'still-registered' };
    // Shortcuts may still point at schtasks — retarget to the exe.
    try { await syncAppShortcuts({ elevated: false }); } catch { /* */ }
    return { ok: true, registered: false };
  } finally {
    try { fs.unlinkSync(unregScript); } catch { /* */ }
  }
}

function isAppTaskRegistered() {
  if (!isWindows()) return false;
  try {
    execFileSync('schtasks', ['/Query', '/TN', APP_TASK_NAME], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseResponseFile(respPath) {
  const raw = fs.readFileSync(respPath, 'utf8').replace(/^\uFEFF/, '').trim();
  return JSON.parse(raw);
}

/**
 * Ask the elevated helper to start exe.
 * Returns { ok, pid } on success, or { ok:false, error, ran:true } if schtasks
 * fired (game may already be starting — caller must NOT ShellExecute again).
 */
async function launchElevated(exePath, { timeoutMs = 20_000, beforePids = null } = {}) {
  return withBridge(() => launchElevatedUnlocked(exePath, { timeoutMs, beforePids }));
}

async function launchElevatedUnlocked(exePath, { timeoutMs = 20_000, beforePids = null } = {}) {
  if (!isWindows()) return { ok: false, error: 'unsupported', ran: false };
  if (!isRegistered()) return { ok: false, error: 'not-registered', ran: false };
  materializeLauncher();
  const winGameProcess = require('./winGameProcess');
  const bridge = bridgeDir();
  fs.mkdirSync(bridge, { recursive: true });
  const reqPath = path.join(bridge, 'request.json');
  const respPath = path.join(bridge, 'response.json');
  try { fs.unlinkSync(respPath); } catch { /* */ }

  const before = Array.isArray(beforePids)
    ? beforePids.map(Number).filter((n) => n > 0)
    : await winGameProcess.pidsForExe(exePath).catch(() => []);

  fs.writeFileSync(reqPath, JSON.stringify({
    action: 'launch',
    exe: exePath,
    cwd: path.dirname(exePath),
    at: Date.now(),
  }), 'utf8');

  try {
    execFileSync('schtasks', ['/Run', '/TN', TASK_NAME], { stdio: 'ignore', windowsHide: true });
  } catch (err) {
    return { ok: false, error: err.message || 'schtasks-run-failed', ran: false };
  }

  const beforeSet = new Set(before);
  const t0 = Date.now();
  let lastPidPoll = 0;
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (fs.existsSync(respPath)) {
        const j = parseResponseFile(respPath);
        try { fs.unlinkSync(reqPath); } catch { /* */ }
        try { fs.unlinkSync(respPath); } catch { /* */ }
        if (j && j.ok && Number(j.pid) > 0) return { ok: true, pid: Number(j.pid), ran: true };
        // Helper responded with failure — still don't double-launch via openPath.
        return { ok: false, error: j?.error || 'helper-failed', ran: true };
      }
    } catch { /* BOM / partial write — keep waiting */ }

    // Parallel adopt (less often than response polls — CIM scans are expensive).
    const nowMs = Date.now();
    if (nowMs - lastPidPoll >= 900) {
      lastPidPoll = nowMs;
      try {
        const now = await winGameProcess.pidsForExe(exePath);
        const neu = now.find((p) => !beforeSet.has(p));
        if (neu) {
          try { fs.unlinkSync(reqPath); } catch { /* */ }
          try { fs.unlinkSync(respPath); } catch { /* */ }
          return { ok: true, pid: neu, ran: true };
        }
      } catch { /* */ }
    }

    await delay(100);
  }
  return { ok: false, error: 'timeout', ran: true };
}

/** Elevated GDI capture into outPath (PNG). Used when the game runs elevated. */
async function captureScreen(outPath, opts = {}) {
  return withBridge(() => captureScreenUnlocked(outPath, opts));
}

async function captureScreenUnlocked(outPath, { timeoutMs = 20_000, bounds = null } = {}) {
  if (!isWindows()) return { ok: false, error: 'unsupported' };
  if (!isRegistered()) return { ok: false, error: 'not-registered' };
  materializeLauncher();
  const bridge = bridgeDir();
  fs.mkdirSync(bridge, { recursive: true });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const reqPath = path.join(bridge, 'request.json');
  const respPath = path.join(bridge, 'response.json');
  try { fs.unlinkSync(respPath); } catch { /* */ }
  try { fs.unlinkSync(outPath); } catch { /* */ }
  const req = {
    action: 'capture',
    outPath,
    at: Date.now(),
  };
  // Match unelevated capture: one display, not the full virtual desktop.
  if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) {
    req.x = Math.round(bounds.x);
    req.y = Math.round(bounds.y);
    req.w = Math.max(1, Math.round(bounds.width));
    req.h = Math.max(1, Math.round(bounds.height));
  }
  fs.writeFileSync(reqPath, JSON.stringify(req), 'utf8');
  try {
    execFileSync('schtasks', ['/Run', '/TN', TASK_NAME], { stdio: 'ignore', windowsHide: true });
  } catch (err) {
    return { ok: false, error: err.message || 'schtasks-run-failed' };
  }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (fs.existsSync(respPath)) {
        const j = parseResponseFile(respPath);
        try { fs.unlinkSync(reqPath); } catch { /* */ }
        try { fs.unlinkSync(respPath); } catch { /* */ }
        if (j?.ok && fs.existsSync(outPath)) return { ok: true, file: outPath };
        return { ok: false, error: j?.error || 'capture-failed' };
      }
    } catch { /* */ }
    await delay(100);
  }
  return { ok: false, error: 'timeout' };
}

/** Restart Gamehub elevated via the pre-approved app task (no UAC). */
function restartElevatedApp() {
  if (!isWindows()) return { ok: false, error: 'unsupported' };
  if (!isAppTaskRegistered()) return { ok: false, error: 'not-registered' };
  try {
    execFileSync('schtasks', ['/Run', '/TN', APP_TASK_NAME], { stdio: 'ignore', windowsHide: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'schtasks-run-failed' };
  }
}

/**
 * Drop elevation: start an unelevated Gamehub via explorer.exe (elevated
 * parents otherwise spawn elevated children), then caller should quit.
 */
function restartUnelevatedApp() {
  if (!isWindows()) return { ok: false, error: 'unsupported' };
  const exe = packagedGamehubExe();
  try {
    spawn('explorer.exe', [exe], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'restart-failed' };
  }
}

/** Retarget Desktop / Start Menu Gamehub.lnk to schtasks (elevated) or the exe. */
function syncAppShortcuts({ elevated = false } = {}) {
  if (!isWindows()) return { ok: false, error: 'unsupported' };
  const exe = packagedGamehubExe();
  const desktop = path.join(os.homedir(), 'Desktop', 'Gamehub.lnk');
  const startMenu = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Gamehub.lnk'
  );
  const targets = [desktop, startMenu];
  const ps = `
$ErrorActionPreference='Stop'
$exe = ${psQuote(exe)}
$elevated = $${elevated ? 'true' : 'false'}
$task = ${psQuote(APP_TASK_NAME)}
$ws = New-Object -ComObject WScript.Shell
foreach ($link in @(${targets.map(psQuote).join(',')})) {
  try {
    $dir = Split-Path -Parent $link
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $s = $ws.CreateShortcut($link)
    if ($elevated) {
      $s.TargetPath = (Join-Path $env:SystemRoot 'System32\\schtasks.exe')
      $s.Arguments = '/Run /TN "' + $task + '"'
      $s.WorkingDirectory = Split-Path -Parent $exe
    } else {
      $s.TargetPath = $exe
      $s.Arguments = ''
      $s.WorkingDirectory = Split-Path -Parent $exe
    }
    $s.IconLocation = $exe + ',0'
    $s.Description = 'Gamehub'
    $s.Save()
  } catch { }
}
`;
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore' }
    );
    child.on('exit', (code) => resolve({ ok: code === 0 }));
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

function looksLikeElevationFailure(why) {
  const s = String(why || '');
  return /elevation|elevated|740|runas|administrat|eacces|eperm|access.denied|requires elevation/i.test(s);
}

module.exports = {
  TASK_NAME,
  APP_TASK_NAME,
  status,
  enable,
  disable,
  isRegistered,
  isAppTaskRegistered,
  isProcessElevated,
  taskNeedsSilentUpgrade,
  launchElevated,
  captureScreen,
  restartElevatedApp,
  restartUnelevatedApp,
  syncAppShortcuts,
  looksLikeElevationFailure,
  materializeLauncher,
};
