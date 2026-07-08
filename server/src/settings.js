// DB-backed settings, editable from the web UI at runtime.
// Env vars act as defaults (first-boot seed); the DB value always wins.

export const SETTING_DEFS = [
  // --- library ---
  { key: 'libraryDir', env: 'LIBRARY_DIR', type: 'string', default: '/games' },
  // --- metadata sources ---
  { key: 'steamEnabled', env: 'STEAM_ENABLED', type: 'boolean', default: true },
  { key: 'rawgApiKey', env: 'RAWG_API_KEY', type: 'string', default: '' },
  { key: 'igdbClientId', env: 'IGDB_CLIENT_ID', type: 'string', default: '' },
  { key: 'igdbClientSecret', env: 'IGDB_CLIENT_SECRET', type: 'string', default: '' },
  // --- matching ---
  { key: 'autoMatchThreshold', env: 'AUTO_MATCH_THRESHOLD', type: 'number', default: 0.85, min: 0.5, max: 1 },
  { key: 'minCandidateScore', env: 'MIN_CANDIDATE_SCORE', type: 'number', default: 0.4, min: 0, max: 1 },
  // --- scanning ---
  { key: 'scanIntervalMinutes', env: 'SCAN_INTERVAL_MINUTES', type: 'number', default: 15, min: 1, max: 1440 },
  // --- security ---
  { key: 'apiKey', env: 'API_KEY', type: 'string', default: '' },
  // --- internal one-time migration flags ---
  { key: 'steamUpgradeDone', env: 'STEAM_UPGRADE_DONE', type: 'boolean', default: false },
  { key: 'steamUpgradeV2Done', env: 'STEAM_UPGRADE_V2_DONE', type: 'boolean', default: false },
];

const BY_KEY = Object.fromEntries(SETTING_DEFS.map((d) => [d.key, d]));

function coerce(def, raw) {
  if (raw == null) return def.default;
  if (def.type === 'number') {
    const n = parseFloat(raw);
    if (Number.isNaN(n)) return def.default;
    return Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, n));
  }
  if (def.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    return String(raw).toLowerCase() === 'true' || String(raw) === '1';
  }
  return String(raw);
}

export function initSettings(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const def of SETTING_DEFS) {
    const raw = stored[def.key] !== undefined ? stored[def.key] : process.env[def.env];
    out[def.key] = coerce(def, raw);
  }
  return out;
}

export function saveSettings(db, patch) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const applied = {};
  for (const [key, value] of Object.entries(patch || {})) {
    const def = BY_KEY[key];
    if (!def) continue; // unknown keys are ignored
    const coerced = coerce(def, value);
    upsert.run(key, String(coerced));
    applied[key] = coerced;
  }
  return applied;
}
