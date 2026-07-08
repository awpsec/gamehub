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
import { buildProviders, matchPendingGames, backfillMedia, adoptDlcIdentities, scoreCandidate } from './matcher.js';
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
      await adoptDlcIdentities(db, providers);
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
    // One-time: Steam is now the preferred metadata source, so re-check games
    // that were auto-matched to a keyed provider (RAWG/IGDB) before this change —
    // Steam usually has richer art/About/trailers. Re-queuing an auto-match is
    // always safe (it re-matches to something at least as good), so we only skip
    // manual matches — those carry confidence = 1.0 (older ones predate the
    // matched_manually flag), and re-queuing one could demote a careful fix.
    const s0 = getSettings(db);
    if (s0.steamEnabled && !s0.steamUpgradeDone) {
      const upgraded = db
        .prepare(
          "UPDATE games SET status = 'new', updated_at = datetime('now') " +
            "WHERE status = 'matched' AND provider IN ('rawg', 'igdb') " +
            "AND matched_manually != 1 AND confidence < 1.0"
        )
        .run().changes;
      saveSettings(db, { steamUpgradeDone: true });
      if (upgraded) console.log(`[gamehub] re-checking ${upgraded} RAWG/IGDB match(es) against Steam`);
    }

    // Second pass: the confidence<1.0 guard above also spared perfect-title
    // AUTO-matches (exact title + year bonus clamps to 1.0) — exactly the games
    // Steam should own. The reliable discriminator is "would this game re-match
    // on its own?": if the STORED title still auto-match-scores against the
    // folder name, re-queuing is zero-risk (worst case it matches straight
    // back). Hard manual fixes — where the name never matched — score low and
    // stay untouched.
    if (s0.steamEnabled && !s0.steamUpgradeV2Done) {
      const rows = db
        .prepare(
          "SELECT id, clean_name, hint_year, meta_title, meta_year FROM games " +
            "WHERE status = 'matched' AND provider IN ('rawg', 'igdb') AND matched_manually != 1"
        )
        .all();
      const requeue = db.prepare("UPDATE games SET status = 'new', updated_at = datetime('now') WHERE id = ?");
      let n = 0;
      for (const r of rows) {
        const score = scoreCandidate(r.clean_name, r.hint_year, { title: r.meta_title || '', year: r.meta_year });
        if (score >= s0.autoMatchThreshold) { requeue.run(r.id); n++; }
      }
      saveSettings(db, { steamUpgradeV2Done: true });
      if (n) console.log(`[gamehub] re-checking ${n} more keyed-provider match(es) against Steam`);
    }

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
