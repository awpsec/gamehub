// Scans the top level of the library dir. NEVER writes, renames, or moves
// anything — the library is treated as read-only so torrents keep seeding.
import fs from 'node:fs';
import path from 'node:path';
import { cleanName } from './namecleaner.js';
import { logEvent } from './events.js';

const SKIP_NAMES = new Set(['_staging', 'lost+found', '#recycle', '@eaDir', '.recycle']);

function walkStats(dir) {
  // returns { size, hasIncomplete, extCounts, fileNames(top few levels) }
  let size = 0;
  let hasIncomplete = false;
  const extCounts = new Map();
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        if (lower.endsWith('.!qb') || lower.endsWith('.parts')) hasIncomplete = true;
        const ext = path.extname(lower);
        extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
        try {
          size += fs.statSync(p).size;
        } catch { /* file vanished mid-scan */ }
      }
    }
  }
  return { size, hasIncomplete, extCounts };
}

function detectPayloadType(entryPath, isDir) {
  if (!isDir) {
    const ext = path.extname(entryPath).toLowerCase();
    if (ext === '.iso') return { type: 'iso', ...statFile(entryPath) };
    if (ext === '.nsp' || ext === '.xci') return { type: 'switch-rom', ...statFile(entryPath) };
    if (ext === '.zip' || ext === '.7z' || ext === '.rar') return { type: 'archive', ...statFile(entryPath) };
    if (ext === '.exe' || ext === '.msi') return { type: 'installer', ...statFile(entryPath) };
    return null; // loose file we don't recognize as a game
  }
  const { size, hasIncomplete, extCounts } = walkStats(entryPath);
  const has = (ext) => (extCounts.get(ext) || 0) > 0;
  let type = 'folder';
  if (has('.rar') || has('.r00')) type = 'multipart-archive';
  else if (has('.001')) type = 'multipart-archive';
  else if (has('.iso')) type = 'iso';
  else if (has('.nsp') || has('.xci')) type = 'switch-rom';
  else if (has('.zip') || has('.7z')) type = 'archive';
  else if (has('.msi') || has('.exe')) type = 'folder'; // playable/installable folder
  return { type, size, hasIncomplete };
}

function statFile(p) {
  try {
    return { size: fs.statSync(p).size, hasIncomplete: false };
  } catch {
    return { size: 0, hasIncomplete: false };
  }
}

export function scanLibrary(db, config) {
  const root = config.libraryDir;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    logEvent(db, 'error', 'scanner', `Cannot read library folder ${root}`, err.message, {
      action: { route: '#/settings/library', label: 'Fix path' },
    });
    return { added: 0, removed: 0 };
  }

  const seen = new Set();
  let added = 0;

  const insert = db.prepare(`
    INSERT INTO games (rel_path, raw_name, clean_name, hint_year, payload_type, size_bytes, status)
    VALUES (@rel_path, @raw_name, @clean_name, @hint_year, @payload_type, @size_bytes, @status)
  `);
  const getByPath = db.prepare('SELECT * FROM games WHERE rel_path = ?');
  const updateSize = db.prepare(
    "UPDATE games SET size_bytes = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
  );
  const updateCompleted = db.prepare(
    "UPDATE games SET size_bytes = ?, status = ?, payload_type = ?, updated_at = datetime('now') WHERE id = ?"
  );

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    const isDir = entry.isDirectory();
    if (!isDir && !entry.isFile()) continue;

    // skip qBittorrent in-progress single files
    if (!isDir && entry.name.toLowerCase().endsWith('.!qb')) continue;

    // a Gamehub client installs games here — this is NOT a library entry
    if (isDir && fs.existsSync(path.join(full, '.gamehub-client'))) continue;

    const payload = detectPayloadType(full, isDir);
    if (!payload) continue;

    seen.add(entry.name);
    const existing = getByPath.get(entry.name);

    if (!existing) {
      const { clean, hintYear } = cleanName(entry.name);
      insert.run({
        rel_path: entry.name,
        raw_name: entry.name,
        clean_name: clean,
        hint_year: hintYear,
        payload_type: payload.type,
        size_bytes: payload.size,
        status: payload.hasIncomplete ? 'downloading' : 'new',
      });
      added++;
      console.log(
        `[scan] found "${entry.name}" -> "${clean}"${hintYear ? ` (${hintYear})` : ''} [${payload.type}]${payload.hasIncomplete ? ' (still downloading)' : ''}`
      );
    } else if (existing.status === 'downloading') {
      // re-check whether the torrent finished; re-detect payload type once complete
      updateCompleted.run(
        payload.size,
        payload.hasIncomplete ? 'downloading' : 'new',
        payload.type,
        existing.id
      );
    } else if (existing.size_bytes !== payload.size) {
      updateSize.run(payload.size, existing.status, existing.id);
    }
  }

  // remove rows whose files disappeared from disk
  const all = db.prepare('SELECT id, rel_path FROM games').all();
  const del = db.prepare('DELETE FROM games WHERE id = ?');
  let removed = 0;
  for (const row of all) {
    if (!seen.has(row.rel_path)) {
      del.run(row.id);
      removed++;
      console.log(`[scan] removed "${row.rel_path}" (no longer on disk)`);
    }
  }

  return { added, removed };
}
