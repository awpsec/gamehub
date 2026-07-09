// Backups protect everything the read-only library can't rebuild: snapshots are
// consistent + openable, rotation keeps N, and a dropped-in restore.db is
// swapped in on boot without destroying the current copy.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { checker, tmp, rm } from './_helpers.mjs';
import { initDb } from '../src/db.js';
import { startEmbeddedServer } from '../src/embed.js';
import { snapshot, runBackup, listBackups, applyPendingRestore } from '../src/backup.js';

test('backup: snapshot is consistent + openable, rotation keeps N', () => {
  const { check, done } = checker();
  const dataDir = tmp('bk-db');
  const db = initDb({ dataDir });
  try {
    db.prepare(
      "INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status, matched_manually, meta_title, meta_cover) " +
        "VALUES ('MyGame','MyGame','my game','folder',1,'matched',1,'My Curated Title','http://cover')"
    ).run();

    // snapshot → open independently → the curated row survives
    const snapPath = path.join(dataDir, 'snap.db');
    snapshot(db, snapPath);
    const s = new Database(snapPath, { readonly: true });
    const row = s.prepare("SELECT meta_title, matched_manually, meta_cover FROM games WHERE rel_path='MyGame'").get();
    s.close();
    check('snapshot preserves the manual match + cover override', row?.meta_title === 'My Curated Title' && row?.matched_manually === 1 && row?.meta_cover === 'http://cover', JSON.stringify(row));

    // snapshot overwrites cleanly on a second call (VACUUM INTO refuses an existing file)
    snapshot(db, snapPath);
    check('snapshot overwrites an existing target', fs.existsSync(snapPath), 'gone');

    // rotation: seed 5 old snapshots, run once with keep=3 → 3 newest remain
    const bdir = path.join(dataDir, 'backups');
    fs.mkdirSync(bdir, { recursive: true });
    for (const d of ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04', '2020-01-05']) {
      fs.writeFileSync(path.join(bdir, `gamehub-${d}T00-00-00-000Z.db`), 'x');
    }
    const fresh = runBackup(db, dataDir, 3);
    const list = listBackups(dataDir);
    check('rotation keeps exactly `keep` snapshots', list.length === 3, String(list.length));
    check('the just-written snapshot is retained', list.some((b) => path.join(bdir, b.name) === fresh), fresh);
    check('listBackups is newest-first', list[0].name >= list[1].name && list[1].name >= list[2].name, JSON.stringify(list.map((b) => b.name)));
    check('oldest snapshots were dropped', !list.some((b) => b.name.includes('2020-01-01') || b.name.includes('2020-01-02')), JSON.stringify(list.map((b) => b.name)));
  } finally {
    db.close();
    rm(dataDir);
  }
  done(assert);
});

test('backup: boot restore swaps in restore.db, keeps the previous copy', () => {
  const { check, done } = checker();
  const dataDir = tmp('bk-restore');
  try {
    // current live DB with one row
    let db = initDb({ dataDir });
    db.prepare("INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status) VALUES ('OLD','OLD','old','folder',1,'new')").run();
    db.close();

    // a restore.db (a real snapshot from a different DB) dropped in
    const otherDir = tmp('bk-other');
    let other = initDb({ dataDir: otherDir });
    other.prepare("INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status) VALUES ('RESTORED','RESTORED','restored','folder',1,'new')").run();
    snapshot(other, path.join(dataDir, 'restore.db'));
    other.close();
    rm(otherDir);

    const did = applyPendingRestore(dataDir);
    check('applyPendingRestore reports a swap', did === true, String(did));
    check('restore.db consumed', !fs.existsSync(path.join(dataDir, 'restore.db')), 'still there');
    check('previous DB kept aside', fs.readdirSync(dataDir).some((f) => f.startsWith('gamehub.pre-restore-')), fs.readdirSync(dataDir).join(','));

    // the live DB is now the restored content
    db = initDb({ dataDir });
    const has = (rp) => !!db.prepare('SELECT 1 FROM games WHERE rel_path = ?').get(rp);
    check('live DB now holds the RESTORED row', has('RESTORED'), 'missing');
    check('…and not the OLD row', !has('OLD'), 'old row leaked');
    db.close();

    // no restore.db → no-op
    check('no restore.db is a no-op', applyPendingRestore(dataDir) === false, 'unexpected swap');
  } finally {
    rm(dataDir);
  }
  done(assert);
});

test('backup: API status + download against a real embedded server', async () => {
  const { check, done } = checker();
  const dataDir = tmp('bk-api-db');
  const libDir = tmp('bk-api-lib');
  const srv = startEmbeddedServer({ dataDir, libraryDir: libDir, port: 0, host: '127.0.0.1', localMode: true });
  try {
    const port = await srv.ready; // ready runs the boot backup
    const status = await (await fetch(`http://127.0.0.1:${port}/api/backups`)).json();
    check('boot wrote a snapshot, listed by /api/backups', Array.isArray(status.backups) && status.backups.length >= 1, JSON.stringify(status));
    check('status reports interval + keep', status.intervalHours === 24 && status.keep === 7, JSON.stringify(status));

    const res = await fetch(`http://127.0.0.1:${port}/api/backup`);
    check('download responds 200', res.ok, String(res.status));
    const dlPath = path.join(dataDir, 'downloaded.db');
    fs.writeFileSync(dlPath, Buffer.from(await res.arrayBuffer()));
    const d = new Database(dlPath, { readonly: true });
    const hasGames = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='games'").get();
    d.close();
    check('downloaded file is a valid Gamehub DB', !!hasGames, 'no games table');
  } finally {
    await srv.close();
    rm(dataDir, libDir);
  }
  done(assert);
});
