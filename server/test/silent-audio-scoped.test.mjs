// Scoped audio mute: master hold then per-session. Drives the REAL watchdog
// script's structure + (on Windows) a short MasterHoldMs cycle with MuteOnly.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { checker, tmp, rm } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { startInstallerAudioGuard } = require('../../client/lib/silentInstall.js');

const WATCHDOG = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')),
  '../../client/lib/installerWatchdog.ps1',
);
const WIN = process.platform === 'win32';

test('installerWatchdog: scoped-mute structure', () => {
  const { check, done } = checker();
  const body = fs.readFileSync(WATCHDOG, 'utf8');
  check('MasterHoldMs', body.includes('[int]$MasterHoldMs'));
  check('MuteSessionsForPids', body.includes('MuteSessionsForPids'));
  check('IAudioSessionControl2', body.includes('IAudioSessionControl2') && body.includes('GetProcessId'));
  check('fixed ISimpleAudioVolume GUID', body.includes('87CE5498-68D6-44E5-A1FC-635806365766'));
  check('old wrong GUID gone', !body.includes('87CE5498-68D6-140E-49E3-635806365766'));
  check('Release-MasterMute', body.includes('function Release-MasterMute'));
  check('KeepFile restore', body.includes('-KeepFile') || body.includes('KeepFile'));
  check('no MuteAllSessions blanket', !body.includes('MuteAllSessions'));
  check('still kills redists', /dxsetup|vcredist/i.test(body));
  done(assert);
});

test('startInstallerAudioGuard wires MasterHoldMs', () => {
  const { check, done } = checker();
  const calls = [];
  const fakeChild = {
    pid: 1, exitCode: 0, killed: false,
    kill() { this.killed = true; },
    on() {},
  };
  const guard = startInstallerAudioGuard({
    rootPid: 0,
    masterHoldMs: 1234,
    _isWindows: true,
    _spawnSync: (cmd, args) => { calls.push({ sync: true, args }); return { status: 0 }; },
    _spawn: (cmd, args) => { calls.push({ sync: false, args }); return fakeChild; },
  });
  check('MuteOnly first', calls[0]?.sync && calls[0].args.includes('-MuteOnly'));
  const asyncCall = calls.find((c) => !c.sync);
  check('watchdog spawned', !!asyncCall);
  const idx = asyncCall.args.indexOf('-MasterHoldMs');
  check('MasterHoldMs flag', idx >= 0);
  check('MasterHoldMs value', asyncCall.args[idx + 1] === '1234');
  guard.stop();
  done(assert);
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
