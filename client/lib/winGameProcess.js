// Windows game process helpers — find / watch a game after ShellExecute-style
// launches (no ChildProcess handle), and prefer a non-elevating start so the
// Compatibility-tab "Run as administrator" checkbox doesn't force a UAC prompt
// on every Play click.
const { spawn } = require('node:child_process');
const path = require('node:path');

function isWindows() {
  return process.platform === 'win32';
}

function runHiddenPowershell(script, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code, stdout) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 1, stdout: String(stdout || '').trim() });
    };
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      );
    } catch {
      finish(1, '');
      return;
    }
    let out = '';
    child.stdout?.on('data', (d) => { out += d; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* */ }
      finish(1, out);
    }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); finish(code, out); });
    child.on('error', () => { clearTimeout(timer); finish(1, out); });
  });
}

/** True if pid looks alive. EPERM/EACCES ⇒ elevated-but-alive (same as silentInstall). */
function processExists(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err && err.code;
    if (code === 'EPERM' || code === 'EACCES') return true;
    return false;
  }
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Snapshot PIDs whose ExecutablePath matches exePath (case-insensitive). */
async function pidsForExe(exePath) {
  if (!isWindows() || !exePath) return [];
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$want = [IO.Path]::GetFullPath(${psQuote(exePath)})
Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $want)
} | ForEach-Object { $_.ProcessId }
`;
  const { stdout } = await runHiddenPowershell(ps, { timeoutMs: 15_000 });
  return stdout.split(/\r?\n/).map((l) => parseInt(l.trim(), 10)).filter((n) => n > 0);
}

/**
 * Wait for a new process running exePath that wasn't in beforePids.
 * Also accepts same-folder exes with the same basename (some Unity boots swap).
 */
async function waitForNewPid(exePath, beforePids = [], {
  timeoutMs = 45_000,
  pollMs = 400,
} = {}) {
  if (!isWindows() || !exePath) return null;
  const before = new Set((beforePids || []).map(Number));
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$want = [IO.Path]::GetFullPath(${psQuote(exePath)})
$wantName = [IO.Path]::GetFileName($want)
$dir = [IO.Path]::GetDirectoryName($want)
$deadline = (Get-Date).AddMilliseconds(${Number(timeoutMs)})
$before = @(${[...before].map(Number).filter((n) => n > 0).join(',')})
while ((Get-Date) -lt $deadline) {
  $hits = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and (
      ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $want) -or
      (
        ([IO.Path]::GetFileName($_.ExecutablePath) -ieq $wantName) -and
        ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($_.ExecutablePath)) -ieq $dir)
      )
    )
  })
  foreach ($h in $hits) {
    if ($before -notcontains $h.ProcessId) {
      Write-Output $h.ProcessId
      exit 0
    }
  }
  Start-Sleep -Milliseconds ${Number(pollMs)}
}
exit 1
`;
  const { code, stdout } = await runHiddenPowershell(ps, { timeoutMs: timeoutMs + 5_000 });
  if (code !== 0) return null;
  const pid = parseInt(String(stdout).trim().split(/\r?\n/)[0], 10);
  return pid > 0 ? pid : null;
}

/**
 * Start exe without forcing elevation.
 * explorer.exe hand-off ignores the Compatibility "Run as administrator" flag
 * (which otherwise makes ShellExecute UAC every launch). Embedded
 * requireAdministrator manifests still prompt — nothing we can do there.
 */
async function launchUnelevated(exePath) {
  if (!isWindows() || !exePath) return false;
  const cwd = path.dirname(exePath);
  // explorer.exe "<fullpath>" — documented bypass for compat-RunAsAdmin.
  const viaExplorer = `
$ErrorActionPreference='Stop'
Start-Process -FilePath 'explorer.exe' -ArgumentList ${psQuote(exePath)}
`;
  const r1 = await runHiddenPowershell(viaExplorer, { timeoutMs: 10_000 });
  if (r1.code === 0) return true;
  const viaStart = `
$ErrorActionPreference='Stop'
Start-Process -FilePath ${psQuote(exePath)} -WorkingDirectory ${psQuote(cwd)}
`;
  const r2 = await runHiddenPowershell(viaStart, { timeoutMs: 10_000 });
  return r2.code === 0;
}

/**
 * Watch pid (and briefly re-adopt a successor if the first process is a
 * short-lived bootstrapper). Calls onExit(finalPid, seconds) once the game is gone.
 * Returns a stop() function.
 */
function watchGamePid(pid, {
  exePath = null,
  started = Date.now(),
  onExit = null,
  pollMs = 2000,
  bootstrapMs = 12_000,
} = {}) {
  let current = Number(pid);
  let stopped = false;
  let timer = null;
  const t0 = started || Date.now();

  const finish = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    const seconds = Math.round((Date.now() - t0) / 1000);
    try { onExit?.(current, seconds); } catch { /* */ }
  };

  const tick = async () => {
    if (stopped) return;
    if (processExists(current)) return;
    // Bootstrapper died quickly — try to adopt a successor once.
    if (exePath && (Date.now() - t0) < bootstrapMs) {
      const next = await waitForNewPid(exePath, [current], { timeoutMs: 8_000, pollMs: 300 });
      if (next && next !== current) {
        current = next;
        return;
      }
    }
    finish();
  };

  timer = setInterval(() => { tick().catch(() => finish()); }, pollMs);
  return {
    get pid() { return current; },
    /** Stop watching without treating it as a game exit (spawn path owns exit). */
    cancel() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
    },
    stop: finish,
  };
}

module.exports = {
  processExists,
  pidsForExe,
  waitForNewPid,
  launchUnelevated,
  watchGamePid,
};
