// One-click installs for every package type: engine detection, the exact
// silent command lines, eligibility, and the Steam-style library folder.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmp, rm } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const silent = require('../../client/lib/silentInstall.js');
const { fingerprintInstaller } = require('../../client/lib/fingerprint.js');
const lib = require('../../client/lib/libraryRoot.js');

const DIR = 'C:\\Program Files (x86)\\Gamehub\\games\\My Game';
const line = (p) => (p.verbatim ? p.args.map(silent.quoteSilentArg) : p.args.map(silent.windowsQuoteArg)).join(' ');

// minimal PE (MZ + PE header) with marker strings in the body
function fakePe(dir, name, ...markers) {
  const head = Buffer.alloc(0x200);
  head.write('MZ', 0, 'latin1');
  head.writeUInt32LE(0x80, 0x3c);
  head.write('PE\0\0', 0x80, 'latin1');
  const body = Buffer.concat(markers.map((m) => (Buffer.isBuffer(m) ? m : Buffer.from(m, 'latin1'))));
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.concat([head, body, Buffer.alloc(4096)]));
  return p;
}

test('silent command lines keep spaced Program Files paths intact', () => {
  const msi = silent.silentPlan('msi', 'C:\\dl\\game.msi', DIR, { logPath: 'C:\\t\\m.log' });
  assert.match(msi.exe, /msiexec\.exe$/i);
  assert.ok(msi.requiresAdmin, 'per-machine MSI must elevate (no UAC under /qn)');
  assert.match(line(msi), /^\/i C:\\dl\\game\.msi \/qn \/norestart TARGETDIR="C:\\Program Files \(x86\)\\Gamehub\\games\\My Game" INSTALLDIR="/);
  assert.deepStrictEqual(msi.okCodes, [0, 3010, 1641]);

  const is = silent.silentPlan('installshield', 'C:\\dl\\setup.exe', DIR);
  assert.strictEqual(line(is), `/s /v"/qn /norestart INSTALLDIR=\\"${DIR}\\" TARGETDIR=\\"${DIR}\\""`);

  const burn = silent.silentPlan('burn', 'C:\\dl\\setup.exe', DIR);
  assert.strictEqual(line(burn), `/quiet /norestart "InstallFolder=${DIR}" "INSTALLFOLDER=${DIR}"`);

  const nsis = silent.silentPlan('nsis', 'C:\\dl\\setup.exe', DIR);
  assert.strictEqual(line(nsis), `/S /D=${DIR}`, 'NSIS /D= stays unquoted and last');

  const inno = silent.silentPlan('inno', 'C:\\dl\\setup.exe', DIR);
  assert.match(line(inno), new RegExp(`"/DIR=${DIR.replace(/[\\()]/g, '\\$&')}"`));
});

test('raw args pass through the elevated PowerShell builder untouched', () => {
  const ps = silent.buildElevatedPowerShell('C:\\Windows\\System32\\msiexec.exe', ['/i', 'C:\\a b\\g.msi', silent.rawArg('TARGETDIR="C:\\x y"')], 'C:\\a b');
  assert.ok(ps.includes('TARGETDIR="C:\\x y"'), ps);
  assert.ok(!ps.includes('@raw@'));
  const runner = fs.readFileSync(new URL('../../client/lib/elevatedSilentRunner.ps1', import.meta.url), 'utf8');
  assert.match(runner, /StartsWith\('@raw@'\)/, 'runner keeps raw args raw');
});

test('fingerprint: WiX bundles, InstallShield and MSI are automatable', () => {
  const d = tmp('engines');
  try {
    const burn = fingerprintInstaller(fakePe(d, 'setup.exe', '.wixburn', 'WixBundleManifest'));
    assert.strictEqual(burn.engine, 'burn');
    assert.ok(burn.automatable);

    const is = fingerprintInstaller(fakePe(d, 'setup2.exe', 'InstallShield Setup Launcher', 'ISSetupPrerequisites'));
    assert.strictEqual(is.engine, 'installshield');
    assert.ok(is.automatable);

    const msiPath = path.join(d, 'game.msi');
    fs.writeFileSync(msiPath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
    const msi = fingerprintInstaller(msiPath);
    assert.strictEqual(msi.engine, 'msi');
    assert.ok(msi.automatable && msi.support === 'auto' && msi.requiresAdmin);

    // Inno's SetupLdr magic beats any stray marker string
    const { INNO_SETUP_LDR_MAGIC } = require('../../client/lib/fingerprint.js');
    const inno = fingerprintInstaller(fakePe(d, 'setup3.exe', INNO_SETUP_LDR_MAGIC, 'InstallShield', 'Inno Setup Setup Data (6.2.0)'));
    assert.strictEqual(inno.engine, 'inno');
  } finally { rm(d); }
});

test('eligibility: every engine on Windows, Inno/NSIS only via Wine', () => {
  for (const engine of ['inno', 'nsis', 'msi', 'burn', 'installshield']) {
    const fp = { engine, automatable: true, confidence: 'high' };
    assert.ok(silent.canAutoSilentInstall({ fingerprint: fp, isWindows: true, isLinux: false, autoSilentPref: true }).ok, engine);
    const linux = silent.canAutoSilentInstall({ fingerprint: fp, isWindows: false, isLinux: true, wineAvailable: true, autoSilentPref: true });
    assert.strictEqual(linux.ok, ['inno', 'nsis'].includes(engine), `${engine} via wine`);
  }
});

test('library: Steam-style default folder and the folder that gets opened up', () => {
  const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' };
  assert.strictEqual(lib.defaultGamesDir({ platform: 'win32', env }), 'C:\\Program Files (x86)\\Gamehub\\games');
  assert.strictEqual(lib.defaultGamesDir({ platform: 'linux', home: '/home/u' }), '/home/u/Games');
  assert.strictEqual(lib.grantRootFor('C:\\Program Files (x86)\\Gamehub\\games', env), 'C:\\Program Files (x86)\\Gamehub');
  assert.strictEqual(lib.grantRootFor('c:\\program files\\Foo\\a\\b', env), 'C:\\Program Files\\Foo');
  assert.strictEqual(lib.grantRootFor('D:\\Games', env), 'D:\\Games');
  const ps = lib.grantScript('C:\\Program Files (x86)\\Gamehub');
  assert.match(ps, /icacls\.exe \$root \/grant '\*S-1-5-32-545:\(OI\)\(CI\)M'/);
});

test('ensureLibraryRoot: writable → no prompt; Program Files → one grant, then writable', async () => {
  const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  let grants = 0;
  let writable = false;
  const deps = { platform: 'win32', env, _isWritable: () => writable, _runGrant: async (root) => { grants++; assert.strictEqual(root, 'C:\\Program Files (x86)\\Gamehub'); writable = true; return { ok: true }; } };
  assert.deepStrictEqual(await lib.ensureLibraryRoot('C:\\Program Files (x86)\\Gamehub\\games', deps), { ok: true, granted: true, root: 'C:\\Program Files (x86)\\Gamehub' });
  assert.strictEqual((await lib.ensureLibraryRoot('C:\\Program Files (x86)\\Gamehub\\games', deps)).granted, false);
  assert.strictEqual(grants, 1, 'asked once');

  const declined = await lib.ensureLibraryRoot('C:\\Program Files (x86)\\Gamehub\\games', { ...deps, _isWritable: () => false, _runGrant: async () => ({ ok: false, error: 'uac-cancelled' }) });
  assert.strictEqual(declined.error, 'uac-cancelled');
  const real = tmp('libroot');
  try { assert.ok((await lib.ensureLibraryRoot(path.join(real, 'games'))).ok); } finally { rm(real); }
});

test('installers are found by what they are, not only by a setup/install name', () => {
  const installer = require('../../client/lib/installer.js');
  const d = tmp('engine-names');
  try {
    fs.writeFileSync(path.join(d, 'readme.txt'), 'x');
    fakePe(d, 'BundleGame-1.0.exe', '.wixburn', 'WixBundleManifest');
    assert.strictEqual(path.basename(installer.findInstaller(d) || ''), 'BundleGame-1.0.exe');
    const e = tmp('engine-names-game');
    fakePe(e, 'Game.exe', 'just a game');
    assert.strictEqual(installer.findInstaller(e), null, 'a plain game exe is not an installer');
    rm(e);
  } finally { rm(d); }
});

test('MSI Uninstall entries keep their product code (msiexec /X{GUID})', () => {
  const reg = require('../../client/lib/uninstallRegistry.js');
  const before = new Map();
  const after = new Map([['HKLM\\...\\Uninstall\\{98052700-EDE8-444B-8601-FA9D4CF7F36E}', {
    key: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{98052700-EDE8-444B-8601-FA9D4CF7F36E}',
    displayName: 'MsiGame', uninstallString: 'MsiExec.exe /I{98052700-EDE8-444B-8601-FA9D4CF7F36E}',
  }]]);
  assert.deepStrictEqual(reg.newEntries(before, after, 'MsiGame'), [], 'no folder → skipped by default');
  const [e] = reg.newEntries(before, after, 'MsiGame', { allowNoDir: true });
  assert.strictEqual(e.productCode, '{98052700-EDE8-444B-8601-FA9D4CF7F36E}');
  assert.strictEqual(e.installDir, null);
});
