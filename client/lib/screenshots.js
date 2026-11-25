// Local screenshot storage — pure fs helpers (no Electron imports) so the
// layout stays unit-testable. Shots live under
//   <userData>/Screenshots/<gameId>/<stamp>.png
// one folder per game (Steam-style), which also gives us the "all my
// screenshots" view by walking every game folder.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Game ids are numeric row ids; anything else must never become a path segment.
function safeGameId(gameId) {
  const s = String(gameId ?? '').trim();
  return /^\d+$/.test(s) ? s : null;
}

function gameDir(root, gameId) {
  const id = safeGameId(gameId);
  return id ? path.join(root, id) : null;
}

// child is inside parent (or equal)? Windows-safe case-insensitive compare.
function isInside(parent, child) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const a = norm(parent);
  const b = norm(child);
  return b === a || b.startsWith(a + path.sep);
}

// Local-time stamp names sort naturally and read like Steam's captures.
function stampName(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}_${p(d.getMilliseconds(), 3)}.png`;
}

// Persist one PNG buffer for a game; returns the absolute path.
function saveShot(root, gameId, pngBuffer) {
  const dir = gameDir(root, gameId);
  if (!dir) throw new Error('invalid game id');
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, stampName());
  // same-millisecond collision guard (mashable hotkeys)
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, stampName().replace(/\.png$/, `-${i}.png`));
  fs.writeFileSync(file, pngBuffer);
  return file;
}

function toEntry(dir, gameId, name) {
  const file = path.join(dir, name);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  return { gameId: Number(gameId), file, name, at: st.mtimeMs, size: st.size, url: pathToFileURL(file).href };
}

// Newest first. gameId=null → every game's folder (the "my screenshots" view).
function listShots(root, gameId = null) {
  const out = [];
  try {
    if (gameId != null) {
      const dir = gameDir(root, gameId);
      if (!dir) return [];
      for (const name of fs.readdirSync(dir)) {
        if (!/\.png$/i.test(name)) continue;
        const e = toEntry(dir, gameId, name);
        if (e) out.push(e);
      }
    } else {
      for (const sub of fs.readdirSync(root, { withFileTypes: true })) {
        if (!sub.isDirectory() || !safeGameId(sub.name)) continue;
        const dir = path.join(root, sub.name);
        for (const name of fs.readdirSync(dir)) {
          if (!/\.png$/i.test(name)) continue;
          const e = toEntry(dir, sub.name, name);
          if (e) out.push(e);
        }
      }
    }
  } catch { /* root doesn't exist yet — zero shots is a fine answer */ }
  out.sort((a, b) => b.at - a.at);
  return out;
}

// Delete only ever touches files inside the screenshots root — the renderer
// sends an absolute path back, so containment is verified here, not trusted.
function deleteShot(root, file) {
  if (typeof file !== 'string' || !/\.png$/i.test(file)) return false;
  if (!isInside(root, file)) return false;
  if (!fs.existsSync(file)) return false; // already gone — report honestly
  try { fs.rmSync(file); } catch { return false; }
  // drop the game folder once it's empty so the all-shots walk stays tidy
  const dir = path.dirname(file);
  try { if (dir !== path.resolve(root) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* */ }
  return true;
}

module.exports = { safeGameId, gameDir, isInside, saveShot, listShots, deleteShot };
