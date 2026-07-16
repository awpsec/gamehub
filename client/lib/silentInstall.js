// Silent installer driver — high-confidence Inno Setup + NSIS.
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

/**
 * Windows-quote one argument for a child command line (CommandLineToArgvW
 * rules): wrap in double quotes when needed, escape embedded quotes, double
 * trailing backslashes. Used wherever we hand PowerShell a SINGLE argument
 * string — Start-Process with an ARRAY joins elements unquoted, which splits
 * spaced paths (/DIR=C:\...\Title With Spaces) before the installer sees them.
 */
function windowsQuoteArg(s) {
  const v = String(s ?? '');
  if (v === '') return '""';
  if (!/[\s"]/.test(v)) return v;
  return `"${v.replace(/(\\+)$/, '$1$1').replace(/(\\*)"/g, '$1$1\\"')}"`;
}

/**
 * Quote one silent-installer argv element for a Start-Process argument line.
 * NSIS `/D=` must NEVER be quoted (even with spaces) and must be last — NSIS
 * reads the raw command-line tail. Inno `/DIR=` uses normal Windows quoting.
 */
function quoteSilentArg(s) {
  const v = String(s ?? '');
  if (/^\/D=/i.test(v)) return v;
  return windowsQuoteArg(v);
}

/** Build Inno Setup argv. Each flag is its own array element — never shell-joined. */
function buildInnoArgs(targetDir, logPath, { loadInfPath = null } = {}) {
  // /TASKS= clears every optional task (DirectX, VC++, icons, promo) when the
  // repack maps those checkboxes to Inno tasks. Do NOT also pass /MERGETASKS —
  // that merges against defaults and can re-select the extras we just cleared.
  const args = [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/SP-',
    '/NORESTART',
    '/NOICONS',
    '/TASKS=',
    `/DIR=${targetDir}`,
  ];
  if (loadInfPath) args.push(`/LOADINF=${loadInfPath}`);
  if (logPath) args.push(`/LOG=${logPath}`);
  return args;
}

/**
 * Build NSIS silent argv.
 * Rules (NSIS docs): `/S` for silent; `/D=C:\path` MUST be the last argument
 * and MUST NOT be quoted even when the path contains spaces.
 */
function buildNsisArgs(targetDir) {
  return ['/S', `/D=${targetDir}`];
}

/** Write an Inno .inf that forces Tasks= empty (belt-and-suspenders with /TASKS=). */
function writeInnoLoadInf(targetDir, infPath) {
  const body = [
    '[Setup]',
    `Dir=${targetDir}`,
    'Group=',
    'NoIcons=1',
    'Tasks=',
    '',
  ].join('\r\n');
  fs.mkdirSync(path.dirname(infPath), { recursive: true });
  fs.writeFileSync(infPath, body, 'utf8');
  return infPath;
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
  // Fresh installs and version switches both use the same silent Inno/NSIS path —
  // the install pipeline retires the previous Library copy after the new one
  // is verified. DLC/update packages stay on the wizard/merge paths.
  void existingInstall;
  if (isDlcOrUpdate) {
    return { ok: false, reason: 'dlc-or-update-excluded' };
  }
  if (autoSilentPref === false) {
    return { ok: false, reason: 'user-prefers-wizard' };
  }
  if (!fingerprint || !fingerprint.automatable || !['inno', 'nsis'].includes(fingerprint.engine)) {
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
 * Build unelevated PowerShell that UAC-launches elevatedSilentRunner.ps1 once.
 *
 * CRITICAL: never treat elevated `$elev.HasExited` / ExitCode as "UAC declined".
 * After Start-Process -Verb RunAs, the unelevated handle often cannot query the
 * elevated process (UAC shows powershell.exe). Also: Start-Process can throw
 * ERROR_CANCELLED (1223) spuriously AFTER the user accepts — so a catch must
 * still grace-wait for AliveFile before concluding decline.
 *
 * Handshake is file-based only:
 *   AliveFile   — elevated script running (UAC accepted)
 *   StartedFile — setup PID
 *   DoneFile    — final exit code
 *
 * ArgumentList is a single Windows-quoted string (double quotes) so paths with
 * spaces (e.g. Town to City) survive ShellExecute parsing.
 */
function buildElevatedPowerShell(exe, args, cwd, {
  runnerScript,
  argsFile,
  startedFile,
  stopFile,
  aliveFile,
  doneFile,
} = {}) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  // Embed a token that becomes a double-quoted Windows cmdline argument —
  // ALWAYS quoted (runner/handshake paths), with full CommandLineToArgvW
  // escaping for embedded quotes and trailing backslashes.
  const wq = (s) => {
    const v = String(s);
    return `"${v.replace(/(\\+)$/, '$1$1').replace(/(\\*)"/g, '$1$1\\"')}"`;
  };
  if (!runnerScript || !argsFile || !startedFile || !aliveFile || !doneFile) {
    // Legacy fallback (tests without runner paths): RunAs setup directly.
    // ONE pre-quoted argument line — an ArgumentList ARRAY would be joined
    // with spaces unquoted and split spaced /DIR paths. NSIS /D= stays raw.
    const argLine = (args || []).map(quoteSilentArg).join(' ');
    const argSegment = argLine.trim() ? ` -ArgumentList ${q(argLine)}` : '';
    return [
      '$ErrorActionPreference = \'Stop\'',
      'try {',
      `  $p = Start-Process -FilePath ${q(exe)}${argSegment} -WorkingDirectory ${q(cwd)} -Verb RunAs -PassThru -WindowStyle Hidden`,
      '} catch { exit 1223 }',
      'if ($null -eq $p) { exit 1223 }',
      'Write-Output (\'ELEVATED_STARTED:\' + $p.Id)',
      'try { [Console]::Out.Flush() } catch {}',
      '$p.WaitForExit()',
      'exit $p.ExitCode',
    ].join('\n');
  }
  // One ArgumentList string with embedded "…" so CreateProcess/ShellExecute
  // does not split on spaces inside game/install paths.
  const elevArgLine = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    wq(runnerScript),
    '-SetupExe',
    wq(exe),
    '-ArgsFile',
    wq(argsFile),
    '-WorkingDirectory',
    wq(cwd),
    '-StartedFile',
    wq(startedFile),
    '-AliveFile',
    wq(aliveFile),
    '-DoneFile',
    wq(doneFile),
    '-StopFile',
    wq(stopFile || ''),
  ].join(' ');
  return [
    '$ErrorActionPreference = \'Continue\'',
    `$alive = ${q(aliveFile)}`,
    `$started = ${q(startedFile)}`,
    `$done = ${q(doneFile)}`,
    `$stop = ${q(stopFile || '')}`,
    'foreach ($f in @($alive, $started, $done)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } }',
    'if ($stop -and (Test-Path -LiteralPath $stop)) { Remove-Item -LiteralPath $stop -Force -ErrorAction SilentlyContinue }',
    `$argLine = ${q(elevArgLine)}`,
    '$runAsOk = $false',
    '$cancelHint = $false',
    'try {',
    '  $null = Start-Process -FilePath \'powershell.exe\' -Verb RunAs -WindowStyle Hidden -ArgumentList $argLine',
    '  $runAsOk = $true',
    '} catch {',
    '  $ex = $_.Exception',
    '  $native = 0',
    '  try {',
    '    if ($ex -is [System.ComponentModel.Win32Exception]) { $native = [int]$ex.NativeErrorCode }',
    '    elseif ($ex.InnerException -is [System.ComponentModel.Win32Exception]) { $native = [int]$ex.InnerException.NativeErrorCode }',
    '  } catch {}',
    '  if ($native -eq 1223 -or ($ex.Message -match \'cancel\')) { $cancelHint = $true }',
    '  # Do NOT exit 1223 here — Start-Process can throw 1223 even after accept;',
    '  # AliveFile is the only reliable proof of decline vs accept.',
    '}',
    // AliveFile = UAC accepted + elevated script actually running.
    // Longer wait when RunAs returned; short grace when it threw (false cancel).
    'if ($runAsOk) { $uacDeadline = (Get-Date).AddMinutes(10) } else { $uacDeadline = (Get-Date).AddSeconds(90) }',
    'while (-not (Test-Path -LiteralPath $alive)) {',
    '  if ((Get-Date) -gt $uacDeadline) {',
    '    if ($cancelHint -or -not $runAsOk) { exit 1223 }',
    '    exit 5',
    '  }',
    '  if (Test-Path -LiteralPath $done) {',
    '    $early = 1',
    '    try { $early = [int]((Get-Content -LiteralPath $done -Raw).Trim()) } catch {}',
    '    exit $early',
    '  }',
    '  Start-Sleep -Milliseconds 100',
    '}',
    // Elevated and alive — wait for setup PID (or early done/failure).
    '$startDeadline = (Get-Date).AddMinutes(30)',
    'while (-not (Test-Path -LiteralPath $started)) {',
    '  if (Test-Path -LiteralPath $done) {',
    '    $early2 = 1',
    '    try { $early2 = [int]((Get-Content -LiteralPath $done -Raw).Trim()) } catch {}',
    '    exit $early2',
    '  }',
    '  if ((Get-Date) -gt $startDeadline) { exit 1 }',
    '  Start-Sleep -Milliseconds 100',
    '}',
    '$setupPid = ((Get-Content -LiteralPath $started -Raw).Trim())',
    'Write-Output (\'ELEVATED_STARTED:\' + $setupPid)',
    'try { [Console]::Out.Flush() } catch {}',
    // Wait for DoneFile for the real exit code (elevated ExitCode is often inaccessible).
    '$doneDeadline = (Get-Date).AddHours(6)',
    'while (-not (Test-Path -LiteralPath $done)) {',
    '  if ((Get-Date) -gt $doneDeadline) { exit 1 }',
    '  Start-Sleep -Milliseconds 250',
    '}',
    '$code = 0',
    'try { $code = [int]((Get-Content -LiteralPath $done -Raw).Trim()) } catch { $code = 1 }',
    'exit $code',
  ].join('\n');
}

function materializeScript(bundledName, tempName) {
  const bundled = path.join(__dirname, bundledName);
  try {
    const body = fs.readFileSync(bundled, 'utf8');
    const script = path.join(os.tmpdir(), tempName);
    let same = false;
    try { same = fs.existsSync(script) && fs.readFileSync(script, 'utf8') === body; } catch { /* */ }
    if (!same) fs.writeFileSync(script, body, 'utf8');
    return script;
  } catch {
    return null;
  }
}

/**
 * Materialize watchdog .ps1 out of asar into %TEMP%.
 * Returns absolute path or null.
 */
function materializeInstallerWatchdog() {
  return materializeScript('installerWatchdog.ps1', 'gamehub-installer-watchdog.ps1');
}

function materializeElevatedSilentRunner() {
  return materializeScript('elevatedSilentRunner.ps1', 'gamehub-elevated-silent-runner.ps1');
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
 * Scoped audio guard for silent Inno/NSIS/FitGirl.
 * Sync master-mute first (race window before the setup audio session exists),
 * then the watchdog holds master briefly (MasterHoldMs), restores the user's
 * master volume, and mutes only the setup PID tree's sessions for the rest of
 * the install — so Discord/music keep working after the first few seconds.
 *
 * Returns { setRootPid(pid), stop() }.
 */
function startInstallerAudioGuard({
  rootPid = 0,
  masterHoldMs = 8000,
  // Test seams
  _spawn = spawn,
  _spawnSync = spawnSync,
  _isWindows = platform.isWindows,
} = {}) {
  const noop = { setRootPid() {}, stop() {} };
  if (!_isWindows) return noop;

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
    _spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-MuteOnly',
      '-StateFile', stateFile,
    ], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
  } catch { /* */ }

  let child;
  try {
    child = _spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-RootPid', String(rootPid || 0),
      '-StopFile', stopFile,
      '-PidFile', pidFile,
      '-StateFile', stateFile,
      '-PollMs', '80',
      '-MasterHoldMs', String(Math.max(0, Number(masterHoldMs) || 0)),
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
    try { child.kill(); } catch { /* */ }
    // Brief wait for watchdog finally/restore — don't block the install pipeline
    // for seconds if the child ignores signals (tests / wedged powershell).
    const deadline = Date.now() + 200;
    while (Date.now() < deadline && child && child.exitCode == null && !child.killed) {
      const spinUntil = Date.now() + 20;
      while (Date.now() < spinUntil) { /* */ }
    }
    // Belt-and-suspenders restore if watchdog was killed mid-flight.
    try {
      _spawnSync('powershell.exe', [
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
 * Run a high-confidence Inno or NSIS installer silently into targetDir.
 * Non-elevated spawn first (or skip if requiresAdmin). On elevation failure,
 * re-launch via UAC (ShellExecute runas through PowerShell) so the user can
 * approve once and Gamehub keeps driving the silent install.
 */
function runSilentInno(setupExe, targetDir, {
  logPath = null,
  signal = null,
  timeoutMs = 0,
  requiresAdmin = false,
  engine = 'inno',
  onElevate = null,
  onElevatedStarted = null,
  onInstallerStarted = null,
  // Test seams — production callers omit these.
  _spawn = spawn,
  _spawnSync = spawnSync,
  _isWindows = platform.isWindows,
  // After wrapper exits 1223 with no AliveFile yet, wait this long for the
  // elevated runner to prove accept (Start-Process can false-throw 1223).
  _uacGraceMs = 20000,
} = {}) {
  const cwd = path.dirname(setupExe);
  const stagingDir = path.join(os.tmpdir(), `gamehub-silent-${process.pid}-${Date.now()}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  const isNsis = engine === 'nsis';
  let loadInfPath = null;
  let args;
  if (isNsis) {
    args = buildNsisArgs(targetDir);
  } else {
    loadInfPath = path.join(stagingDir, 'setup.inf');
    writeInnoLoadInf(targetDir, loadInfPath);
    args = buildInnoArgs(targetDir, logPath, { loadInfPath });
  }
  const argsFile = path.join(stagingDir, 'setup-args.txt');
  fs.writeFileSync(argsFile, `${args.join('\n')}\n`, 'utf8');
  const startedFile = path.join(stagingDir, 'elevated-started.txt');
  const aliveFile = path.join(stagingDir, 'elevated-alive.txt');
  const doneFile = path.join(stagingDir, 'elevated-done.txt');
  const elevStopFile = path.join(stagingDir, 'elevated-stop.txt');
  const wrapperFile = path.join(stagingDir, 'elevate-wrapper.ps1');
  const runnerScript = materializeElevatedSilentRunner();

  return (async () => {
    // Mute system audio BEFORE any spawn / UAC — FitGirl music starts the
    // instant elevated setup runs; per-PID mute after the fact is too late.
    const guard = startInstallerAudioGuard({
      _spawn,
      _spawnSync,
      _isWindows,
    });
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
        let setupPid = null;
        let filePoll = null;
        let uacGraceTimer = null;
        try {
          if (elevated) {
            for (const f of [startedFile, aliveFile, doneFile, elevStopFile]) {
              try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* */ }
            }
            const ps = buildElevatedPowerShell(setupExe, args, cwd, {
              runnerScript,
              argsFile,
              startedFile,
              stopFile: elevStopFile,
              aliveFile,
              doneFile,
            });
            // -File wrapper is more reliable than -Command for multi-line scripts
            // with nested quotes (paths with spaces / apostrophes).
            fs.writeFileSync(wrapperFile, ps, 'utf8');
            child = _spawn('powershell.exe', [
              '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperFile,
            ], {
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'ignore'],
            });
          } else {
            // NSIS /D= must not be auto-quoted by Node's Windows spawn quoting.
            child = _spawn(setupExe, args, {
              cwd,
              windowsHide: true,
              windowsVerbatimArguments: isNsis,
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

        const readPidFile = (file) => {
          try {
            const n = Number(String(fs.readFileSync(file, 'utf8')).trim());
            return Number.isFinite(n) && n > 0 ? n : null;
          } catch {
            return null;
          }
        };
        const readDoneCode = () => {
          try {
            if (!fs.existsSync(doneFile)) return null;
            const n = Number(String(fs.readFileSync(doneFile, 'utf8')).trim());
            return Number.isFinite(n) ? n : null;
          } catch {
            return null;
          }
        };
        const elevationProof = () => (
          fs.existsSync(aliveFile) || fs.existsSync(startedFile) || startedSignaled || fs.existsSync(doneFile)
        );

        const signalStarted = (installerPid) => {
          if (startedSignaled) return;
          startedSignaled = true;
          const pid = installerPid || child?.pid || null;
          setupPid = pid;
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

        // File poll backup — stdout can lag; Alive/Started files are authoritative.
        if (elevated) {
          filePoll = setInterval(() => {
            if (!startedSignaled && fs.existsSync(startedFile)) {
              const pid = readPidFile(startedFile);
              if (pid) signalStarted(pid);
            }
          }, 100);
        }

        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (filePoll) clearInterval(filePoll);
          if (uacGraceTimer) clearInterval(uacGraceTimer);
          signal?.removeEventListener('abort', onAbort);
          if (timer) clearTimeout(timer);
          resolve({ ...result, elevated, logPath });
        };

        const finishFromDoneOrCode = (code) => {
          const doneCode = readDoneCode();
          if (doneCode != null) {
            return finish({
              ok: doneCode === 0,
              exitCode: doneCode,
              error: doneCode === 0 ? undefined : `inno-exit-${doneCode}`,
              needsElevation: false,
            });
          }
          return finish({
            ok: code === 0,
            exitCode: code,
            error: code === 0 ? undefined : `inno-exit-${code}`,
            needsElevation: !elevated && isElevationExit(code),
          });
        };

        /** After a false 1223, own the handshake until DoneFile appears. */
        const adoptElevatedHandshake = (fallbackCode) => {
          const adoptStart = Date.now();
          const adoptLimitMs = 6 * 60 * 60 * 1000;
          if (uacGraceTimer) clearInterval(uacGraceTimer);
          uacGraceTimer = setInterval(() => {
            if (settled) {
              clearInterval(uacGraceTimer);
              return;
            }
            if (!startedSignaled && fs.existsSync(startedFile)) {
              const pid = readPidFile(startedFile);
              if (pid) signalStarted(pid);
            }
            const doneCode = readDoneCode();
            if (doneCode != null) {
              clearInterval(uacGraceTimer);
              uacGraceTimer = null;
              return finish({
                ok: doneCode === 0,
                exitCode: doneCode,
                error: doneCode === 0 ? undefined : `inno-exit-${doneCode}`,
                needsElevation: false,
              });
            }
            if (Date.now() - adoptStart >= adoptLimitMs) {
              clearInterval(uacGraceTimer);
              uacGraceTimer = null;
              return finish({
                ok: false,
                exitCode: fallbackCode == null ? 1 : fallbackCode,
                error: `inno-exit-${fallbackCode == null ? 1 : fallbackCode}`,
                needsElevation: false,
              });
            }
          }, 100);
        };

        const onAbort = () => {
          try { fs.writeFileSync(elevStopFile, '1', 'utf8'); } catch { /* */ }
          if (setupPid) {
            try {
              _spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(setupPid)], {
                windowsHide: true,
                stdio: 'ignore',
              });
            } catch { /* */ }
          }
          try { child.kill(); } catch { /* */ }
          const reason = signal?.reason === 'paused' ? 'paused' : 'cancelled';
          finish({ ok: false, exitCode: null, error: reason });
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        let timer = null;
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            try { fs.writeFileSync(elevStopFile, '1', 'utf8'); } catch { /* */ }
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
            // Already have DoneFile → use real exit (never trust wrapper 1223 alone).
            if (fs.existsSync(doneFile)) {
              return finishFromDoneOrCode(code);
            }
            // Elevated runner proved alive / started — adopt handshake, wait for Done.
            if (elevationProof()) {
              if (!startedSignaled && fs.existsSync(startedFile)) {
                const pid = readPidFile(startedFile);
                if (pid) signalStarted(pid);
              }
              return adoptElevatedHandshake(code);
            }
            // Race: wrapper exited 1223 (false Start-Process cancel) while the
            // elevated runner is still starting and has not written AliveFile yet.
            const graceMs = Math.max(0, Number(_uacGraceMs) || 0);
            if (graceMs <= 0) {
              return finish({ ok: false, exitCode: 1223, error: 'uac-cancelled', needsElevation: false });
            }
            const graceStart = Date.now();
            uacGraceTimer = setInterval(() => {
              if (settled) {
                clearInterval(uacGraceTimer);
                return;
              }
              if (fs.existsSync(doneFile) || elevationProof()) {
                clearInterval(uacGraceTimer);
                uacGraceTimer = null;
                if (!startedSignaled && fs.existsSync(startedFile)) {
                  const pid = readPidFile(startedFile);
                  if (pid) signalStarted(pid);
                }
                if (fs.existsSync(doneFile)) return finishFromDoneOrCode(code);
                return adoptElevatedHandshake(code);
              }
              if (Date.now() - graceStart >= graceMs) {
                clearInterval(uacGraceTimer);
                uacGraceTimer = null;
                return finish({ ok: false, exitCode: 1223, error: 'uac-cancelled', needsElevation: false });
              }
            }, 50);
            return;
          }
          if (elevated) {
            const doneCode = readDoneCode();
            if (doneCode != null && doneCode !== code) {
              return finish({
                ok: doneCode === 0,
                exitCode: doneCode,
                error: doneCode === 0 ? undefined : `inno-exit-${doneCode}`,
                needsElevation: !elevated && isElevationExit(doneCode),
              });
            }
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
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* */ }
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
    ? path.join(logDir, `silent-${fingerprint.engine}-${Date.now()}.log`)
    : path.join(payloadDir, `_gamehub-${fingerprint.engine}.log`);

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
    engine: fingerprint.engine,
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
  windowsQuoteArg,
  quoteSilentArg,
  buildInnoArgs,
  buildNsisArgs,
  writeInnoLoadInf,
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
