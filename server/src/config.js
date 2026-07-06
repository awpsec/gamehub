// Env-only bootstrap config: where things live. Everything tunable at runtime
// (sources, thresholds, scan interval, API key) is DB-backed — see settings.js.
export function loadConfig() {
  const env = process.env;
  return {
    port: parseInt(env.PORT || '8686', 10),
    dataDir: env.DATA_DIR || '/config',
  };
}
