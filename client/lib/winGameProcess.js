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
$wantName = [IO.Path]::GetFileName($want)
$dir = [IO.Path]::GetDirectoryName($want)
Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and (
    ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $want) -or
    (
      ([IO.Path]::GetFileName($_.ExecutablePath) -ieq $wantName) -and
      ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($_.ExecutablePath)) -ieq $dir)
    )
  )
} | ForEach-Object { $_.ProcessId }
`;
  const { stdout } = await runHiddenPowershell(ps, { timeoutMs: 15_000 });
  return stdout.split(/\r?\n/).map((l) => parseInt(l.trim(), 10)).filter((n) => n > 0);
}

/** CIM-based alive check — reliable for elevated PIDs (process.kill EPERM lies). */
async function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  if (!isWindows()) return processExists(pid);
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue
if ($p) { '1' } else { '0' }
`;
  const { stdout } = await runHiddenPowershell(ps, { timeoutMs: 8_000 });
  return String(stdout).trim() === '1';
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
 * Watch a game until its process (or any same-exe successor) is gone.
 * Prefers exe-path / Get-Process checks — process.kill(pid,0) is unreliable
 * against elevated games (EPERM forever / stale PIDs).
 */
function watchGamePid(pid, {
  exePath = null,
  started = Date.now(),
  onExit = null,
  onPidChange = null,
  pollMs = 2000,
  bootstrapMs = 20_000,
} = {}) {
  let current = Number(pid);
  let stopped = false;
  let timer = null;
  let miss = 0;
  const t0 = started || Date.now();
  let ticking = false;

  const finish = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    const seconds = Math.round((Date.now() - t0) / 1000);
    try { onExit?.(current, seconds); } catch { /* */ }
  };

  const adopt = (next) => {
    if (!next || next === current) return;
    current = next;
    try { onPidChange?.(current); } catch { /* */ }
  };

  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      if (exePath) {
        const live = await pidsForExe(exePath);
        if (live.length) {
          miss = 0;
          if (!live.includes(current)) adopt(live[0]);
          return;
        }
        // No matching exe — during bootstrap, keep waiting for the real game.
        if ((Date.now() - t0) < bootstrapMs) {
          miss = 0;
          return;
        }
        miss += 1;
        if (miss >= 2) finish();
        return;
      }

      const alive = await pidAlive(current);
      if (alive) {
        miss = 0;
        return;
      }
      miss += 1;
      if (miss >= 2) finish();
    } finally {
      ticking = false;
    }
  };

  timer = setInterval(() => { tick().catch(() => finish()); }, pollMs);
  // First check soon — don't wait a full poll to notice a dead bootstrapper.
  setTimeout(() => { tick().catch(() => {}); }, 400);
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
  pidAlive,
  pidsForExe,
  waitForNewPid,
  launchUnelevated,
  watchGamePid,
};
