// Database snapshots. The library folder is safe (read-only, re-scannable), but
// everything DERIVED — manual matches, cover overrides, categories, playtime,
// users, DLC/update classifications — lives only in gamehub.db. These helpers
// take consistent single-file snapshots (SQLite VACUUM INTO works with WAL
// active) and rotate them, plus a boot-time restore swap.
import fs from 'node:fs';
import path from 'node:path';

// Write a clean, self-contained copy of the live DB to filePath (overwrites).
export function snapshot(db, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.rmSync(filePath, { force: true }); // VACUUM INTO refuses to overwrite
  // SQLite accepts forward slashes on every platform; single-quotes doubled.
  const sqlPath = filePath.replace(/\\/g, '/').replace(/'/g, "''");
  db.exec(`VACUUM INTO '${sqlPath}'`);
  return filePath;
}

// Take a rotated snapshot under <dataDir>/backups, keeping the newest `keep`.
export function runBackup(db, dataDir, keep = 7) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  // ISO timestamp, filename-safe — lexical order == chronological order. A `_N`
  // suffix (sorts AFTER `.db`) disambiguates the rare same-millisecond collision.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  let file = path.join(dir, `gamehub-${ts}.db`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `gamehub-${ts}_${n}.db`);
  snapshot(db, file);
  const snaps = fs.readdirSync(dir).filter((f) => /^gamehub-.*\.db$/.test(f)).sort();
  for (let i = 0; i < snaps.length - keep; i++) {
    try { fs.rmSync(path.join(dir, snaps[i]), { force: true }); } catch { /* next run retries */ }
  }
  return file;
}

// list snapshots newest-first (for status / UI)
export function listBackups(dataDir) {
  const dir = path.join(dataDir, 'backups');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((f) => /^gamehub-.*\.db$/.test(f))
    .map((f) => {
      const s = fs.statSync(path.join(dir, f));
      return { name: f, size: s.size, at: s.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

// Boot-time restore: if a `restore.db` file was dropped into dataDir, swap it in
// as the live database BEFORE it's opened. The current DB is renamed aside
// (never destroyed), and stale WAL/SHM sidecars are cleared so the restored
// file opens clean. Returns true if a restore happened.
export function applyPendingRestore(dataDir) {
  const live = path.join(dataDir, 'gamehub.db');
  const pending = path.join(dataDir, 'restore.db');
  if (!fs.existsSync(pending)) return false;
  try {
    if (fs.existsSync(live)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(live, path.join(dataDir, `gamehub.pre-restore-${ts}.db`));
    }
    for (const sfx of ['-wal', '-shm']) {
      try { fs.rmSync(live + sfx, { force: true }); } catch { /* best-effort */ }
    }
    fs.renameSync(pending, live);
    console.log('[gamehub] restored database from restore.db (previous copy kept as gamehub.pre-restore-*.db)');
    return true;
  } catch (err) {
    console.error(`[gamehub] restore from restore.db failed: ${err.message}`);
    return false;
  }
}
