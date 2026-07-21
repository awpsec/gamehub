// Refresh / rescan must not hang the client or drop overlapping scan requests.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { startEmbeddedServer } from '../src/embed.js';
import { tmp, rm } from './_helpers.mjs';

async function waitFor(fn, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out (last=${JSON.stringify(last)})`);
}

test('POST /api/rescan returns immediately and exposes scan state', async () => {
  const dataDir = tmp('rescan-data');
  const libDir = tmp('rescan-lib');
  for (let i = 0; i < 3; i++) {
    const d = path.join(libDir, `Dummy Game ${i} (2020)`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'setup.exe'), 'MZ');
  }
  const srv = startEmbeddedServer({
    dataDir,
    libraryDir: libDir,
    port: 0,
    host: '127.0.0.1',
    localMode: true,
  });
  try {
    const port = await srv.ready;
    const base = `http://127.0.0.1:${port}`;

    const t0 = Date.now();
    const res = await fetch(`${base}/api/rescan`, { method: 'POST' });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    // Must not wait on the full FS walk + matcher — that was greying Refresh forever.
    assert.ok(elapsed < 2000, `rescan blocked for ${elapsed}ms`);

    const st = await fetch(`${base}/api/status`).then((r) => r.json());
    assert.ok(st.scan && typeof st.scan.scanning === 'boolean', 'status.scan missing');
    assert.ok(typeof st.scan.lastScanAt === 'number');
  } finally {
    await srv.close();
    rm(dataDir, libDir);
  }
});

test('overlapping runScan queues a follow-up instead of dropping', async () => {
  const dataDir = tmp('queue-data');
  const libDir = tmp('queue-lib');
  fs.mkdirSync(libDir, { recursive: true });
  for (let i = 0; i < 3; i++) {
    const d = path.join(libDir, `Hold Scan ${i} (2020)`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'setup.exe'), 'MZ');
  }
  const srv = startEmbeddedServer({
    dataDir,
    libraryDir: libDir,
    port: 0,
    host: '127.0.0.1',
    localMode: true,
  });
  try {
    await srv.ready;
    await waitFor(() => {
      const s = srv.getScanState();
      return !s.scanning && !s.queued;
    }, { timeoutMs: 60000 });

    srv.db.prepare(
      "UPDATE games SET status = 'new', updated_at = datetime('now')",
    ).run();

    // Async functions run sync until the first await. First call sets scanning=true
    // and hits await matchPendingGames; second call in the same turn must queue.
    const p1 = srv.runScan();
    const p2 = srv.runScan();
    assert.equal(srv.getScanState().scanning, true);
    assert.equal(srv.getScanState().queued, true, 'expected scanQueued while busy');
    void p1;
    void p2;
  } finally {
    await srv.close();
    rm(dataDir, libDir);
  }
});

test('new folder discovered after queued follow-up scan', async () => {
  const dataDir = tmp('queue-follow');
  const libDir = tmp('queue-follow-lib');
  fs.mkdirSync(libDir, { recursive: true });
  const srv = startEmbeddedServer({
    dataDir,
    libraryDir: libDir,
    port: 0,
    host: '127.0.0.1',
    localMode: true,
  });
  try {
    await srv.ready;
    await waitFor(() => {
      const s = srv.getScanState();
      return !s.scanning && !s.queued;
    }, { timeoutMs: 30000 });

    const gameDir = path.join(libDir, 'Queued Title (2021)');
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'game.exe'), 'MZ');

    await srv.runScan();
    const row = srv.db.prepare(
      "SELECT clean_name, status FROM games WHERE rel_path LIKE ?",
    ).get('%Queued Title%');
    assert.ok(row, 'new folder should be scanned into DB');
  } finally {
    await srv.close();
    rm(dataDir, libDir);
  }
});
