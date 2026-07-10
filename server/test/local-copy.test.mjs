// Local-mode Store → Library filesystem copy (no HTTP).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checker, tmp, rm, writeFile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { copyPackageToStaging, resolveStoreFile, isInside } = require('../../client/lib/localCopy.js');

test('localCopy: copies a multi-file store package into staging', async () => {
  const { check, done } = checker();
  const store = tmp('lc-store');
  const staging = tmp('lc-stage');
  try {
    writeFile(store, 'Cool.Game-RUNE/setup.exe', 4096);
    writeFile(store, 'Cool.Game-RUNE/data.bin', 8192);
    const pkg = { rel_path: 'Cool.Game-RUNE' };
    const files = [
      { path: 'setup.exe', size: 4096 },
      { path: 'data.bin', size: 8192 },
    ];
    let credited = 0;
    await copyPackageToStaging(store, pkg, files, staging, (n) => { credited += n; });
    check('setup copied', fs.existsSync(path.join(staging, 'setup.exe')));
    check('data copied', fs.existsSync(path.join(staging, 'data.bin')));
    check('bytes credited', credited === 4096 + 8192, String(credited));
    check('store untouched', fs.existsSync(path.join(store, 'Cool.Game-RUNE', 'setup.exe')));
  } finally {
    rm(store, staging);
  }
  done(assert);
});

test('localCopy: resumes a partial staging file', async () => {
  const { check, done } = checker();
  const store = tmp('lc-resume-store');
  const staging = tmp('lc-resume-stage');
  try {
    const SIZE = 10_000;
    writeFile(store, 'Pack/big.bin', SIZE);
    const dest = path.join(staging, 'big.bin');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(dest, fs.readFileSync(path.join(store, 'Pack', 'big.bin')).subarray(0, 3000));
    await copyPackageToStaging(store, { rel_path: 'Pack' }, [{ path: 'big.bin', size: SIZE }], staging, () => {});
    check('complete after resume', fs.statSync(dest).size === SIZE, String(fs.statSync(dest).size));
  } finally {
    rm(store, staging);
  }
  done(assert);
});

test('localCopy: refuses path traversal outside the Store', () => {
  const { check, done } = checker();
  const store = tmp('lc-trav');
  try {
    writeFile(store, 'Game/ok.bin', 100);
    let threw = false;
    try {
      resolveStoreFile(store, 'Game', '../../outside.bin');
    } catch {
      threw = true;
    }
    check('traversal throws', threw);
    check('isInside self', isInside(store, store));
  } finally {
    rm(store);
  }
  done(assert);
});
