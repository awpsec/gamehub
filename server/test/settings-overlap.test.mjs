// PUT /api/settings refuses overlapping libraryDir + storeDir (parity with the
// desktop client's local:configure guard).
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { checker, tmp, rm } from './_helpers.mjs';
import { startEmbeddedServer } from '../src/embed.js';

test('settings: overlapping store/library is rejected with 400', async () => {
  const { check, done } = checker();
  const dataDir = tmp('set-ov-db');
  const libDir = tmp('set-ov-lib');
  const srv = startEmbeddedServer({
    dataDir,
    libraryDir: libDir,
    storeDir: '',
    manageLibrary: false,
    port: 0,
    host: '127.0.0.1',
    localMode: true,
  });
  try {
    const port = await srv.ready;
    const put = async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    };

    // same path
    const same = await put({ storeDir: libDir });
    check('same path → 400', same.status === 400, String(same.status));
    check('error mentions overlap', /overlap/i.test(same.data.error || ''), same.data.error);

    // parent store containing the library
    const parent = path.dirname(libDir);
    const nested = await put({ storeDir: parent });
    check('parent store → 400', nested.status === 400, String(nested.status));

    // disjoint store is fine
    const store = tmp('set-ov-store');
    try {
      const ok = await put({ storeDir: store, manageLibrary: true });
      check('disjoint store → 200', ok.status === 200, String(ok.status));
      check('storeDir saved', ok.data.storeDir === store, ok.data.storeDir);
      check('manageLibrary saved', ok.data.manageLibrary === true, String(ok.data.manageLibrary));
    } finally {
      rm(store);
    }

    // settings unchanged after the rejected overlap attempt (store was '' then set)
    const cur = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
    check('library still original', cur.libraryDir === libDir, cur.libraryDir);
  } finally {
    await srv.close();
    rm(dataDir, libDir);
  }
  done(assert);
});
