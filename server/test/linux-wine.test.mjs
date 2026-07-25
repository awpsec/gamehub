// Linux Wine/Proton runner + platform seam tests.
// Host Wine is optional — CI runners typically lack it. Pure helpers always run;
// live Wine detection/launch tests skip when no runner is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checker, tmp, rm } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const wine = require('../../client/lib/wineRunner.js');
const platform = require('../../client/lib/platform.js');
const installer = require('../../client/lib/installer.js');
const { canAutoSilentInstall, runSilentInnoWine } = require('../../client/lib/silentInstall.js');

const HAS_WINE = !!wine.findWineBinary();

test('toWinePath maps absolute Linux paths to Z:', () => {
  const { check, done } = checker();
  check('root file', wine.toWinePath('/tmp/game.exe') === 'Z:\\tmp\\game.exe');
  check('nested', wine.toWinePath('/home/u/Games/Title/game.exe') === 'Z:\\home\\u\\Games\\Title\\game.exe');
  check('resolves relative', wine.toWinePath('foo').startsWith('Z:'));
  done(assert);
});

test('winePrefixPath keeps prefixes outside the install target', () => {
  const { check, done } = checker();
  const base = '/home/u/Games';
  const p = wine.winePrefixPath(base, 'Cool Game');
  check('under _wineprefixes', p.includes('_wineprefixes'));
  check('keeps title key', p.endsWith(path.join('_wineprefixes', 'Cool Game')));
  check('under library root', p.startsWith(base));
  check('not the install dir itself', p !== path.join(base, 'Cool Game'));
  done(assert);
});

test('resolveRunner reports availability from PATH', () => {
  const { check, done } = checker();
  const r = wine.resolveRunner({ linuxRunner: 'wine' });
  if (HAS_WINE) {
    check('available', r.available === true);
    check('kind wine', r.kind === 'wine');
    check('cmd set', !!r.cmd);
    check('hasCompatibleRunner', wine.hasCompatibleRunner({ linuxRunner: 'wine' }) === true);
  } else {
    check('unavailable without wine', r.available === false);
    check('hasCompatibleRunner false', wine.hasCompatibleRunner({ linuxRunner: 'wine' }) === false);
  }
  done(assert);
});

test('launchWindowsExe wraps exe with wine argv', { skip: !HAS_WINE }, () => {
  const { check, done } = checker();
  const exe = '/tmp/FakeGame/game.exe';
  const launch = wine.launchWindowsExe(exe, { linuxRunner: 'wine' }, {
    prefixDir: '/tmp/gamehub-test-prefix',
  });
  check('cmd is wine', /wine/i.test(launch.cmd));
  check('args include exe', launch.args.includes(path.resolve(exe)));
  check('cwd is dir', launch.cwd === path.dirname(path.resolve(exe)));
  check('WINEPREFIX set', launch.env.WINEPREFIX === '/tmp/gamehub-test-prefix');
  done(assert);
});

test('launchWindowsExe throws NO_WINE when runner missing', { skip: HAS_WINE }, () => {
  const { check, done } = checker();
  let code = null;
  try {
    wine.launchWindowsExe('/tmp/FakeGame/game.exe', { linuxRunner: 'wine' });
  } catch (err) {
    code = err.code;
  }
  check('NO_WINE', code === 'NO_WINE');
  done(assert);
});

test('platform.launchCommand on Linux returns wine wrapper', { skip: process.platform !== 'linux' || !HAS_WINE }, () => {
  const { check, done } = checker();
  check('isLinux', platform.isLinux === true);
  check('supportsShortcuts', platform.supportsShortcuts() === true);
  check('hasWineRunner', platform.hasWineRunner({ linuxRunner: 'wine' }) === true);
  const launch = platform.launchCommand('/opt/Games/Title/game.exe', {
    linuxRunner: 'wine',
    winePrefix: '/tmp/pfx',
  });
  check('wrapped', launch.args.some((a) => String(a).includes('game.exe')));
  check('env', !!launch.env?.WINEPREFIX);
  done(assert);
});

test('platform.supportsShortcuts is true on Linux even without Wine', { skip: process.platform !== 'linux' }, () => {
  const { check, done } = checker();
  check('shortcuts', platform.supportsShortcuts() === true);
  check('hasWineRunner mirrors PATH', platform.hasWineRunner() === HAS_WINE);
  done(assert);
});

test('canAutoSilentInstall allows Linux when wineAvailable', () => {
  const { check, done } = checker();
  const fp = {
    engine: 'inno', engineLabel: 'Inno Setup', automatable: true, confidence: 'high',
  };
  const noWine = canAutoSilentInstall({
    fingerprint: fp, autoSilentPref: true, isWindows: false, isLinux: true, wineAvailable: false,
  });
  check('no wine', noWine.ok === false && noWine.reason === 'wine-unavailable');

  const withWine = canAutoSilentInstall({
    fingerprint: fp, autoSilentPref: true, isWindows: false, isLinux: true, wineAvailable: true,
  });
  check('with wine', withWine.ok === true && withWine.reason === 'eligible');

  const win = canAutoSilentInstall({
    fingerprint: fp, autoSilentPref: true, isWindows: true, isLinux: false,
  });
  check('windows still works', win.ok === true);

  // CI is Linux: isWindows:true must not inherit a Wine gate from platform.isLinux
  const winSeamOnLinuxHost = canAutoSilentInstall({
    fingerprint: fp, autoSilentPref: true, isWindows: true,
  });
  check('windows seam ignores host linux', winSeamOnLinuxHost.ok === true);

  const mac = canAutoSilentInstall({
    fingerprint: fp, autoSilentPref: true, isWindows: false, isLinux: false,
  });
  check('mac unsupported', mac.ok === false && mac.reason === 'unsupported-platform');
  done(assert);
});

test('Linux .desktop shortcuts are written', { skip: process.platform !== 'linux' }, () => {
  const { check, done } = checker();
  const dir = tmp('desktop-sc');
  const exe = path.join(dir, 'CoolGame.exe');
  fs.writeFileSync(exe, 'MZ');
  const desktopPath = path.join(dir, 'Cool Game.desktop');
  installer.writeDesktopShortcut(desktopPath, 'Cool Game', exe, {
    winePrefix: path.join(dir, 'pfx'),
    linuxRunner: 'wine',
  });
  check('exists', fs.existsSync(desktopPath));
  const body = fs.readFileSync(desktopPath, 'utf8');
  check('desktop entry', body.includes('[Desktop Entry]'));
  check('name', body.includes('Name=Cool Game'));
  // With or without Wine on PATH, Exec still mentions wine + the exe
  check('exec winey', /wine/i.test(body) && body.includes('CoolGame.exe'));
  check('executable bit', !!(fs.statSync(desktopPath).mode & 0o111));
  rm(dir);
  done(assert);
});

test('runSilentInnoWine spawns wine with Wine-mapped /DIR=', async () => {
  const { check, done } = checker();
  if (process.platform !== 'linux') {
    check('skip', true);
    return done(assert);
  }
  const root = tmp('wine-silent');
  const setup = path.join(root, 'setup.exe');
  const target = path.join(root, 'Game');
  fs.writeFileSync(setup, 'MZ-fake');
  fs.mkdirSync(target, { recursive: true });

  const seen = [];
  const fakeSpawn = (cmd, args) => {
    seen.push({ cmd, args });
    const { EventEmitter } = require('node:events');
    const ee = new EventEmitter();
    ee.pid = 4242;
    ee.kill = () => {};
    setImmediate(() => ee.emit('close', 0));
    return ee;
  };

  const result = await runSilentInnoWine(setup, target, {
    engine: 'inno',
    winePrefix: path.join(root, 'pfx'),
    config: { linuxRunner: 'wine' },
    _spawn: fakeSpawn,
    _resolveRunner: () => ({
      available: true,
      cmd: '/usr/bin/wine',
      argsBefore: [],
      env: { WINEPREFIX: path.join(root, 'pfx') },
      kind: 'wine',
    }),
  });

  check('ok', result.ok === true);
  check('spawned once', seen.length === 1);
  check('wine cmd', seen[0].cmd === '/usr/bin/wine');
  check('setup first arg after wine', seen[0].args[0] === path.resolve(setup));
  const dirArg = seen[0].args.find((a) => String(a).startsWith('/DIR='));
  check('DIR wine path', dirArg === `/DIR=${wine.toWinePath(target)}`);
  check('VERYSILENT', seen[0].args.includes('/VERYSILENT'));
  check('prefix returned', result.winePrefix === path.join(root, 'pfx'));
  rm(root);
  done(assert);
});

test('runSilentInnoWine NSIS keeps unquoted /D= Wine path last', async () => {
  const { check, done } = checker();
  const root = tmp('wine-nsis');
  const setup = path.join(root, 'setup.exe');
  const target = path.join(root, 'My Game');
  fs.writeFileSync(setup, 'MZ');
  fs.mkdirSync(target, { recursive: true });
  let args;
  const fakeSpawn = (_cmd, a) => {
    args = a;
    const { EventEmitter } = require('node:events');
    const ee = new EventEmitter();
    ee.pid = 1;
    ee.kill = () => {};
    setImmediate(() => ee.emit('close', 0));
    return ee;
  };
  await runSilentInnoWine(setup, target, {
    engine: 'nsis',
    winePrefix: path.join(root, 'pfx'),
    _spawn: fakeSpawn,
    _resolveRunner: () => ({ available: true, cmd: 'wine', argsBefore: [], env: {} }),
  });
  check('/S present', args.includes('/S'));
  check('/D last', args[args.length - 1] === `/D=${wine.toWinePath(target)}`);
  rm(root);
  done(assert);
});
