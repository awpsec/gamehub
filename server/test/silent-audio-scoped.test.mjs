// Scoped audio mute: master hold then per-session. Drives the REAL watchdog
// script's structure + (on Windows) a short MasterHoldMs cycle with MuteOnly.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { checker, tmp, rm } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { startInstallerAudioGuard, runGuardedInstaller } = require('../../client/lib/silentInstall.js');

const WATCHDOG = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')),
  '../../client/lib/installerWatchdog.ps1',
);
const WIN = process.platform === 'win32';

test('installerWatchdog: scoped-mute structure', () => {
  const { check, done } = checker();
  const body = fs.readFileSync(WATCHDOG, 'utf8');
  check('MasterHoldMs', body.includes('[int]$MasterHoldMs'));
  check('MuteInstallerSessions', body.includes('MuteInstallerSessions'));
  check('Toolhelp tree (no CIM on the hot path)', body.includes('CreateToolhelp32Snapshot'));
  check('launch mode', body.includes('$LaunchExe') && body.includes('STARTED:'));
  check('wizard mode skips extras', body.includes('$NoExtras'));
  check('SelfTest switch', body.includes('$SelfTest'));
  check('IAudioSessionControl2', body.includes('IAudioSessionControl2') && body.includes('GetProcessId'));
  check('fixed ISimpleAudioVolume GUID', body.includes('87CE5498-68D6-44E5-A1FC-635806365766'));
  check('old wrong GUID gone', !body.includes('87CE5498-68D6-140E-49E3-635806365766'));
  check('Release-MasterMute', body.includes('function Release-MasterMute'));
  check('KeepFile restore', body.includes('-KeepFile') || body.includes('KeepFile'));
  check('no MuteAllSessions blanket', !body.includes('MuteAllSessions'));
  check('still kills redists', /dxsetup|vcredist/i.test(body));
  done(assert);
});

function fakeWatchdog({ lines = [], exitAfterMs = null } = {}) {
  const child = new EventEmitter();
  child.pid = 1; child.exitCode = null; child.killed = false;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.kill = () => { child.killed = true; child.exitCode = 1; queueMicrotask(() => child.emit('close', 1)); };
  setTimeout(() => {
    for (const l of lines) child.stdout.emit('data', `${l}\n`);
    if (exitAfterMs != null) setTimeout(() => { child.exitCode = 0; child.emit('close', 0); }, exitAfterMs);
  }, 5);
  return child;
}

test('startInstallerAudioGuard: async, wires MasterHoldMs, never spawnSync', async () => {
  const { check, done } = checker();
  const calls = [];
  const guard = startInstallerAudioGuard({
    rootPid: 0,
    masterHoldMs: 1234,
    watchDirs: ['C:\\payload'],
    _isWindows: true,
    _spawn: (cmd, args) => {
      calls.push(args);
      return args.includes('-RestoreOnly') ? null : fakeWatchdog({ lines: ['MUTED'] });
    },
  });
  check('watchdog spawned once', calls.length === 1);
  const a = calls[0];
  check('MasterHoldMs value', a[a.indexOf('-MasterHoldMs') + 1] === '1234');
  check('watch dirs passed', a[a.indexOf('-WatchDirs') + 1] === 'C:\\payload');
  check('owns master', guard.ownsMaster === true && !a.includes('-NoMaster'));
  await guard.ready;
  check('ready resolved on MUTED', true);
  await guard.stop();
  check('fallback restore when watchdog did not finish cleanly', calls.some((c) => c.includes('-RestoreOnly')));
  done(assert);
});

test('startInstallerAudioGuard: second concurrent guard does not touch the master', async () => {
  const { check, done } = checker();
  const spawned = [];
  const mk = () => startInstallerAudioGuard({
    _isWindows: true,
    _spawn: (cmd, args) => { spawned.push(args); return fakeWatchdog({ lines: ['MUTED'] }); },
  });
  const g1 = mk();
  const g2 = mk();
  check('first owns master', g1.ownsMaster === true);
  check('second is per-session only', g2.ownsMaster === false && spawned[1].includes('-NoMaster'));
  await g2.stop();
  await g1.stop();
  const g3 = mk();
  check('ownership released after stop', g3.ownsMaster === true);
  await g3.stop();
  done(assert);
});

test('runGuardedInstaller: wizard launch reports start + exit, no extras killing', async () => {
  const { check, done } = checker();
  const dir = tmp('guarded-wizard');
  try {
    const setup = path.join(dir, 'setup.exe');
    fs.writeFileSync(setup, 'MZ');
    let args = null;
    const started = [];
    const res = await runGuardedInstaller(setup, {
      _isWindows: true,
      onStarted: ({ pid }) => started.push(pid),
      _spawn: (cmd, a) => {
        if (a.includes('-RestoreOnly')) return null;
        args = a;
        return fakeWatchdog({ lines: ['MUTED', 'STARTED:4321', 'DONE'], exitAfterMs: 10 });
      },
    });
    check('ok', res.ok === true, JSON.stringify(res));
    check('pid', res.pid === 4321);
    check('onStarted fired', started[0] === 4321);
    check('launch exe passed', args[args.indexOf('-LaunchExe') + 1] === setup);
    check('NoExtras in wizard mode', args.includes('-NoExtras'));
    check('payload dir watched', args[args.indexOf('-WatchDirs') + 1].includes(dir));
  } finally { rm(dir); }
  done(assert);
});

test('runGuardedInstaller: UAC decline and unavailable guard', async () => {
  const { check, done } = checker();
  const dir = tmp('guarded-wizard-cancel');
  try {
    const setup = path.join(dir, 'setup.exe');
    fs.writeFileSync(setup, 'MZ');
    const declined = await runGuardedInstaller(setup, {
      _isWindows: true,
      _spawn: (cmd, a) => (a.includes('-RestoreOnly') ? null
        : fakeWatchdog({ lines: ['MUTED', 'CANCELLED'], exitAfterMs: 5 })),
    });
    check('declined → cancelled', declined.ok === false && declined.cancelled === true && declined.error === 'uac-cancelled');
    const offWin = await runGuardedInstaller(setup, { _isWindows: false });
    check('non-windows → guard-unavailable (caller falls back)', offWin.ok === false && offWin.error === 'guard-unavailable');
  } finally { rm(dir); }
  done(assert);
});

test('installerWatchdog SelfTest compiles + walks the process tree', { skip: !WIN }, () => {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WATCHDOG, '-SelfTest',
  ], { timeout: 60000, windowsHide: true, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /SELFTEST:ok/);
});

test('installerWatchdog MuteOnly then RestoreOnly round-trip', { skip: !WIN }, () => {
  const { check, done } = checker();
  const dir = tmp('audio-rt');
  try {
    const state = path.join(dir, 'state.json');
    const mute = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', WATCHDOG,
      '-MuteOnly',
      '-StateFile', state,
    ], { timeout: 20000, windowsHide: true });
    check('MuteOnly ok', mute.status === 0, String(mute.stderr || '').slice(0, 200));
    check('state written', fs.existsSync(state));
    const restore = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', WATCHDOG,
      '-RestoreOnly',
      '-StateFile', state,
    ], { timeout: 20000, windowsHide: true });
    check('RestoreOnly ok', restore.status === 0, String(restore.stderr || '').slice(0, 200));
    check('state cleared', !fs.existsSync(state));
  } finally {
    rm(dir);
  }
  done(assert);
});
