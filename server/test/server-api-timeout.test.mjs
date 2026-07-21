// Client JSON API helpers must time out so Refresh cannot stick disabled forever.
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { makeApi } = require('../../client/lib/serverApi.js');

test('getJson aborts hung responses (Refresh button safety)', async () => {
  const server = http.createServer((req, res) => {
    // Never respond — simulates a blocked embedded scan on the main process.
    void req;
    void res;
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const api = makeApi(
      () => ({
        serverUrl: `http://127.0.0.1:${port}`,
        apiKey: '',
        authToken: '',
      }),
      { jsonTimeoutMs: 400 },
    );

    const t0 = Date.now();
    await assert.rejects(
      () => api.status(),
      (e) => /timed out/i.test(String(e && e.message)),
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 350, `timed out too fast (${elapsed}ms)`);
    assert.ok(elapsed < 2500, `timed out too slow (${elapsed}ms)`);
  } finally {
    server.close();
  }
});
