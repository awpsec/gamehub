// Scene releases (RUNE, CODEX, TENOKE, …): ISO → setup.exe, with the group's
// crack in a folder next to the setup. After the setup has installed the game,
// that folder's files go over the installed ones — the step people do by hand
// ("copy the contents of the RUNE folder to the install directory").
//
// Kept separate from installer.js so the rules are easy to test in isolation.
const fs = require('node:fs');
const path = require('node:path');

// Folder names releases use for the crack. Exact names only (case-insensitive)
// — "Content", "Engine" etc. must never match.
const CRACK_DIR_NAMES = [
  'crack', 'cracked', 'crack only', 'crackfix', 'crack fix', 'fix', 'nodvd', 'no-dvd',
  'rune', 'codex', 'plaza', 'skidrow', 'skid row', 'tenoke', 'reloaded', 'razor1911', 'razor',
  'hoodlum', 'cpy', 'prophet', 'darksiders', 'empress', 'flt', 'fairlight', 'doge', 'simplex',
  'tinyiso', 'hi2u', 'ali213', '3dm', 'goldberg', 'steam emu', 'steamemu', 'steam_emu',
  'i_know', 'i know', 'p2p', 'rld', 'dinobytes', 'chronos', 'deviance', 'postmortem', 'catiso', 'rzr',
];
const CRACK_DIR_RE = new RegExp(
  `^(${CRACK_DIR_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ ._-]?')).join('|')})$`,
  'i'
);
// Things that are never part of the crack payload.
const SKIP_FILE_RE = /\.(nfo|sfv|diz|url|lnk|md5|sha1|jpg|jpeg|png|gif)$/i;
// The crack's own notes ("copy the contents of RUNE…") — never over the game's.
const DOC_RE = /(^|[\\/])(read[ _-]?me|install|instructions|info|changelog|notes?)[^\\/]*\.(txt|md|rtf|pdf|html?)$/i;
const BACKUP_SUFFIX = '.gamehub-orig';
// Only these may replace every same-named file across the install (step 2
// below) — a crack's readme.txt must not overwrite the game's readmes.
const REPLACE_ANYWHERE_RE = /(\.(exe|dll|so|ini|cfg)|^steam_appid\.txt)$/i;

function isCrackDirName(name) {
  return CRACK_DIR_RE.test(String(name || '').trim());
}

function listFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

/** A folder holds a crack if it has at least one exe/dll/ini/txt payload file. */
function looksLikeCrack(dir) {
  const files = listFiles(dir).filter((f) => !SKIP_FILE_RE.test(f));
  if (!files.length || files.length > 400) return false; // a whole game is not a crack
  return files.some((f) => /\.(exe|dll|ini|cfg|txt|json|so)$/i.test(f));
}

/**
 * Crack folders at the release root or one level down (ISO extracted into a
 * subfolder). Returns absolute paths, shallowest first.
 */
function findCrackDirs(root, { maxDepth = 1 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (isCrackDirName(e.name)) {
        if (looksLikeCrack(p)) out.push(p);
        continue; // never look for cracks inside a crack
      }
      if (depth < maxDepth) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** True when `rel` (relative to a release root) runs through a crack folder. */
function isInCrackDir(rel) {
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
  // Only the first two segments: a release's crack sits at the top, while a
  // game's own data could legitimately have e.g. Content/Fix/.
  return parts.slice(0, Math.min(2, parts.length - 1)).some(isCrackDirName);
}

/**
 * Copy a crack folder's files over an installed game.
 *   1. Same relative path exists in the install → replace it.
 *   2. Otherwise every installed file with the same name → replace those
 *      (steam_api64.dll sits next to the game exe, wherever that is).
 *   3. Otherwise (new files: steam_emu.ini, steam_settings/…) → put it beside
 *      the files replaced in steps 1–2, or the game exe, or the install root.
 * Originals are kept as <file>.gamehub-orig (only the first time).
 * Returns { replaced, added, skipped } (paths relative to targetDir).
 */
function applyCrack(crackDir, targetDir, { gameExe = null, _copy = fs.copyFileSync } = {}) {
  const result = { replaced: [], added: [], skipped: [] };
  if (!crackDir || !targetDir || !fs.existsSync(crackDir) || !fs.existsSync(targetDir)) return result;
  const crackRoot = path.resolve(crackDir);
  const target = path.resolve(targetDir);
  // never copy a folder into itself
  if (target === crackRoot || target.startsWith(crackRoot + path.sep)) return result;

  // (a portable release keeps its crack folder inside the game folder — never
  // treat the crack's own files as the installed ones)
  const installed = listFiles(target).filter((f) => !f.endsWith(BACKUP_SUFFIX)
    && !path.resolve(f).startsWith(crackRoot + path.sep));
  const byName = new Map();
  for (const f of installed) {
    const k = path.basename(f).toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(f);
  }
  const relLower = new Map(installed.map((f) => [path.relative(target, f).toLowerCase(), f]));

  const files = listFiles(crackRoot).filter((f) => !SKIP_FILE_RE.test(f) && !DOC_RE.test(f));
  const plan = [];
  const pending = [];
  const anchorDirs = new Map(); // crack-relative dir → install dir it maps to
  for (const f of files) {
    const rel = path.relative(crackRoot, f);
    const exact = relLower.get(rel.toLowerCase());
    if (exact) {
      plan.push([f, [exact]]);
      anchorDirs.set(path.dirname(rel).toLowerCase(), path.dirname(exact));
      continue;
    }
    const same = REPLACE_ANYWHERE_RE.test(path.basename(f)) ? byName.get(path.basename(f).toLowerCase()) : null;
    if (same && same.length) {
      plan.push([f, same]);
      if (!anchorDirs.has(path.dirname(rel).toLowerCase())) {
        // shallowest match anchors this crack sub-folder
        const best = [...same].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)[0];
        anchorDirs.set(path.dirname(rel).toLowerCase(), path.dirname(best));
      }
      continue;
    }
    pending.push([f, rel]);
  }
  const fallbackDir = gameExe && fs.existsSync(gameExe) && path.resolve(gameExe).startsWith(target + path.sep)
    ? path.dirname(gameExe)
    : (anchorDirs.get('.') || target);
  for (const [f, rel] of pending) {
    // walk up the crack-relative path until a known anchor: steam_settings/x.txt
    // lands next to the dll the crack replaced
    let dir = path.dirname(rel);
    let tail = path.basename(rel);
    let dest = null;
    while (true) {
      const anchor = anchorDirs.get(dir.toLowerCase());
      if (anchor) { dest = path.join(anchor, tail); break; }
      if (dir === '.' || dir === '') break;
      tail = path.join(path.basename(dir), tail);
      dir = path.dirname(dir);
    }
    plan.push([f, [dest || path.join(fallbackDir, rel)]]);
  }

  for (const [src, dests] of plan) {
    for (const dest of dests) {
      const d = path.resolve(dest);
      if (!d.startsWith(target + path.sep)) { result.skipped.push(dest); continue; }
      try {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        const existed = fs.existsSync(d);
        if (existed && !fs.existsSync(d + BACKUP_SUFFIX)) fs.renameSync(d, d + BACKUP_SUFFIX);
        _copy(src, d);
        (existed ? result.replaced : result.added).push(path.relative(target, d));
      } catch {
        result.skipped.push(path.relative(target, d));
      }
    }
  }
  return result;
}

/** Undo applyCrack: restore every <file>.gamehub-orig under targetDir. */
function restoreOriginals(targetDir) {
  let n = 0;
  for (const f of listFiles(targetDir)) {
    if (!f.endsWith(BACKUP_SUFFIX)) continue;
    try { fs.renameSync(f, f.slice(0, -BACKUP_SUFFIX.length)); n++; } catch { /* */ }
  }
  return n;
}

module.exports = {
  CRACK_DIR_RE,
  BACKUP_SUFFIX,
  isCrackDirName,
  isInCrackDir,
  findCrackDirs,
  looksLikeCrack,
  applyCrack,
  restoreOriginals,
};
