// Boot a Gamehub server instance. Shared by the standalone server (index.js) and
// by the desktop client's serverless mode, which starts it in-process on a
// loopback port pointed at a local library folder — so the app needs no separate
// server at all. Returns handles (server, db, runScan, a `ready` promise that
// resolves to the actual bound port, and close()).
import { once } from 'node:events';
import crypto from 'node:crypto';
import { initDb } from './db.js';
import { createApi } from './api.js';
import { scanLibrary } from './scanner.js';
import { getSettings, saveSettings } from './settings.js';
import { buildProviders, matchPendingGames, backfillMedia } from './matcher.js';
import { logEvent } from './events.js';
import { sweepExpiredTokens, listUsers, createUser } from './auth.js';

export function startEmbeddedServer({
  dataDir,
  libraryDir = null, // null = leave the DB/env setting as-is (standalone server)
  port = 8686,
  host = '0.0.0.0',
  localMode = false, // serverless desktop mode: no login, single local admin
} = {}) {
  const db = initDb({ dataDir });

  // Pin the chosen library folder when one is passed (always the case for the
  // desktop app; the standalone server leaves it to the env/DB default).
  if (libraryDir) saveSettings(db, { libraryDir });

  // Serverless mode: ensure one admin account exists so per-user features
  // (playtime, profile) have a real row, then inject it on every request so
  // nothing ever prompts to sign in.
  let localUser = null;
  if (localMode) {
    const u = listUsers(db)[0] || createUser(db, 'local', crypto.randomBytes(18).toString('hex'), 'admin');
    localUser = { id: u.id, username: u.username, role: 'admin' };
  }

  let scanning = false;
  let lastScanAt = 0;
  async function runScan() {
    if (scanning) return;
    scanning = true;
    lastScanAt = Date.now();
    try {
      const settings = getSettings(db);
      const providers = buildProviders(settings);
      const { added, removed } = scanLibrary(db, { libraryDir: settings.libraryDir });
      if (added || removed) console.log(`[scan] done: +${added} / -${removed}`);
      await matchPendingGames(db, settings, providers);
      await backfillMedia(db, providers);
    } catch (err) {
      logEvent(db, 'error', 'scanner', 'Scan crashed', err.stack || err.message);
    } finally {
      scanning = false;
    }
  }

  const app = createApi({
    config: { dataDir, port },
    db,
    getSettings: () => getSettings(db),
    getProviders: () => buildProviders(getSettings(db)),
    triggerScan: () => runScan(),
    localUser,
  });

  const server = app.listen(port, host);
  const ready = once(server, 'listening').then(() => {
    // On boot, re-queue previously-unresolved games so shipped matcher
    // improvements heal them automatically on the next start.
    const requeued = db
      .prepare("UPDATE games SET status = 'new', updated_at = datetime('now') WHERE status IN ('unmatched', 'pending')")
      .run().changes;
    if (requeued) console.log(`[gamehub] re-queued ${requeued} unresolved game(s) for a fresh match`);
    runScan();
    const scanTimer = setInterval(() => {
      if (Date.now() - lastScanAt >= getSettings(db).scanIntervalMinutes * 60_000) runScan();
    }, 30_000);
    sweepExpiredTokens(db);
    const gcTimer = setInterval(() => sweepExpiredTokens(db), 3_600_000);
    server.on('close', () => { clearInterval(scanTimer); clearInterval(gcTimer); });
    return server.address().port;
  });

  return {
    app,
    db,
    server,
    runScan,
    ready,
    get port() {
      const a = server.address();
      return a && typeof a === 'object' ? a.port : port;
    },
    close: () => new Promise((res) => server.close(res)),
  };
}
