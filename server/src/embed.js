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
import { buildProviders, matchPendingGames, backfillMedia, adoptDlcIdentities, resolveBundles, reclassifyUpdates, scoreCandidate } from './matcher.js';
import { logEvent } from './events.js';
import { sweepExpiredTokens, listUsers, createUser } from './auth.js';
import { runBackup, applyPendingRestore } from './backup.js';
import { organizeLibrary } from './organize.js';

export function startEmbeddedServer({
  dataDir,
  libraryDir = null, // null = leave the DB/env setting as-is (standalone server)
  storeDir = null, // null = leave as-is; serverless passes the seeding-store path (may be '')
  manageLibrary = null, // null = leave as-is; serverless passes the organize toggle
  organizeDir = null, // local Store+Library: organize installs here (gamesDir); null = organize libraryDir
  port = 8686,
  host = '0.0.0.0',
  localMode = false, // serverless desktop mode: no login, single local admin
} = {}) {
  // Restore-on-boot: a `restore.db` dropped into dataDir is swapped in before
  // the DB is opened (the current copy is kept aside, never destroyed).
  applyPendingRestore(dataDir);
  const db = initDb({ dataDir });

  // Pin serverless-provided library settings (the desktop app passes these; the
  // standalone server passes none and keeps its env/DB values). null/undefined =
  // leave that DB setting untouched; '' / false are respected (e.g. clear store).
  const pinned = {};
  if (libraryDir) pinned.libraryDir = libraryDir;
  if (storeDir != null) pinned.storeDir = storeDir;
  if (manageLibrary != null) pinned.manageLibrary = manageLibrary;
  if (Object.keys(pinned).length) saveSettings(db, pinned);

  // Serverless mode: ensure one admin account exists so per-user features
  // (playtime, profile) have a real row, then inject it on every request so
  // nothing ever prompts to sign in.
  let localUser = null;
  if (localMode) {
    const u = listUsers(db)[0] || createUser(db, 'local', crypto.randomBytes(18).toString('hex'), 'admin');
    localUser = { id: u.id, username: u.username, role: 'admin' };
  }

  let scanning = false;
  let scanQueued = false;
  let lastScanAt = 0;
  let lastBackupAt = 0;

  async function runScan() {
    // Overlapping Refresh / interval / boot must not drop a disk pass — queue one
    // follow-up instead of silently returning while matching holds the lock.
    if (scanning) {
      scanQueued = true;
      return;
    }
    scanning = true;
    lastScanAt = Date.now();
    try {
      const settings = getSettings(db);
      const providers = buildProviders(settings);
      // Catalog scan: always settings.libraryDir (NAS on standalone; Store folder
      // when the desktop client pins storeDir → libraryDir in local mode).
      const { added, removed } = scanLibrary(db, { libraryDir: settings.libraryDir });
      if (added || removed) console.log(`[scan] done: +${added} / -${removed}`);
      await matchPendingGames(db, settings, providers);
      await backfillMedia(db, providers);
      await adoptDlcIdentities(db, providers);
      await resolveBundles(db, providers, settings.libraryDir);
      // Managed library only (opt-in): rename folders to "Title (Year)", file
      // updates, flag junk. Standalone/NAS: organizes libraryDir (leave OFF for
      // seeding). Local Store+Library: organizes organizeDir (gamesDir installs)
      // and uses the Store (libraryDir) as the read-only overlap guard.
      if (settings.manageLibrary) {
        const target = organizeDir || settings.libraryDir;
        const guard = organizeDir
          ? (settings.libraryDir || settings.storeDir || null)
          : (settings.storeDir || null);
        // Local Store+Library: organize installs on disk but never rewrite
        // catalog rel_path (those still point at the Store / torrents).
        organizeLibrary(db, target, { storeDir: guard, updateDb: !organizeDir });
      }
    } catch (err) {
      logEvent(db, 'error', 'scanner', 'Scan crashed', err.stack || err.message);
    } finally {
      scanning = false;
      if (scanQueued) {
        scanQueued = false;
        setImmediate(() => {
          runScan().catch((err) => {
            logEvent(db, 'error', 'scanner', 'Queued scan failed', err.stack || err.message);
          });
        });
      }
    }
  }

  /** Fire-and-forget — never run the sync FS walk on the HTTP/caller stack. */
  function requestScan() {
    setImmediate(() => {
      runScan().catch((err) => {
        logEvent(db, 'error', 'scanner', 'Scan failed', err.stack || err.message);
      });
    });
  }

  function getScanState() {
    return { scanning, queued: scanQueued, lastScanAt };
  }

  const app = createApi({
    config: { dataDir, port },
    db,
    getSettings: () => getSettings(db),
    getProviders: () => buildProviders(getSettings(db)),
    triggerScan: requestScan,
    getScanState,
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

    // Update/full classification is derived from names only — re-run it every
    // boot so cleaner improvements reach existing rows (an update posing as an
    // installable version is a destructive trap).
    reclassifyUpdates(db);

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

    // Automatic rotated snapshots of gamehub.db (all the derived data the
    // read-only library can't rebuild). Fire once on boot, then on an interval;
    // never let a backup failure take down the server. backupIntervalHours=0
    // disables it.
    const backup = () => {
      const s = getSettings(db);
      if (!(s.backupIntervalHours > 0)) return;
      lastBackupAt = Date.now();
      try {
        const f = runBackup(db, dataDir, s.backupKeep);
        console.log(`[gamehub] backup written: ${f}`);
      } catch (err) {
        logEvent(db, 'error', 'backup', 'Database backup failed', err.stack || err.message);
      }
    };
    backup(); // snapshot on every boot
    const backupTimer = setInterval(() => {
      const h = getSettings(db).backupIntervalHours;
      if (h > 0 && Date.now() - lastBackupAt >= h * 3_600_000) backup();
    }, 300_000); // check every 5 min; the interval gate decides when to run
    server.on('close', () => { clearInterval(scanTimer); clearInterval(gcTimer); clearInterval(backupTimer); });
    return server.address().port;
  });

  return {
    app,
    db,
    server,
    runScan,
    requestScan,
    getScanState,
    ready,
    get port() {
      const a = server.address();
      return a && typeof a === 'object' ? a.port : port;
    },
    close: () => new Promise((res) => server.close(res)),
  };
}
