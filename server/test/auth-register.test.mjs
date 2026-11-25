// Self-service account creation + guest-readable browse after connect.
import test from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { checker, tmp, rm } from './_helpers.mjs';
import { initDb } from '../src/db.js';
import { createApi } from '../src/api.js';
import { countUsers, listUsers } from '../src/auth.js';

async function startServer(dataDir) {
  const db = initDb({ dataDir });
  const libDir = tmp('auth-lib');
  const settings = {
    libraryDir: libDir,
    apiKey: '',
    autoMatchThreshold: 0.7,
  };
  const app = createApi({
    config: { dataDir, port: 0 },
    db,
    getSettings: () => settings,
    getProviders: () => [],
    triggerScan: () => {},
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return { db, server, base: `http://127.0.0.1:${port}`, libDir };
}

test('auth register: first account is admin, later accounts are users', async () => {
  const { check, done } = checker();
  const dataDir = tmp('auth-reg');
  let server;
  let db;
  let libDir;
  try {
    const started = await startServer(dataDir);
    db = started.db;
    server = started.server;
    libDir = started.libDir;
    const { base } = started;

    const st0 = await (await fetch(`${base}/api/auth/status`)).json();
    check('empty server needs setup', st0.setupRequired === true && st0.authRequired === false);

    const badConfirm = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'zedd', password: 'secret1', confirm: 'nope' }),
    });
    check('mismatched confirm rejected', badConfirm.status === 400, String(badConfirm.status));

    const first = await (await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'zedd', password: 'secret1', confirm: 'secret1' }),
    })).json();
    check('first register returns token', !!first.token);
    check('first register is admin', first.user?.role === 'admin' && first.user?.username === 'zedd', JSON.stringify(first.user));
    check('one user in db', countUsers(db) === 1);

    const st1 = await (await fetch(`${base}/api/auth/status`)).json();
    check('after first user, auth required', st1.setupRequired === false && st1.authRequired === true);

    const second = await (await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'friend', password: 'secret2', confirm: 'secret2' }),
    })).json();
    check('second register is regular user', second.user?.role === 'user' && !!second.token, JSON.stringify(second.user));

    const dup = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Zedd', password: 'secret3', confirm: 'secret3' }),
    });
    const dupBody = await dup.json().catch(() => ({}));
    check('duplicate username rejected', dup.status === 400 && /taken|unique|already/i.test(dupBody.error || ''), JSON.stringify(dupBody));

    const users = listUsers(db);
    check('two accounts exist', users.length === 2, String(users.length));
    check('roles admin+user', users.some((u) => u.role === 'admin') && users.some((u) => u.role === 'user'));

    // guest can still browse the matched catalog without a token
    const games = await fetch(`${base}/api/games?status=matched`);
    check('guest browse allowed', games.status === 200, String(games.status));
  } finally {
    if (server) await new Promise((res) => server.close(res));
    if (db) db.close();
    rm(dataDir, libDir);
  }
  done(assert);
});
