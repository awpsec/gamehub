// Client downloadFile resume against a real embedded server (Range + append).
// Uses the desktop client's serverApi via createRequire (CommonJS module).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checker, tmp, rm } from './_helpers.mjs';
import { startEmbeddedServer } from '../src/embed.js';

const require = createRequire(import.meta.url);
const { makeApi } = require('../../client/lib/serverApi.js');

test('client downloadFile: resumes a partial via Range', async () => {
  const { check, done } = checker();
  const dataDir = tmp('dl-cli-db');
  const libDir = tmp('dl-cli-lib');
  const destDir = tmp('dl-cli-dest');
  const srv = startEmbeddedServer({ dataDir, libraryDir: libDir, port: 0, host: '127.0.0.1', localMode: true });
  try {
    const port = await srv.ready;
    const SIZE = 4096;
    const abs = path.join(libDir, 'ResumeMe', 'chunk.bin');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const buf = Buffer.alloc(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 7) % 256;
    fs.writeFileSync(abs, buf);

    srv.db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status)
       VALUES ('ResumeMe', 'ResumeMe', 'resume me', 'folder', ?, 'matched')`
    ).run(SIZE);
    const id = srv.db.prepare("SELECT id FROM games WHERE rel_path = 'ResumeMe'").get().id;

    const api = makeApi(() => ({
      serverUrl: `http://127.0.0.1:${port}`,
      authToken: '',
      apiKey: '',
    }));

    const dest = path.join(destDir, 'chunk.bin');
    const PARTIAL = 1500;
    fs.writeFileSync(dest, buf.subarray(0, PARTIAL));

    let credited = 0;
    const got = await api.downloadFile(id, 'chunk.bin', dest, (n) => { credited += n; }, SIZE);
    check('returns full size', got === SIZE, String(got));
    check('progress credits all bytes', credited === SIZE, String(credited));
    const onDisk = fs.readFileSync(dest);
    check('file complete on disk', onDisk.length === SIZE, String(onDisk.length));
    check('bytes match source', onDisk.equals(buf));

    // Second call with a complete file should no-op (no network rewrite).
    let credited2 = 0;
    const got2 = await api.downloadFile(id, 'chunk.bin', dest, (n) => { credited2 += n; }, SIZE);
    check('skip complete file', got2 === SIZE && credited2 === SIZE, `${got2}/${credited2}`);
  } finally {
    await srv.close();
    rm(dataDir, libDir, destDir);
  }
  done(assert);
});
