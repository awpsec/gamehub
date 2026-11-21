// Stale session tokens must not look "signed in" for downloads.
import test from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { checker, tmp, rm } from './_helpers.mjs';
import { initDb } from '../src/db.js';
import { createApi } from '../src/api.js';
import { createUser, createToken, getUserByToken } from '../src/auth.js';

async function startServer(dataDir) {
  const db = initDb({ dataDir });
  const libDir = tmp('auth-sess-lib');
  const settings = { libraryDir: libDir, apiKey: '', autoMatchThreshold: 0.7 };
  const app = createApi({
    config: { dataDir, port: 0 },
    db,
    getSettings: () => settings,
    getProviders: () => [],
    triggerScan: () => {},
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, libDir };
}

test('auth session: expired token is guest; live token slides TTL', async () => {
  const { check, done } = checker();
  const dataDir = tmp('auth-sess');
  let server; let libDir;
  try {
    const started = await startServer(dataDir);
    server = started.server;
    libDir = started.libDir;
    const { db, base } = started;

    const user = createUser(db, 'zedd', 'password1', 'admin');
    const token = createToken(db, user.id);

    // Live token resolves + slides when near expiry
    const me1 = await fetch(`${base}/api/auth/me`, { headers: { 'X-Auth-Token': token } }).then((r) => r.json());
    check('live token is authenticated', me1.username === 'zedd' && me1.role === 'admin', JSON.stringify(me1));

    // Force expiry into the sliding window (< half TTL remaining) and confirm renew
    db.prepare(`UPDATE tokens SET expires_at = datetime('now', '+3 days') WHERE token = ?`).run(token);
    const before = db.prepare('SELECT expires_at FROM tokens WHERE token = ?').get(token).expires_at;
    getUserByToken(db, token);
    const after = db.prepare('SELECT expires_at FROM tokens WHERE token = ?').get(token).expires_at;
    check('TTL slides when under half remaining', after > before, `${before} → ${after}`);

    // Expired token → /api/auth/me is guest; downloads/files require auth
    db.prepare(`UPDATE tokens SET expires_at = datetime('now', '-1 day') WHERE token = ?`).run(token);
    const me2 = await fetch(`${base}/api/auth/me`, { headers: { 'X-Auth-Token': token } }).then((r) => r.json());
    check('expired token is guest on /me', me2.role === 'guest' && !me2.username, JSON.stringify(me2));

    const files = await fetch(`${base}/api/games/1/files`, { headers: { 'X-Auth-Token': token } });
    const body = await files.json().catch(() => ({}));
    check('expired token cannot list files', files.status === 401 && /sign in required/i.test(body.error || ''), `${files.status} ${JSON.stringify(body)}`);
  } finally {
    try { server?.close(); } catch { /* */ }
    rm(dataDir, libDir);
  }
  done(assert);
});
