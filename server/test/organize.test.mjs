// Library organization (opt-in, managed library only). Recreates the messy
// "Age of Mythology" folder set and asserts organize:
//   • renames the real game folder → "Title (Year)",
//   • files the update package under updates/<game>/,
//   • FLAGS (never deletes) the tiny junk copy,
//   • is idempotent, refuses to touch a folder that overlaps the read-only
//     store, and leaves rows the scanner won't then prune.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { checker, tmp, rm, writeFile } from './_helpers.mjs';
import { initDb } from '../src/db.js';
import { scanLibrary } from '../src/scanner.js';
import { listEvents } from '../src/events.js';
import { organizeLibrary, standardName, UPDATES_DIR } from '../src/organize.js';

const APPID = '11500'; // AoM: Retold — shared by the real copy and the junk copy

// Insert a matched games row; returns its id.
function addGame(db, row) {
  const ins = db.prepare(
    'INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status, is_update, provider, provider_id, meta_title, meta_year, meta_kind, meta_parent_title) ' +
      'VALUES (@rel_path,@raw_name,@clean_name,@payload_type,@size_bytes,@status,@is_update,@provider,@provider_id,@meta_title,@meta_year,@meta_kind,@meta_parent_title)'
  );
  return ins.run({
    raw_name: row.rel_path,
    clean_name: row.rel_path.toLowerCase(),
    payload_type: 'folder',
    size_bytes: row.size_bytes ?? 1,
    status: 'matched',
    is_update: 0,
    provider: 'steam',
    provider_id: APPID,
    meta_title: 'Age of Mythology: Retold',
    meta_year: 2024,
    meta_kind: 'game',
    meta_parent_title: null,
    ...row,
  }).lastInsertRowid;
}

const relOf = (db, id) => db.prepare('SELECT rel_path FROM games WHERE id = ?').get(id)?.rel_path;
const exists = (base, ...parts) => fs.existsSync(path.join(base, ...parts));

test('standardName: "Title (Year)", colon → " - ", keeps spaces + dashes', () => {
  const { check, done } = checker();
  check('colon becomes " - " and year appended', standardName('Age of Mythology: Retold', 2024) === 'Age of Mythology - Retold (2024)', standardName('Age of Mythology: Retold', 2024));
  check('spaces + dashes survive (not stripped)', standardName('Spider-Man Remastered', 2022) === 'Spider-Man Remastered (2022)', standardName('Spider-Man Remastered', 2022));
  check('illegal chars dropped', standardName('Portal 2?*"', 2011) === 'Portal 2 (2011)', standardName('Portal 2?*"', 2011));
  check('no year → bare title', standardName('Half-Life', null) === 'Half-Life', standardName('Half-Life', null));
  check('empty title → null', standardName('   ', 2020) === null, String(standardName('   ', 2020)));
  done(assert);
});

test('organize: rename real game, file update, flag junk, never delete, idempotent', () => {
  const { check, done } = checker();
  const dataDir = tmp('org-db');
  const libDir = tmp('org-lib');
  const db = initDb({ dataDir });
  const STD = 'Age of Mythology - Retold (2024)';
  try {
    // --- the messy library on disk ---
    writeFile(libDir, 'Age of Mythology Retold/AoM.exe', 5 * 1024 * 1024); // real: 5 MB exe → "real"
    writeFile(libDir, 'Age of Mythology Retold (junk copy)/readme.txt', 39 * 1024); // junk: 39 KB, no exe
    writeFile(libDir, 'Age.of.Mythology.1.06.21.RUNE.RePACK/patch.bin', 2048); // an update package

    const realId = addGame(db, { rel_path: 'Age of Mythology Retold', size_bytes: 5 * 1024 * 1024 });
    const junkId = addGame(db, { rel_path: 'Age of Mythology Retold (junk copy)', size_bytes: 39 * 1024 }); // same appid as real
    const updId = addGame(db, {
      rel_path: 'Age.of.Mythology.1.06.21.RUNE.RePACK',
      is_update: 1,
      meta_title: 'Age of Mythology Retold RUNE Update',
      meta_parent_title: 'Age of Mythology: Retold',
    });

    const out = organizeLibrary(db, libDir, { storeDir: null });

    // rename: the real (exe-bearing) folder wins the standard name, junk excluded
    check('one folder renamed', out.renamed === 1, JSON.stringify(out));
    check('real folder renamed on disk', exists(libDir, STD) && !exists(libDir, 'Age of Mythology Retold'), fs.readdirSync(libDir).join(' | '));
    check('real row points at the standard name', relOf(db, realId) === STD, relOf(db, realId));

    // update filed under updates/<game>/
    const updRel = path.posix.join(UPDATES_DIR, STD, 'Age.of.Mythology.1.06.21.RUNE.RePACK');
    check('one update filed', out.moved === 1, JSON.stringify(out));
    check('update moved under updates/<game>/ on disk', exists(libDir, UPDATES_DIR, STD, 'Age.of.Mythology.1.06.21.RUNE.RePACK', 'patch.bin'), fs.existsSync(path.join(libDir, UPDATES_DIR)) ? 'updates/ exists' : 'no updates/');
    check('old top-level update folder is gone', !exists(libDir, 'Age.of.Mythology.1.06.21.RUNE.RePACK'), 'still there');
    check('update row rel_path updated', relOf(db, updId) === updRel, relOf(db, updId));

    // junk: flagged, NOT renamed, and CRUCIALLY still on disk (never deleted)
    check('at least one junk/dupe flagged', out.flagged >= 1, String(out.flagged));
    const junkEvents = listEvents(db, { level: 'warn' }).filter((e) => e.game_id === junkId && /junk/i.test(e.message));
    check('junk folder produced a warn event linked to its row', junkEvents.length >= 1, JSON.stringify(listEvents(db, { level: 'warn' }).map((e) => e.message)));
    check('junk folder still exists on disk (never deleted)', exists(libDir, 'Age of Mythology Retold (junk copy)'), 'deleted!');
    check('junk row rel_path unchanged', relOf(db, junkId) === 'Age of Mythology Retold (junk copy)', relOf(db, junkId));

    // idempotent: running again is a no-op (already standard / already filed)
    const out2 = organizeLibrary(db, libDir, { storeDir: null });
    check('second run renames nothing', out2.renamed === 0, JSON.stringify(out2));
    check('second run moves nothing', out2.moved === 0, JSON.stringify(out2));

    // the scanner must not prune the renamed folder or the moved update
    const { removed } = scanLibrary(db, { libraryDir: libDir });
    check('scan prunes nothing after organize', removed === 0, String(removed));
    check('real row survives the scan', relOf(db, realId) === STD, relOf(db, realId));
    check('filed-update row survives the scan', relOf(db, updId) === updRel, relOf(db, updId));
    check('junk row survives the scan', relOf(db, junkId) === 'Age of Mythology Retold (junk copy)', relOf(db, junkId));
  } finally {
    db.close();
    rm(dataDir, libDir);
  }
  done(assert);
});

test('organize: refuses to run when the library overlaps the read-only store', () => {
  const { check, done } = checker();
  const dataDir = tmp('org-store-db');
  const libDir = tmp('org-store-lib');
  const db = initDb({ dataDir });
  try {
    writeFile(libDir, 'Age of Mythology Retold/AoM.exe', 5 * 1024 * 1024);
    const id = addGame(db, { rel_path: 'Age of Mythology Retold', size_bytes: 5 * 1024 * 1024 });

    // store === library: organizing here would rename seeding torrents — refuse.
    const out = organizeLibrary(db, libDir, { storeDir: libDir });
    check('nothing renamed/moved/flagged', out.renamed === 0 && out.moved === 0 && out.flagged === 0, JSON.stringify(out));
    check('folder left exactly as-is', exists(libDir, 'Age of Mythology Retold'), 'renamed anyway!');
    check('row untouched', relOf(db, id) === 'Age of Mythology Retold', relOf(db, id));
    const warned = listEvents(db, { level: 'warn' }).some((e) => /overlap/i.test(e.message));
    check('overlap was logged as a warning', warned, JSON.stringify(listEvents(db, { level: 'warn' }).map((e) => e.message)));

    // store as a PARENT of the library is likewise refused
    const parent = path.dirname(libDir);
    const out2 = organizeLibrary(db, libDir, { storeDir: parent });
    check('parent-store also refuses', out2.renamed === 0 && exists(libDir, 'Age of Mythology Retold'), JSON.stringify(out2));
  } finally {
    db.close();
    rm(dataDir, libDir);
  }
  done(assert);
});

test('organize: two full copies of the same game are flagged, not clobbered', () => {
  const { check, done } = checker();
  const dataDir = tmp('org-dupe-db');
  const libDir = tmp('org-dupe-lib');
  const db = initDb({ dataDir });
  const STD = 'Age of Mythology - Retold (2024)';
  try {
    // two substantial (exe-bearing) folders both resolving to the same name
    writeFile(libDir, 'AoM Retold RUNE/AoM.exe', 5 * 1024 * 1024);
    writeFile(libDir, 'AoM Retold TENOKE/AoM.exe', 5 * 1024 * 1024);
    const a = addGame(db, { rel_path: 'AoM Retold RUNE', size_bytes: 5 * 1024 * 1024 });
    const b = addGame(db, { rel_path: 'AoM Retold TENOKE', size_bytes: 5 * 1024 * 1024 });

    const out = organizeLibrary(db, libDir, { storeDir: null });
    check('neither copy is renamed (ambiguous)', out.renamed === 0, JSON.stringify(out));
    check('the duplicate is flagged', out.flagged >= 1, String(out.flagged));
    check('both folders remain on disk', exists(libDir, 'AoM Retold RUNE') && exists(libDir, 'AoM Retold TENOKE'), fs.readdirSync(libDir).join(' | '));
    check('no folder grabbed the standard name', !exists(libDir, STD), 'a copy was renamed');
    check('both rows unchanged', relOf(db, a) === 'AoM Retold RUNE' && relOf(db, b) === 'AoM Retold TENOKE', `${relOf(db, a)} / ${relOf(db, b)}`);
  } finally {
    db.close();
    rm(dataDir, libDir);
  }
  done(assert);
});
