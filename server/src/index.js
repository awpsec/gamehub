import { loadConfig } from './config.js';
import { initDb } from './db.js';
import { createApi } from './api.js';
import { scanLibrary } from './scanner.js';
import { getSettings } from './settings.js';
import { buildProviders, matchPendingGames, backfillMedia } from './matcher.js';
import { logEvent } from './events.js';
import { sweepExpiredTokens } from './auth.js';

const config = loadConfig(); // port + directories (env-only); everything else lives in DB settings
const db = initDb(config);

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
  config,
  db,
  getSettings: () => getSettings(db),
  getProviders: () => buildProviders(getSettings(db)),
  triggerScan: () => runScan(),
});

app.listen(config.port, () => {
  const settings = getSettings(db);
  const providers = buildProviders(settings);
  console.log(`[gamehub] server on http://0.0.0.0:${config.port}`);
  console.log(`[gamehub] library: ${settings.libraryDir} (read-only by design — seeding safe)`);
  console.log(
    `[gamehub] sources: ${providers.length ? providers.map((p) => p.name).join(', ') : 'none configured — add one in Settings'}`
  );
  // On boot, re-queue previously-unresolved games so a shipped matching
  // improvement heals them automatically on the next restart — no manual
  // "Re-run matching" needed. Only touches unmatched/pending; matched and
  // ignored rows are left alone.
  const requeued = db
    .prepare("UPDATE games SET status = 'new', updated_at = datetime('now') WHERE status IN ('unmatched', 'pending')")
    .run().changes;
  if (requeued) console.log(`[gamehub] re-queued ${requeued} unresolved game(s) for a fresh match`);
  runScan();
  // tick every 30s and honor the (runtime-editable) scan interval
  setInterval(() => {
    const { scanIntervalMinutes } = getSettings(db);
    if (Date.now() - lastScanAt >= scanIntervalMinutes * 60_000) runScan();
  }, 30_000);
  // GC expired session tokens hourly (kept off the hot per-request auth path)
  sweepExpiredTokens(db);
  setInterval(() => sweepExpiredTokens(db), 3_600_000);
});
