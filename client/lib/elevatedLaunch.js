// One-time UAC approval → Scheduled Task that launches games elevated.
// Gamehub itself stays unelevated (browser/overlay stay normal). When a game
// needs admin, we write a request and `schtasks /Run` the pre-approved task —
// no per-launch UAC.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TASK_NAME = 'GamehubElevatedLaunch';

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

function launcherPath() {
  return path.join(userDataRoot(), 'elevatedGameLauncher.ps1');
}

function materializeLauncher() {
  const bundled = path.join(__dirname, 'elevatedGameLauncher.ps1');
  const dest = launcherPath();
  const body = fs.readFileSync(bundled, 'utf8');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let same = false;
  try { same = fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === body; } catch { /* */ }
  if (!same) fs.writeFileSync(dest, body, 'utf8');
  return dest;
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
    '-NoProfile','-ExecutionPolicy','Bypass','-File', $script
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
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(wrapper, 'utf16le').toString('base64')],
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
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
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

function status() {
  return {
    supported: isWindows(),
    registered: isRegistered(),
    gamehubElevated: isProcessElevated(),
    taskName: TASK_NAME,
  };
}

async function enable() {
  if (!isWindows()) return { ok: false, error: 'unsupported' };
  const launcher = materializeLauncher();
  const bridge = bridgeDir();
  fs.mkdirSync(bridge, { recursive: true });

  const regScript = path.join(os.tmpdir(), `gamehub-register-elev-${Date.now()}.ps1`);
  const body = `
$ErrorActionPreference='Stop'
$task = ${psQuote(TASK_NAME)}
$launcher = ${psQuote(launcher)}
$bridge = ${psQuote(bridge)}
$arg = '-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '" -BridgeDir "' + $bridge + '"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null
exit 0
`;
  fs.writeFileSync(regScript, body, 'utf8');
  try {
    const r = await runPs1Elevated(regScript);
    if (r.code === 1223) return { ok: false, error: 'uac-cancelled' };
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
  if (!isRegistered()) return { ok: true, registered: false };
  const unregScript = path.join(os.tmpdir(), `gamehub-unregister-elev-${Date.now()}.ps1`);
  fs.writeFileSync(unregScript, `
$ErrorActionPreference='Stop'
Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false
exit 0
`, 'utf8');
  try {
    const r = await runPs1Elevated(unregScript);
    if (r.code === 1223) return { ok: false, error: 'uac-cancelled' };
    if (isRegistered()) return { ok: false, error: 'still-registered' };
    return { ok: true, registered: false };
  } finally {
    try { fs.unlinkSync(unregScript); } catch { /* */ }
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ask the elevated helper to start exe. Returns { ok, pid } or { ok:false, error }.
 */
async function launchElevated(exePath, { timeoutMs = 45_000 } = {}) {
  if (!isWindows()) return { ok: false, error: 'unsupported' };
  if (!isRegistered()) return { ok: false, error: 'not-registered' };
  materializeLauncher();
  const bridge = bridgeDir();
  fs.mkdirSync(bridge, { recursive: true });
  const reqPath = path.join(bridge, 'request.json');
  const respPath = path.join(bridge, 'response.json');
  try { fs.unlinkSync(respPath); } catch { /* */ }
  fs.writeFileSync(reqPath, JSON.stringify({
    exe: exePath,
    cwd: path.dirname(exePath),
    at: Date.now(),
  }), 'utf8');

  try {
    execFileSync('schtasks', ['/Run', '/TN', TASK_NAME], { stdio: 'ignore', windowsHide: true });
  } catch (err) {
    return { ok: false, error: err.message || 'schtasks-run-failed' };
  }

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (fs.existsSync(respPath)) {
        const raw = fs.readFileSync(respPath, 'utf8');
        const j = JSON.parse(raw);
        try { fs.unlinkSync(reqPath); } catch { /* */ }
        try { fs.unlinkSync(respPath); } catch { /* */ }
        if (j && j.ok && Number(j.pid) > 0) return { ok: true, pid: Number(j.pid) };
        return { ok: false, error: j?.error || 'helper-failed' };
      }
    } catch { /* still writing */ }
    await delay(150);
  }
  return { ok: false, error: 'timeout' };
}

function looksLikeElevationFailure(why) {
  const s = String(why || '');
  return /elevation|elevated|740|runas|administrat|eacces|eperm|access.denied|requires elevation/i.test(s);
}

module.exports = {
  TASK_NAME,
  status,
  enable,
  disable,
  isRegistered,
  isProcessElevated,
  launchElevated,
  looksLikeElevationFailure,
  materializeLauncher,
};
