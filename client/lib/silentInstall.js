// Silent installer driver — high-confidence Inno Setup only (v1).
// Separate payloadDir (setup + bins) from targetDir (final game). Store never touched.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { fingerprintInstaller } = require('./fingerprint');
const { isInside } = require('./localCopy');
const installer = require('./installer');
const platform = require('./platform');

/** Optional Inno [Tasks] FitGirl/repacks commonly offer — deselect via /MERGETASKS. */
const INNO_EXTRA_TASK_DENYLIST = [
  'desktopicon',
  'quicklaunchicon',
  'directx',
  'dx',
  'dxsetup',
  'dxwebsetup',
  'installdirectx',
  'updatedirectx',
  'vcredist',
  'vcredistx86',
  'vcredistx64',
  'vcredist_x86',
  'vcredist_x64',
  'vc_redist',
  'redist',
  'openal',
  'dotnet',
  'physx',
  'website',
  'visitwebsite',
  'fitgirl',
];

/** Build Inno Setup argv. Each flag is its own array element — never shell-joined. */
function buildInnoArgs(targetDir, logPath) {
  // /TASKS= clears every optional task (DirectX, VC++, icons, promo) when the
  // repack maps those checkboxes to Inno tasks. /MERGETASKS=!… is a belt-and-
  // suspenders denylist for scripts that ignore an empty /TASKS=.
  const mergeTasks = INNO_EXTRA_TASK_DENYLIST.map((t) => `!${t}`).join(',');
  const args = [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/SP-',
    '/NORESTART',
    '/NOICONS',
    '/TASKS=',
    `/MERGETASKS=${mergeTasks}`,
    `/DIR=${targetDir}`,
  ];
  if (logPath) args.push(`/LOG=${logPath}`);
  return args;
}

/**
 * Eligibility for automatic silent install (v1 rules).
 * Does not mutate anything — pure decision.
 */
function canAutoSilentInstall({
  fingerprint,
  existingInstall = false, // kept for callers; version switches are allowed in v1.1+
  isDlcOrUpdate = false,
  autoSilentPref = null, // null = ask, true = auto, false = wizard
  targetDir,
  libraryRoots = [],
  // Test seam — production callers omit this and use platform.isWindows.
  isWindows = platform.isWindows,
} = {}) {
  if (!isWindows) {
    return { ok: false, reason: 'windows-only' };
  }
  // Fresh installs and version switches both use the same silent Inno path —
  // the install pipeline retires the previous Library copy after the new one
  // is verified. DLC/update packages stay on the wizard/merge paths.
  void existingInstall;
  if (isDlcOrUpdate) {
    return { ok: false, reason: 'dlc-or-update-excluded' };
  }
  if (autoSilentPref === false) {
    return { ok: false, reason: 'user-prefers-wizard' };
  }
  if (!fingerprint || !fingerprint.automatable || fingerprint.engine !== 'inno') {
    return { ok: false, reason: 'engine-not-automatable', fingerprint };
  }
  if (fingerprint.confidence !== 'high') {
    return { ok: false, reason: 'confidence-too-low', fingerprint };
  }
  if (targetDir && libraryRoots.length) {
    const contained = libraryRoots.some((root) => {
      try {
        return isInside(path.resolve(targetDir), path.resolve(root));
      } catch {
        return false;
      }
    });
    if (!contained) return { ok: false, reason: 'target-outside-library' };
  }
  return { ok: true, reason: 'eligible', fingerprint, needsAsk: autoSilentPref == null };
}

/** Ensure child stays under parent (rejects .. / junction escape when realpath available). */
function assertPathInside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (!isInside(c, p)) {
    throw new Error(`Path escapes library root:\n  ${c}\n  not inside ${p}`);
  }
  try {
    if (fs.existsSync(c) && fs.existsSync(p)) {
      const rc = fs.realpathSync(c);
      const rp = fs.realpathSync(p);
      if (!isInside(rc, rp) && rc !== rp) {
        throw new Error(`Resolved path escapes library root (reparse/junction):\n  ${rc}`);
      }
    }
  } catch (err) {
    if (/escapes library/.test(err.message)) throw err;
  }
  return c;
}

/**
 * Move extracted installer tree out of the final title folder into a private
 * payload directory, then recreate an empty target for the silent installer.
 */
function separatePayloadAndTarget(installDir, payloadDir) {
  fs.mkdirSync(path.dirname(payloadDir), { recursive: true });
  if (fs.existsSync(payloadDir)) fs.rmSync(payloadDir, { recursive: true, force: true });
  fs.renameSync(installDir, payloadDir);
  fs.mkdirSync(installDir, { recursive: true });
  return { payloadDir, targetDir: installDir };
}

function dirByteSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try { total += fs.statSync(p).size; } catch { /* */ }
      }
    }
  }
  return total;
}

/**
 * Post-install verification: exit code alone is not enough.
 * Need a plausible game tree and/or ranked launcher in targetDir.
 */
function verifySilentResult(targetDir, title, { minBytes = 10 * 1024 * 1024 } = {}) {
  if (!targetDir || !fs.existsSync(targetDir)) {
    return { ok: false, reason: 'target-missing', ranked: [], bytes: 0 };
  }
  const bytes = dirByteSize(targetDir);
  const ranked = installer.rankGameExes(targetDir, title);
  const top = ranked[0];
  const hasLauncher = !!(top && top.score >= 15);
  const substantial = bytes >= minBytes;
  // Tiny but clearly identified game exe still counts (test fixtures / small ports)
  const ok = hasLauncher || substantial;
  return {
    ok,
    reason: ok ? 'verified' : 'no-game-output',
    ranked,
    top,
    bytes,
    hasLauncher,
    substantial,
  };
}

/**
 * Build a PowerShell one-liner that launches `exe` elevated (UAC) and waits.
 * Does NOT use Start-Process -Wait: that collapses UAC + install into one opaque
 * block. Instead: Start-Process -PassThru returns after UAC is accepted, we emit
 * ELEVATED_STARTED:<pid> so Node can update UI / mute music, then WaitForExit.
 * Exit 1223 = user cancelled the UAC prompt.
 * Exported for unit tests — argument escaping must stay shell-safe.
 */
function buildElevatedPowerShell(exe, args, cwd) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const argList = args.map(q).join(', ');
  return [
    '$ErrorActionPreference = \'Stop\'',
    'try {',
    `  $p = Start-Process -FilePath ${q(exe)} -ArgumentList @(${argList}) -WorkingDirectory ${q(cwd)} -Verb RunAs -PassThru -WindowStyle Hidden`,
    '} catch { exit 1223 }',
    'if ($null -eq $p) { exit 1223 }',
    // Signal Node that UAC was accepted and the elevated installer is running.
    'Write-Output (\'ELEVATED_STARTED:\' + $p.Id)',
    'try { [Console]::Out.Flush() } catch {}',
    '$p.WaitForExit()',
    'exit $p.ExitCode',
  ].join('\n');
}

/**
 * Materialize watchdog .ps1 out of asar into %TEMP%.
 * Returns absolute path or null.
 */
function materializeInstallerWatchdog() {
  const bundled = path.join(__dirname, 'installerWatchdog.ps1');
  try {
    const body = fs.readFileSync(bundled, 'utf8');
    const script = path.join(os.tmpdir(), 'gamehub-installer-watchdog.ps1');
    let same = false;
    try { same = fs.existsSync(script) && fs.readFileSync(script, 'utf8') === body; } catch { /* */ }
    if (!same) fs.writeFileSync(script, body, 'utf8');
    return script;
  } catch {
    return null;
  }
}

const AUDIO_STATE_FILE = () => path.join(os.tmpdir(), 'gamehub-audio-guard-state.json');

/**
 * If a prior silent-install mute left the system muted (crash / kill), restore.
 * Safe to call on app startup.
 */
function restoreInstallerAudioIfNeeded() {
  if (!platform.isWindows) return;
  const stateFile = AUDIO_STATE_FILE();
  if (!fs.existsSync(stateFile)) return;
  const script = materializeInstallerWatchdog();
  if (!script) return;
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-RestoreOnly',
      '-StateFile', stateFile,
    ], { windowsHide: true, stdio: 'ignore' });
    // Fire-and-forget; restore is best-effort.
    child.on('error', () => {});
  } catch { /* */ }
}

/**
 * Hard audio guard for silent Inno/FitGirl.
 * Synchronously mutes the SYSTEM master volume first (before UAC / spawn),
 * then keeps a watchdog forcing mute + killing redist/promo extras.
 * Restores prior volume/mute on stop().
 *
 * Returns { setRootPid(pid), stop() }.
 */
function startInstallerAudioGuard({ rootPid = 0 } = {}) {
  const noop = { setRootPid() {}, stop() {} };
  if (!platform.isWindows) return noop;

  const script = materializeInstallerWatchdog();
  if (!script) return noop;

  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stopFile = path.join(os.tmpdir(), `gamehub-audio-guard-stop-${id}`);
  const pidFile = path.join(os.tmpdir(), `gamehub-audio-guard-root-${id}`);
  const stateFile = AUDIO_STATE_FILE();
  try { if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile); } catch { /* */ }
  try {
    if (rootPid > 0) fs.writeFileSync(pidFile, String(rootPid), 'utf8');
    else if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  } catch { /* */ }

  // CRITICAL: block until master mute is applied. A background watchdog alone
  // loses the race — FitGirl music starts the instant elevated setup runs.
  try {
    spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-MuteOnly',
      '-StateFile', stateFile,
    ], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
  } catch { /* */ }

  let child;
  try {
    child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-RootPid', String(rootPid || 0),
      '-StopFile', stopFile,
      '-PidFile', pidFile,
      '-StateFile', stateFile,
      '-PollMs', '80',
    ], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    return noop;
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { fs.writeFileSync(stopFile, '1', 'utf8'); } catch { /* */ }
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && child && child.exitCode == null && !child.killed) {
      const spinUntil = Date.now() + 40;
      while (Date.now() < spinUntil) { /* wait for watchdog finally/restore */ }
    }
    try { child.kill(); } catch { /* */ }
    // Belt-and-suspenders restore if watchdog was killed mid-flight.
    try {
      spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', script,
        '-RestoreOnly',
        '-StateFile', stateFile,
      ], { windowsHide: true, timeout: 8000, stdio: 'ignore' });
    } catch { /* */ }
    try { if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile); } catch { /* */ }
    try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch { /* */ }
  };

  return {
    setRootPid(pid) {
      if (!pid) return;
      try { fs.writeFileSync(pidFile, String(pid), 'utf8'); } catch { /* */ }
    },
    stop,
  };
}

/** @deprecated name kept for callers/tests — starts hard system mute guard. */
function startInstallerAudioMute(rootPid) {
  const guard = startInstallerAudioGuard({ rootPid: rootPid || 0 });
  return () => guard.stop();
}

function isElevationError(err) {
  if (!err) return false;
  const code = err.code;
  // Windows ERROR_ELEVATION_REQUIRED = 740; Node may surface as errno or message.
  if (code === 'EACCES' || code === 'EPERM' || code === 'ELEVATION_REQUIRED') return true;
  if (code === 740 || err.errno === 740) return true;
  return /elevation|elevated|740|runas|administrat/i.test(String(err.message || err));
}

function isElevationExit(code) {
  return code === 740 || code === 5; // elevation required / access denied
}

/**
 * Run a high-confidence Inno installer silently into targetDir.
 * Non-elevated spawn first (or skip if requiresAdmin). On elevation failure,
 * re-launch via UAC (ShellExecute runas through PowerShell) so the user can
 * approve once and Gamehub keeps driving the silent install.
 */
function runSilentInno(setupExe, targetDir, {
  logPath = null,
  signal = null,
  timeoutMs = 0,
  requiresAdmin = false,
  onElevate = null,
  onElevatedStarted = null,
  onInstallerStarted = null,
} = {}) {
  const args = buildInnoArgs(targetDir, logPath);
  const cwd = path.dirname(setupExe);

  return (async () => {
    // Mute system audio BEFORE any spawn / UAC — FitGirl music starts the
    // instant elevated setup runs; per-PID mute after the fact is too late.
    const guard = startInstallerAudioGuard();
    try {
      const runOnce = (elevated) => new Promise((resolve) => {
        if (signal?.aborted) return resolve({ ok: false, exitCode: null, error: 'cancelled', elevated });
        if (!fs.existsSync(setupExe)) {
          return resolve({ ok: false, exitCode: null, error: 'setup-missing', elevated });
        }
        fs.mkdirSync(targetDir, { recursive: true });
        if (logPath) fs.mkdirSync(path.dirname(logPath), { recursive: true });

        let settled = false;
        let child;
        let startedSignaled = false;
        try {
          if (elevated) {
            const ps = buildElevatedPowerShell(setupExe, args, cwd);
            child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'ignore'],
            });
          } else {
            child = spawn(setupExe, args, {
              cwd,
              windowsHide: true,
              stdio: ['ignore', 'ignore', 'ignore'],
            });
          }
        } catch (err) {
          return resolve({
            ok: false,
            exitCode: null,
            error: err.message,
            needsElevation: !elevated && isElevationError(err),
            elevated,
            logPath,
          });
        }

        const signalStarted = (installerPid) => {
          if (startedSignaled) return;
          startedSignaled = true;
          const pid = installerPid || child?.pid || null;
          if (pid) guard.setRootPid(pid);
          if (elevated) onElevatedStarted?.({ pid });
          else onInstallerStarted?.({ pid });
        };

        if (!elevated && child?.pid) {
          signalStarted(child.pid);
        }

        if (elevated && child.stdout) {
          let buf = '';
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            buf += chunk;
            const m = buf.match(/ELEVATED_STARTED:(\d+)/);
            if (m) signalStarted(Number(m[1]));
          });
        }

        const finish = (result) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          if (timer) clearTimeout(timer);
          resolve({ ...result, elevated, logPath });
        };

        const onAbort = () => {
          try { child.kill(); } catch { /* */ }
          const reason = signal?.reason === 'paused' ? 'paused' : 'cancelled';
          finish({ ok: false, exitCode: null, error: reason });
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        let timer = null;
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            try { child.kill(); } catch { /* */ }
            finish({ ok: false, exitCode: null, error: 'timeout' });
          }, timeoutMs);
        }

        child.on('error', (err) => {
          finish({
            ok: false,
            exitCode: null,
            error: err.message,
            needsElevation: !elevated && isElevationError(err),
          });
        });
        child.on('close', (code) => {
          if (elevated && code === 1223) {
            return finish({ ok: false, exitCode: 1223, error: 'uac-cancelled', needsElevation: false });
          }
          finish({
            ok: code === 0,
            exitCode: code,
            error: code === 0 ? undefined : `inno-exit-${code}`,
            needsElevation: !elevated && isElevationExit(code),
          });
        });
      });

      if (requiresAdmin) {
        onElevate?.();
        return await runOnce(true);
      }
      const first = await runOnce(false);
      if (first.ok || first.error === 'cancelled' || first.error === 'paused' || signal?.aborted) {
        return first;
      }
      if (first.needsElevation || isElevationExit(first.exitCode)) {
        onElevate?.();
        return await runOnce(true);
      }
      return first;
    } finally {
      try { guard.stop(); } catch { /* */ }
    }
  })();
}

/**
 * Automatic attempt: fingerprint → separate payload/target → run → verify.
 * On failure, payload is kept for the manual wizard; partial target is removed.
 * Call while setupExe still lives under installDir.
 */
async function attemptSilentInstallSafe({
  setupExe,
  installDir,
  payloadDir,
  title,
  libraryRoots = [],
  signal = null,
  logDir = null,
  onPhase = null,
} = {}) {
  const fingerprint = fingerprintInstaller(setupExe);
  if (!fingerprint.automatable) {
    return { ok: false, reason: 'not-automatable', fingerprint, setupExe };
  }

  const relSetup = path.relative(installDir, setupExe);
  if (relSetup.startsWith('..') || path.isAbsolute(relSetup)) {
    return { ok: false, reason: 'setup-outside-install-dir', fingerprint, setupExe };
  }

  for (const root of libraryRoots) {
    assertPathInside(installDir, root);
    assertPathInside(payloadDir, root);
  }

  onPhase?.('checking-setup', { message: `Checking setup — ${fingerprint.engineLabel}` });

  separatePayloadAndTarget(installDir, payloadDir);
  const setupInPayload = path.join(payloadDir, relSetup);
  const targetDir = installDir;
  const logPath = logDir
    ? path.join(logDir, `inno-${Date.now()}.log`)
    : path.join(payloadDir, '_gamehub-inno.log');

  if (!fs.existsSync(setupInPayload)) {
    try {
      if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(payloadDir, installDir);
    } catch { /* */ }
    return { ok: false, reason: 'setup-lost-after-move', fingerprint, setupExe };
  }

  onPhase?.('installing-auto', {
    message: fingerprint.requiresAdmin
      ? `Installing automatically — approve the Windows permission prompt if asked`
      : `Installing automatically — ${fingerprint.engineLabel}`,
  });
  const run = await runSilentInno(setupInPayload, targetDir, {
    logPath,
    signal,
    requiresAdmin: !!fingerprint.requiresAdmin,
    onElevate: () => onPhase?.('installing-auto', {
      message: 'Waiting for administrator permission…',
    }),
    // UAC accepted / non-admin spawn — installer is actually running now.
    onElevatedStarted: () => onPhase?.('installing-auto', {
      message: `Installing automatically — ${fingerprint.engineLabel}`,
    }),
    onInstallerStarted: () => onPhase?.('installing-auto', {
      message: `Installing automatically — ${fingerprint.engineLabel}`,
    }),
  });

  if (signal?.aborted || run.error === 'cancelled' || run.error === 'paused') {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* */ }
    const reason = (run.error === 'paused' || signal?.reason === 'paused') ? 'paused' : 'cancelled';
    return {
      ok: false,
      reason,
      fingerprint,
      payloadDir,
      setupExe: setupInPayload,
      ...run,
      error: reason,
    };
  }

  if (!run.ok) {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* */ }
    const reason = run.error === 'uac-cancelled'
      ? 'uac-cancelled'
      : run.needsElevation
        ? 'needs-elevation'
        : (run.error || 'installer-failed');
    return {
      ok: false,
      reason,
      fingerprint,
      payloadDir,
      setupExe: setupInPayload,
      ...run,
    };
  }

  onPhase?.('finding-launcher', { message: 'Finding launcher…' });
  const verified = verifySilentResult(targetDir, title);
  if (!verified.ok) {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* */ }
    return {
      ok: false,
      reason: 'no-game-output',
      fingerprint,
      payloadDir,
      setupExe: setupInPayload,
      verified,
      ...run,
    };
  }

  onPhase?.('verifying', { message: 'Verifying…' });
  return {
    ok: true,
    reason: 'success',
    fingerprint,
    payloadDir,
    targetDir,
    setupExe: setupInPayload,
    verified,
    ...run,
  };
}

module.exports = {
  buildInnoArgs,
  INNO_EXTRA_TASK_DENYLIST,
  buildElevatedPowerShell,
  startInstallerAudioMute,
  startInstallerAudioGuard,
  restoreInstallerAudioIfNeeded,
  canAutoSilentInstall,
  assertPathInside,
  separatePayloadAndTarget,
  verifySilentResult,
  runSilentInno,
  attemptSilentInstallSafe,
  dirByteSize,
  isElevationError,
  isElevationExit,
};
