// Screenshots library (client/lib/screenshots.js): layout, listing, safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmp, rm, checker } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const shots = require('../../client/lib/screenshots.js');

// tiny valid PNG (1x1) — content doesn't matter, only layout/IO
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test('saveShot stores under <root>/<gameId>/ and lists it back', () => {
  const root = tmp('shots');
  try {
    const f1 = shots.saveShot(root, 42, PNG);
    const f2 = shots.saveShot(root, 42, PNG);
    shots.saveShot(root, 7, PNG);
    const { check, done } = checker();
    check('saved into the game folder', f1.startsWith(path.join(root, '42') + path.sep), f1);
    check('png extension', /\.png$/.test(f1), f1);
    check('two saves never collide', f1 !== f2);
    const mine = shots.listShots(root, 42);
    check('per-game list returns both', mine.length === 2, String(mine.length));
    check('newest first', mine.every((e, i) => !i || mine[i - 1].at >= e.at));
    check('entry shape', mine.every((e) => e.gameId === 42 && e.url.startsWith('file://') && e.size === PNG.length));
    const all = shots.listShots(root);
    check('all-games walk finds every folder', all.length === 3, String(all.length));
    done(assert);
  } finally {
    rm(root);
  }
});

test('invalid game ids can never become path segments', () => {
  const root = tmp('shots-safe');
  try {
    const { check, done } = checker();
    for (const bad of ['..', '1/2', '', null, undefined, 'abc', '4.2']) {
      check(`safeGameId rejects ${JSON.stringify(bad)}`, shots.safeGameId(bad) === null);
      check(`gameDir rejects ${JSON.stringify(bad)}`, shots.gameDir(root, bad) === null);
    }
    assert.throws(() => shots.saveShot(root, '../escape', PNG));
    check('save threw instead of writing', fs.readdirSync(root).length === 0);
    done(assert);
  } finally {
    rm(root);
  }
});

test('deleteShot only touches pngs inside the root, and prunes empty folders', () => {
  const root = tmp('shots-del');
  try {
    const file = shots.saveShot(root, 9, PNG);
    const { check, done } = checker();
    check('refuses files outside the root', shots.deleteShot(root, path.join(root, '..', 'x.png')) === false);
    check('refuses traversal', shots.deleteShot(root, path.join(root, '9', '..', '..', 'etc', 'x.png')) === false);
    check('refuses non-png', shots.deleteShot(root, file.replace(/\.png$/, '.exe')) === false);
    check('deletes inside the root', shots.deleteShot(root, file) === true);
    check('file is gone', !fs.existsSync(file));
    check('empty game folder pruned', !fs.existsSync(path.dirname(file)));
    check('re-delete reports false', shots.deleteShot(root, file) === false);
    done(assert);
  } finally {
    rm(root);
  }
});

test('listShots on a missing root is empty, not an error', () => {
  const root = path.join(tmp('shots-missing'), 'nope');
  assert.deepEqual(shots.listShots(root), []);
  assert.deepEqual(shots.listShots(root, 3), []);
});
