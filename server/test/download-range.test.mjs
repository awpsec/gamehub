// GET /api/games/:id/download — full body + HTTP Range resume (206).
// Seed-safe: only reads library files. Client uses this to continue large
// installs after a dropped Tailscale/Wi‑Fi link.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { checker, tmp, rm, writeFile } from './_helpers.mjs';
import { startEmbeddedServer } from '../src/embed.js';

test('download: full body + Range resume returns 206 partial content', async () => {
  const { check, done } = checker();
  const dataDir = tmp('dl-rng-db');
  const libDir = tmp('dl-rng-lib');
  const srv = startEmbeddedServer({ dataDir, libraryDir: libDir, port: 0, host: '127.0.0.1', localMode: true });
  try {
    const port = await srv.ready;
    const SIZE = 2048;
    writeFile(libDir, 'BigGame/payload.bin', SIZE);
    // Distinct non-zero bytes so we can verify the resumed slice.
    const abs = path.join(libDir, 'BigGame', 'payload.bin');
    const buf = Buffer.alloc(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = i % 256;
    fs.writeFileSync(abs, buf);

    srv.db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status)
       VALUES ('BigGame', 'BigGame', 'big game', 'folder', ?, 'matched')`
    ).run(SIZE);
    const id = srv.db.prepare("SELECT id FROM games WHERE rel_path = 'BigGame'").get().id;
    const url = `http://127.0.0.1:${port}/api/games/${id}/download?path=payload.bin`;

    const full = await fetch(url);
    check('full download 200', full.status === 200, String(full.status));
    check('Accept-Ranges bytes', (full.headers.get('accept-ranges') || '').toLowerCase() === 'bytes', full.headers.get('accept-ranges'));
    check('Content-Length full', full.headers.get('content-length') === String(SIZE), full.headers.get('content-length'));
    const fullBody = Buffer.from(await full.arrayBuffer());
    check('full body length', fullBody.length === SIZE, String(fullBody.length));
    check('full body matches', fullBody.equals(buf));

    const mid = 768;
    const partial = await fetch(url, { headers: { Range: `bytes=${mid}-` } });
    check('range download 206', partial.status === 206, String(partial.status));
    check('Content-Range present', (partial.headers.get('content-range') || '') === `bytes ${mid}-${SIZE - 1}/${SIZE}`, partial.headers.get('content-range'));
    check('Content-Length partial', partial.headers.get('content-length') === String(SIZE - mid), partial.headers.get('content-length'));
    const partBody = Buffer.from(await partial.arrayBuffer());
    check('partial length', partBody.length === SIZE - mid, String(partBody.length));
    check('partial bytes match', partBody.equals(buf.subarray(mid)));

    const bad = await fetch(url, { headers: { Range: `bytes=${SIZE + 10}-` } });
    check('unsatisfiable range 416', bad.status === 416, String(bad.status));

    // path traversal blocked
    const trav = await fetch(`http://127.0.0.1:${port}/api/games/${id}/download?path=../../etc/passwd`);
    check('path traversal rejected', trav.status === 400 || trav.status === 404, String(trav.status));
  } finally {
    await srv.close();
    rm(dataDir, libDir);
  }
  done(assert);
});
