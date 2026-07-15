// Stress + orchestration tests for silent Inno / FitGirl install path.
// We cannot run real Windows UAC / Core Audio here — these tests mock spawn
// and exhaustively validate matching, escaping, phase signals, and abort.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { checker, tmp, rm } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const {
  buildInnoArgs,
  writeInnoLoadInf,
  buildElevatedPowerShell,
  runSilentInno,
  startInstallerAudioGuard,
} = require('../../client/lib/silentInstall.js');
const {
  shouldKillInstallerExtra,
  isRedistProcessName,
  isRedistCommandLine,
} = require('../../client/lib/redistKillMatch.js');

function fakeChild({ pid = 4242, withStdout = false } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.killed = false;
  if (withStdout) {
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
  }
  child.kill = () => {
    child.killed = true;
    child.exitCode = 1;
    queueMicrotask(() => child.emit('close', 1));
  };
  child.closeWith = (code) => {
    child.exitCode = code;
    queueMicrotask(() => child.emit('close', code));
  };
  return child;
}

function makeSpawnMock(handler) {
  const calls = [];
  const _spawn = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts, sync: false });
    return handler({ cmd, args, opts, sync: false, calls });
  };
  const _spawnSync = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts, sync: true });
    handler({ cmd, args, opts, sync: true, calls });
    return { status: 0, error: null };
  };
  return { _spawn, _spawnSync, calls };
}

test('redist kill matcher: kills FitGirl extras, spares game + unrelated apps', () => {
  const { check, done } = checker();
  const protect = 1000;
  const self = 1;

  const mustKill = [
    { pid: 10, name: 'DXSETUP.exe', commandLine: 'C:\\Temp\\DXSETUP.exe /silent' },
    { pid: 11, name: 'dxwebsetup.exe', commandLine: '' },
    { pid: 12, name: 'VC_redist.x64.exe', commandLine: 'C:\\_Redist\\VC_redist.x64.exe /quiet' },
    { pid: 13, name: 'vcredist_x86.exe', commandLine: '' },
    { pid: 14, name: 'oalinst.exe', commandLine: '' },
    { pid: 15, name: 'msiexec.exe', commandLine: 'msiexec /i C:\\Temp\\vcredist.msi /qn' },
    { pid: 16, name: 'cmd.exe', commandLine: 'cmd /c C:\\Game\\_CommonRedist\\DirectX\\DXSETUP.exe' },
    { pid: 17, name: 'setup.exe', commandLine: 'C:\\Game\\_Redist\\DirectX\\setup.exe' },
    { pid: 18, name: 'chrome.exe', commandLine: 'chrome.exe https://fitgirl-repacks.site/game' },
    { pid: 19, name: 'msedge.exe', commandLine: 'msedge.exe https://paste.fitgirl-repacks.site/x' },
    { pid: 20, name: 'dotnetfx35.exe', commandLine: '' },
  ];
  for (const p of mustKill) {
    check(`kill ${p.name}`, shouldKillInstallerExtra(p, { protectPid: protect, selfPid: self }));
  }

  const mustSpare = [
    { pid: protect, name: 'setup.exe', commandLine: 'C:\\payload\\setup.exe /VERYSILENT' },
    { pid: self, name: 'powershell.exe', commandLine: 'powershell -File watchdog.ps1' },
    { pid: 30, name: 'chrome.exe', commandLine: 'chrome.exe https://google.com' },
    { pid: 31, name: 'Game.exe', commandLine: 'C:\\Library\\Town\\Game.exe' },
    { pid: 32, name: 'msiexec.exe', commandLine: 'msiexec /i C:\\Temp\\SomeOther.msi' },
    { pid: 33, name: 'explorer.exe', commandLine: 'C:\\Windows\\explorer.exe' },
    { pid: 34, name: 'notepad.exe', commandLine: 'notepad C:\\Game\\readme.txt' },
  ];
  for (const p of mustSpare) {
    check(`spare ${p.name} pid=${p.pid}`, !shouldKillInstallerExtra(p, { protectPid: protect, selfPid: self }));
  }
  done(assert);
});

test('redist kill matcher: stress 2000 synthetic process rows', () => {
  const { check, done } = checker();
  let kills = 0;
  let spares = 0;
  for (let i = 0; i < 2000; i++) {
    const kind = i % 10;
    let proc;
    let expectKill;
    if (kind === 0) {
      proc = { pid: 10000 + i, name: 'DXSETUP.exe', commandLine: `X:\\t\\${i}\\DXSETUP.exe` };
      expectKill = true;
    } else if (kind === 1) {
      proc = { pid: 10000 + i, name: `VC_redist.x64.exe`, commandLine: `C:\\_CommonRedist\\vc\\VC_redist.x64.exe /install /quiet` };
      expectKill = true;
    } else if (kind === 2) {
      proc = { pid: 10000 + i, name: 'msiexec.exe', commandLine: `msiexec /i C:\\Temp\\vcredist_${i}.msi /qn` };
      expectKill = true;
    } else if (kind === 3) {
      proc = { pid: 10000 + i, name: 'chrome.exe', commandLine: `chrome https://fitgirl-repacks.site/${i}` };
      expectKill = true;
    } else if (kind === 4) {
      proc = { pid: 10000 + i, name: 'setup.exe', commandLine: `D:\\Game\\_Redist\\DirectX\\setup.exe` };
      expectKill = true;
    } else {
      proc = { pid: 10000 + i, name: `GameHubApp${i}.exe`, commandLine: `C:\\Apps\\app${i}.exe --run` };
      expectKill = false;
    }
    const got = shouldKillInstallerExtra(proc, { protectPid: 1, selfPid: 2 });
    if (got !== expectKill) {
      check(`row ${i} ${proc.name}`, false, `expected kill=${expectKill} got=${got}`);
    }
    if (got) kills++;
    else spares++;
  }
  check('killed a substantial share', kills >= 800);
  check('spared a substantial share', spares >= 800);
  done(assert);
});

test('buildInnoArgs + LOADINF stress: weird paths stay single argv elements', () => {
  const { check, done } = checker();
  const weird = [
    `C:\\Games\\O'Brien's Game`,
    `D:\\Lib\\Title (2024) — Remastered`,
    `E:\\path with spaces & ampersands`,
    `F:\\unicode\\ゲーム\\Town`,
    `G:\\trailing\\slash\\`,
    `H:\\$weird%percent%`,
    `I:\\foo;bar&baz|qux`,
  ];
  for (const dir of weird) {
    const log = path.join(dir, '_staging', 'inno.log');
    const inf = path.join(dir, 'setup.inf');
    const args = buildInnoArgs(dir, log, { loadInfPath: inf });
    check(`DIR intact: ${dir.slice(0, 40)}`, args.includes(`/DIR=${dir}`));
    check(`LOG intact`, args.includes(`/LOG=${log}`));
    check(`LOADINF intact`, args.includes(`/LOADINF=${inf}`));
    check('has /TASKS=', args.includes('/TASKS='));
    check('no MERGETASKS', !args.some((a) => a.startsWith('/MERGETASKS=')));
    check('VERYSILENT', args.includes('/VERYSILENT'));
  }

  // 300 random-ish path shapes
  for (let i = 0; i < 300; i++) {
    const dir = `C:\\G\\Title ${i} (x) & Co'\\bin`;
    const args = buildInnoArgs(dir, null);
    check(`stress DIR ${i}`, args.includes(`/DIR=${dir}`) && args.includes('/TASKS='));
  }
  done(assert);
});

test('buildElevatedPowerShell: runner path escapes and wires started/stop files', () => {
  const { check, done } = checker();
  const ps = buildElevatedPowerShell(
    `C:\\Games\\O'Brien\\setup.exe`,
    ['/VERYSILENT', '/TASKS=', `/DIR=D:\\Lib\\Town`],
    `C:\\Games\\O'Brien`,
    {
      runnerScript: `C:\\Temp\\O'Brien\\runner.ps1`,
      argsFile: `C:\\Temp\\O'Brien\\args.txt`,
      startedFile: `C:\\Temp\\O'Brien\\started.txt`,
      stopFile: `C:\\Temp\\O'Brien\\stop.txt`,
      aliveFile: `C:\\Temp\\O'Brien\\alive.txt`,
      doneFile: `C:\\Temp\\O'Brien\\done.txt`,
    },
  );
  check('RunAs elevates powershell runner', ps.includes("-Verb RunAs") && ps.includes('powershell.exe'));
  check('escaped apostrophes', ps.includes(`O''Brien`));
  check('passes SetupExe', ps.includes('SetupExe'));
  check('passes ArgsFile', ps.includes('ArgsFile'));
  check('waits for started file', ps.includes('started.txt'));
  check('alive + done handshake', ps.includes('alive.txt') && ps.includes('done.txt'));
  check('stop file wired', ps.includes('stop.txt'));
  check('emits ELEVATED_STARTED', /ELEVATED_STARTED:/.test(ps));
  check('UAC cancel → 1223 only on Start-Process failure', ps.includes('} catch { exit 1223 }'));
  check('never maps HasExited to decline', !ps.includes('HasExited) { exit 1223 }') && !ps.includes('$elev.HasExited'));
  check('does not Start-Process setup with RunAs directly when runner present',
    !ps.includes(`Start-Process -FilePath 'C:\\Games\\O''Brien\\setup.exe'`));
  done(assert);
});

test('writeInnoLoadInf forces empty Tasks', () => {
  const { check, done } = checker();
  const dir = tmp('inf');
  try {
    const inf = path.join(dir, 'setup.inf');
    writeInnoLoadInf(`C:\\Games\\Town to City`, inf);
    const body = fs.readFileSync(inf, 'utf8');
    check('has Tasks=', /^Tasks=\s*$/m.test(body) || body.includes('Tasks=\r\n') || body.includes('Tasks=\n'));
    check('has NoIcons=1', body.includes('NoIcons=1'));
    check('has Dir', body.includes('Dir=C:\\Games\\Town to City'));
  } finally {
    rm(dir);
  }
  done(assert);
});

test('PowerShell scripts: structural integrity + elevated kill alignment', () => {
  const { check, done } = checker();
  const lib = path.dirname(require.resolve('../../client/lib/silentInstall.js'));
  for (const name of ['installerWatchdog.ps1', 'elevatedSilentRunner.ps1']) {
    const body = fs.readFileSync(path.join(lib, name), 'utf8');
    const opens = (body.match(/\{/g) || []).length;
    const closes = (body.match(/\}/g) || []).length;
    check(`${name} balanced braces`, opens === closes, `${opens} vs ${closes}`);
    check(`${name} non-empty`, body.length > 500);
  }
  const elev = fs.readFileSync(path.join(lib, 'elevatedSilentRunner.ps1'), 'utf8');
  check('elevated kills DXSETUP', /dxsetup/i.test(elev));
  check('elevated kills VC redist', /vc_redist|vcredist/i.test(elev));
  check('elevated post-exit sweep', /PostExitSweepSeconds|AddSeconds/i.test(elev));
  check('elevated protects setup pid', /ProtectPid/i.test(elev));
  check('elevated uses taskkill', /taskkill/i.test(elev));
  // setup.exe under DirectX folder must be killable (regression)
  check('elevated kills setup under DirectX/_Redist paths',
    /CommonRedist|_Redist|\\DirectX\\/i.test(elev)
    && /base -match 'setup\|install\|redist\|dx\|vc'/i.test(elev.replace(/\s+/g, ' '))
      || (elev.includes('setup|install|redist|dx|vc') && !elev.includes("$base -notmatch '^(setup)$'")));
  done(assert);
});

test('audio guard: on Windows seam, MuteOnly runs before watchdog spawn', () => {
  const { check, done } = checker();
  const order = [];
  const watchdog = fakeChild({ pid: 77 });
  watchdog.exitCode = 0; // pretend already done so stop() doesn't spin
  const { _spawn, _spawnSync, calls } = makeSpawnMock(({ sync }) => {
    order.push(sync ? 'sync' : 'async');
    if (sync) return null;
    return watchdog;
  });
  const guard = startInstallerAudioGuard({
    rootPid: 0,
    _spawn,
    _spawnSync,
    _isWindows: true,
  });
  check('MuteOnly sync first', calls[0]?.sync === true && calls[0].args.includes('-MuteOnly'));
  check('watchdog async second', calls[1]?.sync === false && calls[1].args.includes('-File'));
  check('order sync then async', order[0] === 'sync' && order[1] === 'async');
  guard.setRootPid(9999);
  guard.stop();
  check('stop issues RestoreOnly', calls.some((c) => c.sync && c.args.includes('-RestoreOnly')));
  done(assert);
});

test('runSilentInno elevated: mute → UAC accept → phase advance → success', async () => {
  const dir = tmp('elev-ok');
  try {
    const setup = path.join(dir, 'setup.exe');
    const target = path.join(dir, 'target');
    fs.writeFileSync(setup, 'MZ');
    fs.mkdirSync(target, { recursive: true });

    const phases = [];
    const { _spawn, _spawnSync, calls } = makeSpawnMock(({ cmd, args, sync }) => {
      if (sync) return null;
      if (cmd === 'powershell.exe' && args.includes('-Command')) {
        const elevChild = fakeChild({ pid: 50, withStdout: true });
        queueMicrotask(() => {
          const script = args[args.length - 1] || '';
          const alive = script.match(/\$alive = '([^']+)'/)?.[1]?.replace(/''/g, "'");
          const started = script.match(/\$started = '([^']+)'/)?.[1]?.replace(/''/g, "'");
          const done = script.match(/\$done = '([^']+)'/)?.[1]?.replace(/''/g, "'");
          for (const f of [alive, started, done]) {
            if (!f) continue;
            try {
              fs.mkdirSync(path.dirname(f), { recursive: true });
            } catch { /* */ }
          }
          if (alive) fs.writeFileSync(alive, '9001', 'utf8');
          if (started) fs.writeFileSync(started, '7777', 'utf8');
          elevChild.stdout.emit('data', 'ELEVATED_STARTED:7777\n');
          setTimeout(() => {
            if (done) fs.writeFileSync(done, '0', 'utf8');
            elevChild.closeWith(0);
          }, 20);
        });
        return elevChild;
      }
      const w = fakeChild({ pid: 51 });
      w.exitCode = 0;
      w.killed = false;
      return w;
    });

    const result = await runSilentInno(setup, target, {
      requiresAdmin: true,
      onElevate: () => phases.push('waiting-admin'),
      onElevatedStarted: ({ pid }) => phases.push(`started:${pid}`),
      _spawn,
      _spawnSync,
      _isWindows: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.elevated, true);
    assert.deepEqual(phases, ['waiting-admin', 'started:7777']);
    assert.ok(calls.some((c) => c.sync && c.args.includes('-MuteOnly')));
    const elev = calls.find((c) => !c.sync && c.args?.includes('-Command'));
    const body = elev?.args?.[elev.args.length - 1] || '';
    assert.ok(body.includes('AliveFile') || body.includes('alive'));
    assert.ok(!body.includes('$elev.HasExited'));
  } finally {
    rm(dir);
  }
});

test('runSilentInno elevated: false 1223 after alive/started is NOT uac-cancelled', async () => {
  // Regression: unelevated HasExited on RunAs powershell used to report decline
  // even after the user accepted (UAC shows powershell.exe).
  const dir = tmp('elev-false-decline');
  try {
    const setup = path.join(dir, 'setup.exe');
    const target = path.join(dir, 'target');
    fs.writeFileSync(setup, 'MZ');
    fs.mkdirSync(target, { recursive: true });
    const phases = [];
    const { _spawn, _spawnSync } = makeSpawnMock(({ cmd, args, sync }) => {
      if (sync) return null;
      if (cmd === 'powershell.exe' && args.includes('-Command')) {
        const child = fakeChild({ pid: 55, withStdout: true });
        queueMicrotask(() => {
          const script = args[args.length - 1] || '';
          const alive = script.match(/\$alive = '([^']+)'/)?.[1]?.replace(/''/g, "'");
          const started = script.match(/\$started = '([^']+)'/)?.[1]?.replace(/''/g, "'");
          const done = script.match(/\$done = '([^']+)'/)?.[1]?.replace(/''/g, "'");
          for (const f of [alive, started, done]) {
            if (!f) continue;
            try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { /* */ }
          }
          if (alive) fs.writeFileSync(alive, '1', 'utf8');
          if (started) fs.writeFileSync(started, '4242', 'utf8');
          child.stdout.emit('data', 'ELEVATED_STARTED:4242\n');
          setTimeout(() => {
            if (done) fs.writeFileSync(done, '0', 'utf8');
            // Simulate the old bug: wrapper exits 1223 even though install succeeded.
            child.closeWith(1223);
          }, 25);
        });
        return child;
      }
      const w = fakeChild({ pid: 56 });
      w.exitCode = 0;
      return w;
    });
    const result = await runSilentInno(setup, target, {
      requiresAdmin: true,
      onElevate: () => phases.push('waiting'),
      onElevatedStarted: ({ pid }) => phases.push(`started:${pid}`),
      _spawn,
      _spawnSync,
      _isWindows: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.notEqual(result.error, 'uac-cancelled');
    assert.ok(phases.includes('started:4242'));
  } finally {
    rm(dir);
  }
});

test('runSilentInno elevated: UAC cancel returns uac-cancelled', async () => {
  const dir = tmp('elev-cancel');
  try {
    const setup = path.join(dir, 'setup.exe');
    const target = path.join(dir, 'target');
    fs.writeFileSync(setup, 'MZ');
    const { _spawn, _spawnSync } = makeSpawnMock(({ cmd, args, sync }) => {
      if (sync) return null;
      if (cmd === 'powershell.exe' && args.includes('-Command')) {
        const child = fakeChild({ pid: 60, withStdout: true });
        queueMicrotask(() => child.closeWith(1223));
        return child;
      }
      const w = fakeChild({ pid: 61 });
      w.exitCode = 0;
      return w;
    });
    const result = await runSilentInno(setup, target, {
      requiresAdmin: true,
      _spawn,
      _spawnSync,
      _isWindows: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'uac-cancelled');
    assert.equal(result.exitCode, 1223);
  } finally {
    rm(dir);
  }
});

test('runSilentInno non-elevated: elevation required then elevated success', async () => {
  const dir = tmp('elev-retry');
  try {
    const setup = path.join(dir, 'setup.exe');
    const target = path.join(dir, 'target');
    fs.writeFileSync(setup, 'MZ');
    const phases = [];
    const { _spawn, _spawnSync } = makeSpawnMock(({ cmd, args, sync }) => {
      if (sync) return null;
      if (cmd === setup) {
        const child = fakeChild({ pid: 70 });
        queueMicrotask(() => child.closeWith(740));
        return child;
      }
      if (cmd === 'powershell.exe' && args.includes('-Command')) {
        const child = fakeChild({ pid: 71, withStdout: true });
        queueMicrotask(() => {
          const script = args[args.length - 1] || '';
          const alive = script.match(/\$alive = '([^']+)'/)?.[1]?.replace(/''/g, "'");
          const started = script.match(/\$started = '([^']+)'/)?.[1]?.replace(/''/g, "'");
          const done = script.match(/\$done = '([^']+)'/)?.[1]?.replace(/''/g, "'");
          for (const f of [alive, started, done]) {
            if (!f) continue;
            try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { /* */ }
          }
          if (alive) fs.writeFileSync(alive, '1', 'utf8');
          if (started) fs.writeFileSync(started, '8888', 'utf8');
          child.stdout.emit('data', 'ELEVATED_STARTED:8888\n');
          setTimeout(() => {
            if (done) fs.writeFileSync(done, '0', 'utf8');
            child.closeWith(0);
          }, 15);
        });
        return child;
      }
      const w = fakeChild({ pid: 72 });
      w.exitCode = 0;
      return w;
    });
    const result = await runSilentInno(setup, target, {
      requiresAdmin: false,
      onElevate: () => phases.push('elevate'),
      onElevatedStarted: () => phases.push('started'),
      onInstallerStarted: () => phases.push('nonadmin-started'),
      _spawn,
      _spawnSync,
      _isWindows: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.elevated, true);
    assert.ok(phases.includes('nonadmin-started'));
    assert.ok(phases.includes('elevate'));
    assert.ok(phases.includes('started'));
  } finally {
    rm(dir);
  }
});

test('runSilentInno abort mid-elevated writes stop file and finishes cancelled', async () => {
  const dir = tmp('elev-abort');
  try {
    const setup = path.join(dir, 'setup.exe');
    const target = path.join(dir, 'target');
    fs.writeFileSync(setup, 'MZ');
    const ac = new AbortController();
    let stopPath = null;
    const { _spawn, _spawnSync, calls } = makeSpawnMock(({ cmd, args, sync }) => {
      if (sync) return null;
      if (cmd === 'powershell.exe' && args.includes('-Command')) {
        const child = fakeChild({ pid: 80, withStdout: true });
        const script = args[args.length - 1] || '';
        const sm = script.match(/\$stop = '([^']*)'/);
        if (sm && sm[1]) stopPath = sm[1].replace(/''/g, "'");
        queueMicrotask(() => {
          const m = script.match(/\$started = '([^']+)'/);
          if (m) {
            try {
              fs.mkdirSync(path.dirname(m[1]), { recursive: true });
              fs.writeFileSync(m[1].replace(/''/g, "'"), '9999');
            } catch { /* */ }
          }
          child.stdout.emit('data', 'ELEVATED_STARTED:9999\n');
          setTimeout(() => ac.abort('cancelled'), 10);
        });
        return child;
      }
      const w = fakeChild({ pid: 81 });
      w.exitCode = 0;
      return w;
    });
    const result = await runSilentInno(setup, target, {
      requiresAdmin: true,
      signal: ac.signal,
      _spawn,
      _spawnSync,
      _isWindows: true,
    });
    assert.equal(result.error, 'cancelled');
    assert.ok(calls.some((c) => c.sync && String(c.cmd).includes('taskkill')));
    assert.ok(typeof stopPath === 'string' && stopPath.length > 0);
  } finally {
    rm(dir);
  }
});

test('runSilentInno concurrent stress: 25 mocked elevated installs', async () => {
  const root = tmp('conc');
  try {
    const jobs = [];
    for (let i = 0; i < 25; i++) {
      const dir = path.join(root, `g${i}`);
      fs.mkdirSync(dir, { recursive: true });
      const setup = path.join(dir, 'setup.exe');
      const target = path.join(dir, 'target');
      fs.writeFileSync(setup, 'MZ');
      fs.mkdirSync(target, { recursive: true });
      const { _spawn, _spawnSync } = makeSpawnMock(({ cmd, args, sync }) => {
        if (sync) return null;
        if (cmd === 'powershell.exe' && args.includes('-Command')) {
          const child = fakeChild({ pid: 1000 + i, withStdout: true });
          queueMicrotask(() => {
            const script = args[args.length - 1] || '';
            const alive = script.match(/\$alive = '([^']+)'/)?.[1]?.replace(/''/g, "'");
            const started = script.match(/\$started = '([^']+)'/)?.[1]?.replace(/''/g, "'");
            const done = script.match(/\$done = '([^']+)'/)?.[1]?.replace(/''/g, "'");
            for (const f of [alive, started, done]) {
              if (!f) continue;
              try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { /* */ }
            }
            if (alive) fs.writeFileSync(alive, '1', 'utf8');
            if (started) fs.writeFileSync(started, String(5000 + i), 'utf8');
            child.stdout.emit('data', `ELEVATED_STARTED:${5000 + i}\n`);
            setTimeout(() => {
              const code = i % 7 === 0 ? 1 : 0;
              if (done) fs.writeFileSync(done, String(code), 'utf8');
              child.closeWith(code);
            }, 5 + (i % 5));
          });
          return child;
        }
        const w = fakeChild({ pid: 2000 + i });
        w.exitCode = 0;
        return w;
      });
      jobs.push(runSilentInno(setup, target, {
        requiresAdmin: true,
        _spawn,
        _spawnSync,
        _isWindows: true,
      }));
    }
    const results = await Promise.all(jobs);
    const oks = results.filter((r) => r.ok).length;
    const fails = results.filter((r) => !r.ok).length;
    assert.equal(results.length, 25);
    assert.ok(oks >= 20, `oks=${oks}`);
    assert.ok(fails >= 1, `fails=${fails}`);
    assert.ok(results.every((r) => r.elevated === true));
  } finally {
    rm(root);
  }
});

test('elevatedSilentRunner script is present and kill-aligned with JS matcher', () => {
  const bundled = path.join(
    path.dirname(require.resolve('../../client/lib/silentInstall.js')),
    'elevatedSilentRunner.ps1',
  );
  assert.ok(fs.existsSync(bundled));
  const body = fs.readFileSync(bundled, 'utf8');
  assert.ok(body.includes('AliveFile') || body.includes('$AliveFile'));
  assert.ok(body.includes('DoneFile') || body.includes('Write-Done'));
  assert.ok(body.includes('Stop-AllExtras') || body.includes('ProtectPid'));
  assert.ok(/dxsetup/i.test(body));
  assert.ok(/vc_redist|vcredist/i.test(body));
  assert.ok(body.includes('setup|install|redist|dx|vc'));
  assert.ok(!body.includes("$base -notmatch '^(setup)$'"));
  assert.equal(typeof isRedistProcessName, 'function');
  assert.ok(isRedistCommandLine('C:\\_Redist\\DXSETUP.exe'));
});
