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

function abortErr(signal) {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  err.reason = signal?.reason;
  return err;
}

// Copy one file with progress. Resumes from dest size when a partial exists.
// signal — AbortSignal for pause/cancel; destroys streams and keeps the partial.
function copyFileWithProgress(src, dest, onProgress, signal) {
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
  if (signal?.aborted) return Promise.reject(abortErr(signal));

  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src, { start: existing });
    const ws = fs.createWriteStream(dest, { flags: existing > 0 ? 'a' : 'w' });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { rs.unpipe(ws); } catch { /* */ }
      try { rs.destroy(); } catch { /* */ }
      // end() flushes buffered bytes so a pause leaves a durable partial
      try { ws.end(); } catch { try { ws.destroy(); } catch { /* */ } }
      reject(err);
    };
    const onAbort = () => fail(abortErr(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    rs.on('data', (chunk) => onProgress?.(chunk.length));
    rs.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(existing + (total - existing));
    });
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
// opts.signal — AbortSignal for pause/cancel (partials kept).
async function copyPackageToStaging(storeRoot, pkg, files, stagingDir, onChunk, opts = {}) {
  if (!storeRoot) throw new Error('No Store folder configured.');
  fs.mkdirSync(stagingDir, { recursive: true });
  for (const f of files) {
    if (opts.signal?.aborted) throw abortErr(opts.signal);
    const rel = f.path || path.basename(pkg.rel_path);
    const src = resolveStoreFile(storeRoot, pkg.rel_path, f.path);
    const dest = path.join(stagingDir, ...String(rel).split(/[/\\]/));
    await copyFileWithProgress(src, dest, (n) => onChunk?.(n, rel), opts.signal);
  }
}

module.exports = { copyFileWithProgress, copyPackageToStaging, resolveStoreFile, isInside };
