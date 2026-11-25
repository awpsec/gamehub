// Console platform detection from file headers (magic bytes), shared by the
// server scanner (badges / filters before download) and the desktop client
// (definitive check after unpacking; it loads this file from client/embedded).
//
// Extensions alone are never trusted for disc images: a PC scene ISO and a Wii
// ISO share ".iso" — only the header decides. Reads a few bytes per file.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const PLATFORMS = {
  switch: { id: 'switch', name: 'Nintendo Switch', short: 'Switch' },
  wii: { id: 'wii', name: 'Wii', short: 'Wii' },
  gamecube: { id: 'gamecube', name: 'GameCube', short: 'GameCube' },
};

// files that can be a console game image
const ROM_EXT = /\.(nsp|nsz|xci|xcz|iso|gcm|rvz|wia|wbfs|gcz|ciso)$/i;

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return n === len ? buf : buf.subarray(0, n);
}

const ascii = (buf) => buf.toString('latin1').replace(/\0.*$/s, '').trim();
const gameId = (buf) => {
  const id = buf.toString('latin1', 0, 6);
  return /^[A-Z0-9]{6}$/.test(id) ? id : null;
};

/**
 * One file → { platform, kind, confidence, ids } or null.
 *   kind: nsp | xci | iso | rvz | wia | wbfs | gcz | ciso
 */
function detectFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (!ROM_EXT.test(file)) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (ext === '.nsp' || ext === '.nsz') {
      if (readAt(fd, 0, 4).toString('latin1') === 'PFS0') return { platform: 'switch', kind: 'nsp', confidence: 'high', ids: switchIds(file) };
      return null;
    }
    if (ext === '.xci' || ext === '.xcz') {
      if (readAt(fd, 0x100, 4).toString('latin1') === 'HEAD') return { platform: 'switch', kind: 'xci', confidence: 'high', ids: switchIds(file) };
      return null;
    }
    if (ext === '.wbfs') {
      if (readAt(fd, 0, 4).toString('latin1') === 'WBFS') return { platform: 'wii', kind: 'wbfs', confidence: 'high', ids: {} };
      return null;
    }
    if (ext === '.rvz' || ext === '.wia') {
      const magic = readAt(fd, 0, 4).toString('latin1');
      if (magic !== 'RVZ\x01' && magic !== 'WIA\x01') return null;
      // wia_disc_t follows the 0x48-byte file header: disc_type (1 GC, 2 Wii),
      // then the first 0x80 bytes of the disc header at +0x10
      const disc = readAt(fd, 0x48, 0x10 + 0x80);
      const type = disc.length >= 4 ? disc.readUInt32BE(0) : 0;
      const head = disc.subarray(0x10);
      const platform = type === 2 ? 'wii' : type === 1 ? 'gamecube' : null;
      if (!platform) return null;
      return { platform, kind: magic.startsWith('RVZ') ? 'rvz' : 'wia', confidence: 'high', ids: { gameId: gameId(head), title: ascii(head.subarray(0x20, 0x80)) || null } };
    }
    if (ext === '.iso' || ext === '.gcm') {
      if (size < 0x440) return null;
      const head = readAt(fd, 0, 0x60);
      if (head.readUInt32BE(0x18) === 0x5D1C9EA3) return { platform: 'wii', kind: 'iso', confidence: 'high', ids: { gameId: gameId(head), title: ascii(head.subarray(0x20, 0x60)) || null } };
      if (head.readUInt32BE(0x1C) === 0xC2339F3D) return { platform: 'gamecube', kind: 'iso', confidence: 'high', ids: { gameId: gameId(head), title: ascii(head.subarray(0x20, 0x60)) || null } };
      return null; // a PC / other-console ISO
    }
    if (ext === '.gcz') {
      // Dolphin GCZ (block-compressed). Magic 0xB10BC001 (LE); the disc header
      // is compressed, so GameCube unless the name says Wii.
      if (readAt(fd, 0, 4).readUInt32LE(0) === 0xB10BC001) return { platform: hintFromName(file) === 'wii' ? 'wii' : 'gamecube', kind: 'gcz', confidence: 'medium', ids: {} };
      return null;
    }
    if (ext === '.ciso') {
      if (readAt(fd, 0, 4).toString('latin1') === 'CISO') return { platform: hintFromName(file) === 'wii' ? 'wii' : 'gamecube', kind: 'ciso', confidence: 'medium', ids: {} };
      return null;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ }
  }
  return null;
}

/** Switch title ID + role from the usual "[0100ABCD12345000][v0]" naming. */
function switchIds(file) {
  const name = path.basename(file);
  const m = name.match(/\[([0-9A-F]{16})\]/i);
  const titleId = m ? m[1].toUpperCase() : null;
  let role = 'base';
  if (/\[(UPD|UPDATE)\]|\bupdate\b/i.test(name) || (titleId && titleId.endsWith('800'))) role = 'update';
  else if (/\[DLC\]|\bdlc\b/i.test(name) || (titleId && !/000$/.test(titleId) && !titleId.endsWith('800'))) role = 'dlc';
  const ver = name.match(/\[v(\d+)\]/i);
  return { titleId, role, version: ver ? Number(ver[1]) : null };
}

/** Release-name tags: a hint only (used when the payload is still archived). */
function hintFromName(name) {
  const s = String(name || '');
  if (/(\b|_)(NSW|Switch|NSP|XCI|NSZ)(\b|_)/i.test(s)) return 'switch';
  if (/(\b|_)Wii(?!\s*U|U)(\b|_)/i.test(s) || /\bWBFS\b/i.test(s)) return 'wii';
  if (/(\b|_)(GameCube|NGC|GCN)(\b|_)/i.test(s)) return 'gamecube';
  return null;
}

function walk(dir, maxDepth, out = [], depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth) walk(p, maxDepth, out, depth + 1); } else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * A Store entry or an unpacked install folder (file or directory) →
 * { platform, files: [{ path, size, platform, kind, ids }], launch } or null.
 * The platform is whichever console owns the most bytes of detected images.
 */
function detectPath(entryPath, { maxDepth = 3 } = {}) {
  let st;
  try { st = fs.statSync(entryPath); } catch { return null; }
  const candidates = st.isDirectory() ? walk(entryPath, maxDepth).filter((f) => ROM_EXT.test(f)) : [entryPath];
  const files = [];
  for (const f of candidates.slice(0, 400)) {
    const d = detectFile(f);
    if (!d) continue;
    let size = 0;
    try { size = fs.statSync(f).size; } catch { /* */ }
    files.push({ path: f, size, ...d });
  }
  if (!files.length) return null;
  const bytes = {};
  for (const f of files) bytes[f.platform] = (bytes[f.platform] || 0) + f.size;
  const platform = Object.entries(bytes).sort((a, b) => b[1] - a[1])[0][0];
  const own = files.filter((f) => f.platform === platform);
  return { platform, files: own, launch: chooseLaunch(platform, own) };
}

/** The file to hand the emulator: Switch base game (not update/DLC); disc 1. */
function chooseLaunch(platform, files) {
  if (!files.length) return null;
  const bySize = [...files].sort((a, b) => b.size - a.size);
  if (platform === 'switch') {
    const base = files.filter((f) => (f.ids?.role || 'base') === 'base');
    const pool = base.length ? base : files;
    // a cartridge dump (XCI) carries everything; else the largest base NSP
    return (pool.find((f) => f.kind === 'xci') || [...pool].sort((a, b) => b.size - a.size)[0]).path;
  }
  const disc1 = files.find((f) => /(disc|disk)\s*[-_ ]?\s*(1|one)\b/i.test(path.basename(f.path)));
  return (disc1 || bySize[0]).path;
}

module.exports = { PLATFORMS, ROM_EXT, detectFile, detectPath, chooseLaunch, hintFromName, switchIds };
