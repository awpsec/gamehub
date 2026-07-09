// In-place path healing after organize renames a library folder.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checker, tmp, rm, writeFile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { resolveInPlacePaths } = require('../../client/lib/inplace.js');

test('resolveInPlacePaths: remaps dir+exe after organize rename', () => {
  const { check, done } = checker();
  const lib = tmp('inplace-lib');
  try {
    const oldRel = 'Age of Mythology Retold';
    const newRel = 'Age of Mythology - Retold (2024)';
    writeFile(lib, `${newRel}/AoM.exe`, 5 * 1024 * 1024);
    // stale entry still points at the pre-rename path
    const staleDir = path.join(lib, oldRel);
    const staleExe = path.join(staleDir, 'AoM.exe');
    const entry = {
      inPlace: true,
      title: 'Age of Mythology - Retold',
      dir: staleDir,
      exe: staleExe,
    };
    check('old path is gone', !fs.existsSync(staleDir));
    const resolved = resolveInPlacePaths(entry, lib, newRel);
    check('resolved', !!resolved, String(resolved));
    check('dir healed', resolved.dir === path.join(lib, newRel), resolved.dir);
    check('exe remapped via relative path', resolved.exe === path.join(lib, newRel, 'AoM.exe'), resolved.exe);
    check('exe exists', fs.existsSync(resolved.exe));
  } finally {
    rm(lib);
  }
  done(assert);
});

test('resolveInPlacePaths: falls back to rankGameExes when relative remap fails', () => {
  const { check, done } = checker();
  const lib = tmp('inplace-rank');
  try {
    const newRel = 'Portal 2 (2011)';
    writeFile(lib, `${newRel}/bin/portal2.exe`, 5 * 1024 * 1024);
    const entry = {
      inPlace: true,
      title: 'Portal 2',
      dir: path.join(lib, 'Portal.2-RELOADED'), // gone
      exe: path.join(lib, 'Portal.2-RELOADED', 'portal2.exe'), // different layout
    };
    const rankedPath = path.join(lib, newRel, 'bin', 'portal2.exe');
    const resolved = resolveInPlacePaths(entry, lib, newRel, () => [{ path: rankedPath, score: 50 }]);
    check('dir healed', resolved?.dir === path.join(lib, newRel), resolved?.dir);
    check('exe from ranker', resolved?.exe === rankedPath, resolved?.exe);
  } finally {
    rm(lib);
  }
  done(assert);
});

test('resolveInPlacePaths: returns null when new folder missing', () => {
  const { check, done } = checker();
  const lib = tmp('inplace-miss');
  try {
    const entry = { inPlace: true, dir: path.join(lib, 'Old'), exe: path.join(lib, 'Old', 'g.exe') };
    check('null when gone', resolveInPlacePaths(entry, lib, 'New Name (2020)') === null);
    check('null when not inPlace', resolveInPlacePaths({ ...entry, inPlace: false }, lib, 'x') === null);
  } finally {
    rm(lib);
  }
  done(assert);
});
