// Local-mode filesystem copy from the Store folder into staging.
// Used instead of HTTP when mode === 'local' so installs are a fast same-machine
// copy. The Store is only ever read — never renamed or deleted.
const fs = require('node:fs');
const path = require('node:path');

function isInside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

function copyFileWithProgress(src, dest, onProgress) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let existing = 0;
  try { existing = fs.statSync(dest).size; } catch { /* none */ }
  const total = fs.statSync(src).size;
  if (existing > total) {
    fs.rmSync(dest, { force: true });
    existing = 0;
  }
  if (existing === total) {
    onProgress?.(existing);
    return Promise.resolve(existing);
  }
  if (existing > 0) onProgress?.(existing);

  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src, { start: existing });
    const ws = fs.createWriteStream(dest, { flags: existing > 0 ? 'a' : 'w' });
    rs.on('data', (chunk) => onProgress?.(chunk.length));
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', () => resolve(existing + (total - existing)));
    rs.pipe(ws);
  });
}

// Resolve the absolute source file for one entry from /api/games/:id/files.
// Single-file payloads have empty f.path — the library entry itself is the file.
function resolveStoreFile(storeRoot, pkgRelPath, filePath) {
  const entry = path.resolve(storeRoot, pkgRelPath);
  if (!isInside(entry, storeRoot)) throw new Error('Invalid store path.');
  if (!filePath) {
    if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
      throw new Error(`Store entry is not a file: ${pkgRelPath}`);
    }
    return entry;
  }
  const src = path.resolve(entry, filePath);
  if (!isInside(src, storeRoot)) throw new Error('Refusing to read outside the Store folder.');
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new Error(`Missing store file: ${filePath}`);
  }
  return src;
}

// Copy every listed store file into stagingDir. storeRoot = torrent/Store folder.
async function copyPackageToStaging(storeRoot, pkg, files, stagingDir, onChunk) {
  if (!storeRoot) throw new Error('No Store folder configured.');
  fs.mkdirSync(stagingDir, { recursive: true });
  for (const f of files) {
    const rel = f.path || path.basename(pkg.rel_path);
    const src = resolveStoreFile(storeRoot, pkg.rel_path, f.path);
    const dest = path.join(stagingDir, ...String(rel).split(/[/\\]/));
    await copyFileWithProgress(src, dest, (n) => onChunk?.(n, rel));
  }
}

module.exports = { copyFileWithProgress, copyPackageToStaging, resolveStoreFile, isInside };
