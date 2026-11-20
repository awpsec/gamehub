// Steam-like install flow helpers: wizard install-location discovery via the
// Uninstall registry, uninstaller lookup, and 7-Zip progress parsing.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checker, tmp, rm } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const reg = require('../../client/lib/uninstallRegistry.js');
const installer = require('../../client/lib/installer.js');

const REG_BEFORE = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\7-Zip
    DisplayName    REG_SZ    7-Zip 24.08 (x64)
    UninstallString    REG_SZ    "C:\\Program Files\\7-Zip\\Uninstall.exe"
    InstallLocation    REG_SZ    C:\\Program Files\\7-Zip\\

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Old Game_is1
    DisplayName    REG_SZ    Old Game
    Inno Setup: App Path    REG_SZ    C:\\Games\\Old Game
    UninstallString    REG_SZ    "C:\\Games\\Old Game\\unins000.exe"
`;

function regAfter(gameDir) {
  return `${REG_BEFORE}
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hollow Ember_is1
    Inno Setup: App Path    REG_SZ    ${gameDir}
    InstallLocation    REG_SZ    ${gameDir}\\
    DisplayName    REG_SZ    Hollow Ember
    DisplayVersion    REG_SZ    1.4
    UninstallString    REG_SZ    "${gameDir}\\unins000.exe"
    QuietUninstallString    REG_SZ    "${gameDir}\\unins000.exe" /SILENT

HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{F0C3E5D1-1ADE-321E-8167-68EF0DE699A5}
    DisplayName    REG_SZ    Microsoft Visual C++ 2015-2022 Redistributable (x64)
    UninstallString    REG_SZ    MsiExec.exe /X{F0C3E5D1-1ADE-321E-8167-68EF0DE699A5}
`;
}

test('uninstallRegistry: parse + diff finds the wizard install, skips redists', () => {
  const { check, done } = checker();
  const gameDir = 'C:\\Games\\Hollow Ember';
  const before = reg.parseRegQuery(REG_BEFORE);
  const after = reg.parseRegQuery(regAfter(gameDir));
  check('parsed keys', before.size === 2 && after.size === 4);
  const e = [...after.values()].find((x) => x.displayName === 'Hollow Ember');
  check('value names with spaces', e.innoAppPath === gameDir);
  check('quiet uninstall', /\/SILENT$/.test(e.quietUninstallString));

  const hits = reg.newEntries(before, after, 'Hollow Ember', { _exists: () => true });
  check('one hit', hits.length === 1, JSON.stringify(hits));
  check('install dir', hits[0]?.installDir === gameDir);
  check('uninstaller exe', hits[0]?.uninstallExe === `${gameDir}\\unins000.exe`);
  check('no args', hits[0]?.uninstallArgs === '');
  check('title match flagged', hits[0]?.named === true);

  // reinstall over the same AppId: key unchanged but name matches → still found
  const again = reg.newEntries(after, after, 'Hollow Ember', { _exists: () => true });
  check('reinstall found by name', again.length === 1 && again[0].fresh === false);
  // nonexistent dir is never offered
  check('missing dir dropped', reg.newEntries(before, after, 'Hollow Ember', { _exists: () => false }).length === 0);
  done(assert);
});

test('uninstallRegistry: command parsing', () => {
  const { check, done } = checker();
  check('quoted', reg.exeFromCommand('"C:\\A B\\unins000.exe" /SILENT') === 'C:\\A B\\unins000.exe');
  check('quoted args', reg.argsFromCommand('"C:\\A B\\unins000.exe" /SILENT') === '/SILENT');
  check('unquoted', reg.exeFromCommand('C:\\Games\\X\\uninst.exe /S') === 'C:\\Games\\X\\uninst.exe');
  check('msiexec skipped', reg.exeFromCommand('MsiExec.exe /X{GUID}') === null);
  check('icon index stripped', reg.exeFromCommand('"C:\\G\\game.exe",0') === 'C:\\G\\game.exe');
  check('installDir from uninstaller', reg.installDirOf({ uninstallString: '"C:\\G\\Y\\unins001.exe"' }) === 'C:\\G\\Y');
  done(assert);
});

test('uninstallRegistry.snapshot is empty off Windows and merges roots on Windows', async () => {
  const off = await reg.snapshot({ _isWindows: false });
  assert.equal(off.size, 0);
  const on = await reg.snapshot({ _isWindows: true, _run: async () => regAfter('C:\\Games\\Z') });
  assert.equal(on.size, 4);
});

test('findUninstaller walks up from Binaries/Win64 to the install root', () => {
  const { check, done } = checker();
  const dir = tmp('unins-walk');
  try {
    const exe = path.join(dir, 'Game', 'Binaries', 'Win64', 'Game-Win64-Shipping.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'x');
    check('none yet', installer.findUninstaller({ exe, dir }) === null);
    fs.writeFileSync(path.join(dir, 'unins000.exe'), 'x');
    const hit = installer.findUninstaller({ exe, dir });
    check('found at root', hit?.exe === path.join(dir, 'unins000.exe'));
    // never walks above the install root
    const inner = path.join(dir, 'Game');
    check('stops at root', installer.findUninstaller({ exe, dir: inner }) === null);
    // registered uninstaller wins
    const reg2 = path.join(dir, 'Game', 'uninstall.exe');
    fs.writeFileSync(reg2, 'x');
    const viaReg = installer.findUninstaller({ exe, dir, uninstaller: { exe: reg2, args: '/S' } });
    check('registry uninstaller preferred', viaReg?.exe === reg2 && viaReg.args === '/S');
    // legacy string arg still works
    check('legacy exe path', installer.findUninstaller(path.join(dir, 'x.exe'))?.exe === path.join(dir, 'unins000.exe'));
  } finally { rm(dir); }
  done(assert);
});

test('7-Zip progress parsing + archive-set sizing', () => {
  const { check, done } = checker();
  check('last percent wins', installer.parse7zPercent('  3% 1 - a\b\b\b\b 17% 2 - b') === 17);
  check('none', installer.parse7zPercent('Everything is Ok') === null);
  check('100', installer.parse7zPercent('100%') === 100);
  const dir = tmp('volsize');
  try {
    fs.writeFileSync(path.join(dir, 'game.part01.rar'), Buffer.alloc(100));
    fs.writeFileSync(path.join(dir, 'game.part02.rar'), Buffer.alloc(50));
    fs.writeFileSync(path.join(dir, 'crack.zip'), Buffer.alloc(7));
    fs.writeFileSync(path.join(dir, 'data.7z.001'), Buffer.alloc(30));
    fs.writeFileSync(path.join(dir, 'data.7z.002'), Buffer.alloc(30));
    check('multipart rar', installer.volumeSetSize(path.join(dir, 'game.part01.rar')) === 150);
    check('single zip', installer.volumeSetSize(path.join(dir, 'crack.zip')) === 7);
    check('split 7z', installer.volumeSetSize(path.join(dir, 'data.7z.001')) === 60);
  } finally { rm(dir); }
  done(assert);
});
