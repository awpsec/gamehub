// Library organization (arr-style). Turns a messy managed library into a clean,
// standard-named one: rename each identified game folder to "Title (Year)", move
// update packages into updates/<game>/, and FLAG (never delete) junk/duplicate
// folders for the user to clear.
//
// SAFETY — this is the only part of Gamehub that renames/moves files:
//   • Runs ONLY when settings.manageLibrary is on (default OFF).
//   • Operates ONLY on paths strictly inside libraryDir. A read-only store is
//     never touched; if libraryDir and storeDir overlap, it refuses to run.
//   • NEVER deletes — junk/dupes are flagged as events; the reversible actions
//     (rename, move) are the only ones it performs.
//   • Idempotent: a folder already at its standard name / already filed is left
//     alone, so it's safe to run every scan.
import fs from 'node:fs';
import path from 'node:path';
import { logEvent, clearGameEvents } from './events.js';

export const UPDATES_DIR = 'updates';

// Filesystem-safe standard folder name: "Title (Year)". A colon becomes " - "
// (Age of Mythology: Retold → Age of Mythology - Retold); other illegal
// characters are dropped; no trailing dot/space (Windows).
export function standardName(title, year) {
  const n = String(title || '')
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
  if (!n) return null;
  const y = Number.parseInt(year, 10);
  return y >= 1970 && y <= 2100 ? `${n} (${y})` : n;
}

const resolveNorm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
// is `child` the same as, or inside, `parent`?
function isInside(child, parent) {
  const c = resolveNorm(child);
  const p = resolveNorm(parent);
  return c === p || c.startsWith(p + path.sep);
}

// Bounded read-only walk: total size + whether a plausible game exe is present.
const EXE_SKIP = /(unins|setup|install|redist|vcredist|dxsetup|directx|dotnet|crash|unitycrashhandler|7za|7zr|benchmark)/i;
function folderStats(dir) {
  let size = 0;
  let hasExe = false;
  let files = 0;
  const stack = [[dir, 0]];
  while (stack.length && files < 5000) {
    const [d, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4) stack.push([p, depth + 1]); continue; }
      files++;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      size += st.size;
      if (!hasExe && /\.exe$/i.test(e.name) && !EXE_SKIP.test(e.name) && st.size >= 4 * 1024 * 1024) hasExe = true;
    }
  }
  return { size, hasExe, files };
}

const JUNK_MAX_BYTES = 10 * 1024 * 1024; // a real game folder is never this small

// Move src → dest, preferring an atomic rename, falling back to copy+remove for
// a cross-device move. Never overwrites an existing dest.
function moveDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// Organize a managed library. Returns { renamed, moved, flagged } counts.
// updateDb: when false (local Store+Library — organizing the install folder),
// rename/move on disk only and leave games.rel_path alone so the Store catalog
// keeps pointing at torrent paths.
export function organizeLibrary(db, libraryDir, { storeDir = null, updateDb = true } = {}) {
  const out = { renamed: 0, moved: 0, flagged: 0 };
  if (!libraryDir || !fs.existsSync(libraryDir)) return out;
  const libAbs = resolveNorm(libraryDir);
  // Never organize a folder that IS or CONTAINS (or is contained by) the
  // read-only store — that's where seeding torrents live.
  if (storeDir && (isInside(libAbs, storeDir) || isInside(storeDir, libAbs))) {
    logEvent(db, 'warn', 'organize', 'Library organization skipped — library and store folders overlap', `library: ${libAbs}\nstore: ${storeDir}`);
    return out;
  }
  // every path we touch must be strictly inside libraryDir
  const safe = (p) => isInside(p, libAbs) && resolveNorm(p) !== libAbs;

  const setPath = db.prepare("UPDATE games SET rel_path = @rel, updated_at = datetime('now') WHERE id = @id");
  const flag = (r, message, detail) => {
    logEvent(db, 'warn', 'organize', message, detail, { gameId: r.id, action: { route: '#/activity', gameId: r.id, label: 'Review' } });
    out.flagged++;
  };
  const rows = db
    .prepare(
      "SELECT id, rel_path, raw_name, provider_id, meta_title, meta_year, meta_parent_title, is_update, meta_kind " +
        "FROM games WHERE status = 'matched' AND rel_path NOT LIKE '%::%'"
    )
    .all();

  // top-level, matched, non-update game folders; stat each once.
  // When updateDb is false we're organizing an install folder (local Library),
  // not the Store catalog — folders are named by title, not torrent rel_path.
  const games = rows.filter((r) => !r.is_update && r.meta_kind !== 'dlc' && !/[\\/]/.test(r.rel_path));
  const info = new Map();
  for (const r of games) {
    let from = path.join(libAbs, r.rel_path);
    if (!updateDb) {
      const std = standardName(r.meta_title, r.meta_year);
      const title = String(r.meta_title || '').replace(/[<>:"/\\|?*]/g, '').trim();
      const candidates = [std, title, r.rel_path].filter(Boolean);
      from = null;
      for (const name of candidates) {
        const p = path.join(libAbs, name);
        try {
          if (safe(p) && fs.statSync(p).isDirectory()) { from = p; break; }
        } catch { /* */ }
      }
    }
    let stats = null;
    try {
      if (from && safe(from) && fs.statSync(from).isDirectory()) stats = folderStats(from);
    } catch { /* gone / not a dir */ }
    info.set(r.id, { from, stats });
  }
  const isReal = (r) => { const s = info.get(r.id)?.stats; return !!s && (s.hasExe || s.size >= JUNK_MAX_BYTES); };

  // --- 1. FLAG junk/dupe: a tiny, exe-less folder beside a full copy of the same
  //        game. Never deleted — surfaced only — and excluded from renaming. ---
  const junk = new Set();
  const byApp = new Map();
  for (const r of games) {
    if (!r.provider_id) continue;
    if (!byApp.has(String(r.provider_id))) byApp.set(String(r.provider_id), []);
    byApp.get(String(r.provider_id)).push(r);
  }
  for (const group of byApp.values()) {
    if (group.length < 2 || !group.some(isReal)) continue; // lone copy / no full copy → never flag
    for (const r of group) {
      const s = info.get(r.id).stats;
      if (!s || isReal(r)) continue;
      junk.add(r.id);
      flag(r, `“${r.rel_path}” looks like junk (${Math.round(s.size / 1024)} KB, no game) beside a full copy`, 'A metadata-only / incomplete duplicate. Remove it to tidy the library — Gamehub won’t delete it for you.');
    }
  }

  // --- 2. RENAME game folders → "Title (Year)". Only when exactly ONE real
  //        folder maps to that name (versions/dupes are flagged, not clobbered). ---
  const byStd = new Map();
  for (const r of games) {
    if (junk.has(r.id) || !info.get(r.id).stats) continue;
    const std = standardName(r.meta_title, r.meta_year);
    if (!std) continue;
    if (!byStd.has(std)) byStd.set(std, []);
    byStd.get(std).push(r);
  }
  for (const [std, grp] of byStd) {
    if (grp.length > 1) {
      for (const r of grp) if (r.rel_path !== std) flag(r, `Multiple copies resolve to “${std}”`, 'More than one folder maps to the same game — keep one and remove the rest.');
      continue;
    }
    const r = grp[0];
    const from = info.get(r.id)?.from;
    if (!from) continue;
    if (path.basename(from) === std) continue; // already standard
    const to = path.join(libAbs, std);
    if (!safe(to) || fs.existsSync(to)) {
      flag(r, `“${path.basename(from)}” looks like a duplicate of “${std}”`, 'A folder with the standard name already exists. Review and remove the extra copy.');
      continue;
    }
    try {
      fs.renameSync(from, to);
      if (updateDb) {
        setPath.run({ id: r.id, rel: std });
        clearGameEvents(db, r.id);
      }
      out.renamed++;
      logEvent(db, 'info', 'organize', `Renamed folder → “${std}”`);
    } catch (err) {
      logEvent(db, 'error', 'organize', `Could not rename “${path.basename(from)}” → “${std}”`, err.message);
    }
  }

  // --- 3. FILE updates → updates/<game>/<pkg> ---------------------------------
  // Skip when organizing an install folder (updateDb=false): update packages live
  // in the Store catalog, not under gamesDir.
  if (updateDb) for (const r of rows) {
    if (!r.is_update) continue;
    if (r.rel_path.split(/[\\/]/)[0] === UPDATES_DIR) continue; // already filed
    const gameName = standardName(r.meta_parent_title || r.meta_title, r.meta_year);
    if (!gameName) continue;
    const from = path.join(libAbs, r.rel_path);
    const relDest = path.posix.join(UPDATES_DIR, gameName, path.basename(r.rel_path));
    const to = path.join(libAbs, ...relDest.split('/'));
    if (!safe(from) || !safe(to) || !fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      moveDir(from, to);
      if (updateDb) setPath.run({ id: r.id, rel: relDest });
      out.moved++;
      logEvent(db, 'info', 'organize', `Filed update “${r.raw_name}” under ${UPDATES_DIR}/${gameName}`);
    } catch (err) {
      logEvent(db, 'error', 'organize', `Could not file update “${r.raw_name}”`, err.message);
    }
  }

  if (out.renamed || out.moved) console.log(`[organize] renamed ${out.renamed}, filed ${out.moved} update(s), flagged ${out.flagged}`);
  return out;
}
