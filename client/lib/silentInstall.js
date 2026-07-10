// Silent installer driver — high-confidence Inno Setup only (v1).
// Separate payloadDir (setup + bins) from targetDir (final game). Store never touched.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fingerprintInstaller } = require('./fingerprint');
const { isInside } = require('./localCopy');
const installer = require('./installer');
const platform = require('./platform');

/** Build Inno Setup argv. Each flag is its own array element — never shell-joined. */
function buildInnoArgs(targetDir, logPath) {
  const args = [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/SP-',
    '/NORESTART',
    '/NOICONS',
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
  existingInstall = false,
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
  if (existingInstall) {
    return { ok: false, reason: 'version-switch-excluded' };
  }
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
 * Run a high-confidence Inno installer silently into targetDir.
 * Does NOT elevate Electron — spawns the installer child with an argv array
 * (no shell). Elevation-required failures → caller falls back to the wizard.
 */
function runSilentInno(setupExe, targetDir, { logPath = null, signal = null, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, exitCode: null, error: 'cancelled' });
    if (!fs.existsSync(setupExe)) {
      return resolve({ ok: false, exitCode: null, error: 'setup-missing' });
    }
    fs.mkdirSync(targetDir, { recursive: true });
    if (logPath) fs.mkdirSync(path.dirname(logPath), { recursive: true });

    const args = buildInnoArgs(targetDir, logPath);
    let settled = false;
    let child;
    try {
      child = spawn(setupExe, args, {
        cwd: path.dirname(setupExe),
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (err) {
      const elev = err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'ELEVATION_REQUIRED';
      return resolve({
        ok: false,
        exitCode: null,
        error: err.message,
        needsElevation: elev,
        logPath,
      });
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const onAbort = () => {
      try { child.kill(); } catch { /* */ }
      const reason = signal?.reason === 'paused' ? 'paused' : 'cancelled';
      finish({ ok: false, exitCode: null, error: reason, logPath });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* */ }
        finish({ ok: false, exitCode: null, error: 'timeout', logPath });
      }, timeoutMs);
    }

    child.on('error', (err) => {
      const elev = err.code === 'EACCES' || err.code === 'EPERM' || /elevation/i.test(err.message || '');
      finish({ ok: false, exitCode: null, error: err.message, needsElevation: elev, logPath });
    });
    child.on('close', (code) => {
      finish({
        ok: code === 0,
        exitCode: code,
        error: code === 0 ? undefined : `inno-exit-${code}`,
        logPath,
      });
    });
  });
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

  onPhase?.('installing-auto', { message: `Installing automatically — ${fingerprint.engineLabel}` });
  const run = await runSilentInno(setupInPayload, targetDir, { logPath, signal });

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
    return {
      ok: false,
      reason: run.needsElevation ? 'needs-elevation' : (run.error || 'installer-failed'),
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
  canAutoSilentInstall,
  assertPathInside,
  separatePayloadAndTarget,
  verifySilentResult,
  runSilentInno,
  attemptSilentInstallSafe,
  dirByteSize,
};
