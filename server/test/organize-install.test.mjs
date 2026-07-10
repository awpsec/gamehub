// Local Store+Library: organize installs without rewriting Store catalog paths.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { checker, tmp, rm, writeFile } from './_helpers.mjs';
import { initDb } from '../src/db.js';
import { organizeLibrary, standardName } from '../src/organize.js';

test('organize updateDb:false renames install folder but keeps Store rel_path', () => {
  const { check, done } = checker();
  const dataDir = tmp('org-udb-db');
  const store = tmp('org-udb-store');
  const lib = tmp('org-udb-lib');
  const db = initDb({ dataDir });
  const STD = standardName('Age of Mythology: Retold', 2024);
  try {
    // Store still has the torrent name (never touched)
    writeFile(store, 'Age.of.Mythology.Retold-RUNE/AoM.exe', 5 * 1024 * 1024);
    // Library has an installed copy under a messy title
    writeFile(lib, 'Age of Mythology Retold/AoM.exe', 5 * 1024 * 1024);

    const id = db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status, provider, provider_id, meta_title, meta_year, meta_kind)
       VALUES ('Age.of.Mythology.Retold-RUNE', 'Age.of.Mythology.Retold-RUNE', 'age of mythology retold', 'folder', 5000000, 'matched', 'steam', '11500', 'Age of Mythology: Retold', 2024, 'game')`
    ).run().lastInsertRowid;

    const out = organizeLibrary(db, lib, { storeDir: store, updateDb: false });
    check('renamed on disk', out.renamed === 1, JSON.stringify(out));
    check('install folder standardized', fs.existsSync(path.join(lib, STD)), fs.readdirSync(lib).join('|'));
    check('messy install name gone', !fs.existsSync(path.join(lib, 'Age of Mythology Retold')));
    const row = db.prepare('SELECT rel_path FROM games WHERE id = ?').get(id);
    check('catalog rel_path still Store name', row.rel_path === 'Age.of.Mythology.Retold-RUNE', row.rel_path);
    check('Store untouched', fs.existsSync(path.join(store, 'Age.of.Mythology.Retold-RUNE', 'AoM.exe')));
  } finally {
    db.close();
    rm(dataDir, store, lib);
  }
  done(assert);
});
