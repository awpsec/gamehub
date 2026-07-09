// In-place install path healing after library organization renames a folder.
// Pure helpers — no Electron deps — so they can be unit-tested.
const path = require('node:path');
const fs = require('node:fs');

// Given a stale in-place entry and the game's current rel_path under libraryDir,
// return { dir, exe } pointing at the renamed folder, or null if it can't heal.
function resolveInPlacePaths(entry, libraryDir, relPath, rankGameExes = null) {
  if (!entry?.inPlace || !libraryDir || !relPath) return null;
  const nextDir = path.join(libraryDir, relPath);
  let st;
  try { st = fs.statSync(nextDir); } catch { return null; }
  if (!st.isDirectory()) return null;

  // Prefer remapping the old exe via its relative path inside the old dir.
  if (entry.exe && entry.dir) {
    const rel = path.relative(entry.dir, entry.exe);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const candidate = path.join(nextDir, rel);
      if (fs.existsSync(candidate)) return { dir: nextDir, exe: candidate };
    }
  }

  // Fall back to re-ranking exes in the new folder (optional injector for tests).
  if (typeof rankGameExes === 'function') {
    const ranked = rankGameExes(nextDir, entry.title);
    if (ranked?.[0]?.path) return { dir: nextDir, exe: ranked[0].path };
  }
  return { dir: nextDir, exe: null };
}

module.exports = { resolveInPlacePaths };
