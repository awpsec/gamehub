// Fingerprint + silent-install driver unit tests (no real Inno binary required).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checker, tmp, rm, writeFile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const {
  fingerprintInstaller, isPe, isMsi,
} = require('../../client/lib/fingerprint.js');
const {
  buildInnoArgs,
  canAutoSilentInstall,
  assertPathInside,
  separatePayloadAndTarget,
  verifySilentResult,
} = require('../../client/lib/silentInstall.js');
const { isInside } = require('../../client/lib/localCopy.js');

function utf16le(str) {
  const b = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) b.writeUInt16LE(str.charCodeAt(i), i * 2);
  return b;
}

/** Minimal MZ+PE stub with optional ASCII / UTF-16 marker payloads appended. */
function writeFakePe(filePath, { ascii = [], utf16 = [] } = {}) {
  const peOff = 0x80;
  const buf = Buffer.alloc(peOff + 64 + 4096, 0);
  buf[0] = 0x4d; buf[1] = 0x5a; // MZ
  buf.writeUInt32LE(peOff, 0x3c);
  buf[peOff] = 0x50; buf[peOff + 1] = 0x45; // PE
  let cursor = peOff + 64;
  for (const s of ascii) {
    const chunk = Buffer.from(s, 'utf8');
    chunk.copy(buf, cursor);
    cursor += chunk.length + 8;
  }
  for (const s of utf16) {
    const chunk = utf16le(s);
    chunk.copy(buf, cursor);
    cursor += chunk.length + 8;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
}

test('fingerprint: high-confidence Inno needs PE + two signal classes', () => {
  const { check, done } = checker();
  const dir = tmp('fp-inno');
  try {
    const pe = path.join(dir, 'setup.exe');
    writeFakePe(pe, { ascii: ['Inno Setup', 'JR.Software'], utf16: ['Inno Setup'] });
    const fp = fingerprintInstaller(pe);
    check('engine inno', fp.engine === 'inno', fp.engine);
    check('high confidence', fp.confidence === 'high', fp.confidence);
    check('automatable', fp.automatable === true);
    check('support auto', fp.support === 'auto');
    check('has ascii evidence', fp.evidence.some((e) => e.startsWith('ascii:')));
    check('has utf16 evidence', fp.evidence.some((e) => e.startsWith('utf16:')));
    check('pe marked', fp.evidence.includes('pe:mz'));
  } finally {
    rm(dir);
  }
  done(assert);
});

test('fingerprint: setup.exe name alone is not enough', () => {
  const { check, done } = checker();
  const dir = tmp('fp-fake');
  try {
    const pe = path.join(dir, 'setup.exe');
    writeFakePe(pe, { ascii: ['Totally Normal App'] });
    const fp = fingerprintInstaller(pe);
    check('not inno', fp.engine === 'unknown', fp.engine);
    check('not automatable', fp.automatable === false);
  } finally {
    rm(dir);
  }
  done(assert);
});

test('fingerprint: NSIS detected but not automatable in v1', () => {
  const { check, done } = checker();
  const dir = tmp('fp-nsis');
  try {
    const pe = path.join(dir, 'install.exe');
    writeFakePe(pe, {
      ascii: ['NullsoftInst', 'Nullsoft Install System'],
      utf16: ['Nullsoft Install System'],
    });
    const fp = fingerprintInstaller(pe);
    check('engine nsis', fp.engine === 'nsis', fp.engine);
    check('high', fp.confidence === 'high', fp.confidence);
    check('not auto', fp.automatable === false);
    check('detect-only', fp.support === 'detect-only');
  } finally {
    rm(dir);
  }
  done(assert);
});

test('fingerprint: batch and MSI classification', () => {
  const { check, done } = checker();
  const dir = tmp('fp-misc');
  try {
    const bat = path.join(dir, 'setup.bat');
    fs.writeFileSync(bat, '@echo off\r\necho hi\r\n');
    const batFp = fingerprintInstaller(bat);
    check('batch engine', batFp.engine === 'batch');
    check('batch manual', batFp.support === 'manual');
    check('batch not auto', batFp.automatable === false);

    const msi = path.join(dir, 'setup.msi');
    const ole = Buffer.alloc(64, 0);
    ole[0] = 0xd0; ole[1] = 0xcf; ole[2] = 0x11; ole[3] = 0xe0;
    ole[4] = 0xa1; ole[5] = 0xb1; ole[6] = 0x1a; ole[7] = 0xe1;
    fs.writeFileSync(msi, ole);
    const msiFp = fingerprintInstaller(msi);
    check('msi engine', msiFp.engine === 'msi');
    check('msi detect-only', msiFp.support === 'detect-only');
    check('isMsi helper', isMsi(ole, msi));
  } finally {
    rm(dir);
  }
  done(assert);
});

test('fingerprint: medium confidence Inno is not automatable', () => {
  const { check, done } = checker();
  const dir = tmp('fp-med');
  try {
    const pe = path.join(dir, 'setup.exe');
    // Only one ASCII hit — medium, not high
    writeFakePe(pe, { ascii: ['Inno Setup'] });
    const fp = fingerprintInstaller(pe);
    check('inno', fp.engine === 'inno');
    check('medium', fp.confidence === 'medium', fp.confidence);
    check('not auto', fp.automatable === false);
  } finally {
    rm(dir);
  }
  done(assert);
});

test('buildInnoArgs: DIR and LOG are separate argv elements', () => {
  const { check, done } = checker();
  const target = 'C:\\Games\\Age of Mythology - Retold (2024)';
  const log = 'C:\\Games\\_staging\\inno.log';
  const args = buildInnoArgs(target, log);
  check('has VERYSILENT', args.includes('/VERYSILENT'));
  check('has SUPPRESSMSGBOXES', args.includes('/SUPPRESSMSGBOXES'));
  check('has SP-', args.includes('/SP-'));
  check('has NORESTART', args.includes('/NORESTART'));
  check('has NOICONS', args.includes('/NOICONS'));
  check('no NOCANCEL', !args.some((a) => /NOCANCEL/i.test(a)));
  check('DIR is one element', args.includes(`/DIR=${target}`));
  check('LOG is one element', args.includes(`/LOG=${log}`));
  // Spaces / special chars stay inside the single element (no shell split)
  check('spaces preserved in DIR', args.find((a) => a.startsWith('/DIR=')).includes(' '));
  const parenTarget = 'C:\\Games\\Game (1) & Co';
  const a2 = buildInnoArgs(parenTarget, null);
  check('ampersand/parens in DIR element', a2.includes(`/DIR=${parenTarget}`));
  check('no LOG when omitted', !a2.some((a) => a.startsWith('/LOG=')));
  done(assert);
});

test('canAutoSilentInstall: eligibility gates', () => {
  const { check, done } = checker();
  const fp = {
    engine: 'inno', confidence: 'high', automatable: true, support: 'auto', evidence: [],
  };
  const lib = '/library';
  const target = '/library/Game';

  const ok = canAutoSilentInstall({
    fingerprint: fp,
    existingInstall: false,
    autoSilentPref: true,
    targetDir: target,
    libraryRoots: [lib],
    isWindows: true,
  });
  check('eligible', ok.ok === true && ok.reason === 'eligible');

  const ask = canAutoSilentInstall({
    fingerprint: fp, autoSilentPref: null, targetDir: target, libraryRoots: [lib], isWindows: true,
  });
  check('needs ask', ask.ok === true && ask.needsAsk === true);

  const nsis = canAutoSilentInstall({
    fingerprint: { ...fp, automatable: false, engine: 'nsis' },
    autoSilentPref: true, isWindows: true,
  });
  check('nsis blocked', nsis.ok === false && nsis.reason === 'engine-not-automatable');

  const pref = canAutoSilentInstall({
    fingerprint: fp, autoSilentPref: false, isWindows: true,
  });
  check('wizard pref', pref.ok === false && pref.reason === 'user-prefers-wizard');

  const vs = canAutoSilentInstall({
    fingerprint: fp, existingInstall: true, autoSilentPref: true, isWindows: true,
  });
  check('version switch', vs.ok === false && vs.reason === 'version-switch-excluded');

  const dlc = canAutoSilentInstall({
    fingerprint: fp, isDlcOrUpdate: true, autoSilentPref: true, isWindows: true,
  });
  check('dlc/update', dlc.ok === false && dlc.reason === 'dlc-or-update-excluded');

  const linux = canAutoSilentInstall({
    fingerprint: fp, autoSilentPref: true, isWindows: false,
  });
  check('linux', linux.ok === false && linux.reason === 'windows-only');

  const outside = canAutoSilentInstall({
    fingerprint: fp, autoSilentPref: true, targetDir: '/other/Game', libraryRoots: [lib], isWindows: true,
  });
  check('outside library', outside.ok === false && outside.reason === 'target-outside-library');

  done(assert);
});

test('separatePayloadAndTarget: payload keeps setup, target starts empty', () => {
  const { check, done } = checker();
  const lib = tmp('sep-lib');
  try {
    const installDir = path.join(lib, 'Cool Game');
    const payloadDir = path.join(lib, '_staging', '1-setup-Cool Game');
    fs.mkdirSync(installDir, { recursive: true });
    writeFile(installDir, 'setup.exe', 4096);
    writeFile(installDir, 'data.bin', 8192);
    separatePayloadAndTarget(installDir, payloadDir);
    check('payload has setup', fs.existsSync(path.join(payloadDir, 'setup.exe')));
    check('payload has data', fs.existsSync(path.join(payloadDir, 'data.bin')));
    check('target exists', fs.existsSync(installDir));
    check('target empty', fs.readdirSync(installDir).length === 0);
  } finally {
    rm(lib);
  }
  done(assert);
});

test('assertPathInside: rejects sibling-prefix and escape attempts', () => {
  const { check, done } = checker();
  const lib = tmp('path-lib');
  try {
    const root = path.join(lib, 'Games');
    fs.mkdirSync(root, { recursive: true });
    const ok = path.join(root, 'Title');
    fs.mkdirSync(ok);
    assertPathInside(ok, root);
    check('inside ok', true);

    let threw = false;
    try {
      assertPathInside(path.join(lib, 'GamesEvil', 'x'), root);
    } catch {
      threw = true;
    }
    // GamesEvil is NOT inside Games — sibling-prefix style
    check('sibling prefix rejected', threw);

    threw = false;
    try {
      assertPathInside(path.join(root, '..', 'outside'), root);
    } catch {
      threw = true;
    }
    check('parent escape rejected', threw);
    check('isInside self', isInside(root, root));
  } finally {
    rm(lib);
  }
  done(assert);
});

test('verifySilentResult: needs launcher or substantial tree', () => {
  const { check, done } = checker();
  const lib = tmp('ver-lib');
  try {
    const empty = path.join(lib, 'Empty');
    fs.mkdirSync(empty);
    const miss = verifySilentResult(empty, 'Empty', { minBytes: 1024 });
    check('empty fails', miss.ok === false);

    const gameDir = path.join(lib, 'Cool Game');
    fs.mkdirSync(gameDir);
    // Title-matched exe at root → high rank score
    writeFile(gameDir, 'Cool Game.exe', 200 * 1024);
    const ok = verifySilentResult(gameDir, 'Cool Game', { minBytes: 50 * 1024 * 1024 });
    check('title exe verifies', ok.ok === true, ok.reason);
    check('has launcher', ok.hasLauncher === true);

    const husk = path.join(lib, 'Husk');
    fs.mkdirSync(husk);
    writeFile(husk, 'readme.txt', 100);
    const no = verifySilentResult(husk, 'Husk', { minBytes: 10 * 1024 * 1024 });
    check('husk fails', no.ok === false);
  } finally {
    rm(lib);
  }
  done(assert);
});

test('isPe helper rejects non-PE buffers', () => {
  const { check, done } = checker();
  check('empty', isPe(Buffer.alloc(0)) === false);
  check('text', isPe(Buffer.from('hello')) === false);
  const pe = Buffer.alloc(0x100, 0);
  pe[0] = 0x4d; pe[1] = 0x5a;
  pe.writeUInt32LE(0x80, 0x3c);
  pe[0x80] = 0x50; pe[0x81] = 0x45;
  check('valid pe', isPe(pe) === true);
  done(assert);
});
