import { loadConfig } from './config.js';
import { getSettings } from './settings.js';
import { buildProviders } from './matcher.js';
import { startEmbeddedServer } from './embed.js';

// Standalone server (Docker / bare metal). The desktop client's serverless mode
// calls startEmbeddedServer() directly instead of going through this entry.
const config = loadConfig(); // env-only: port + dataDir. Library dir is a DB setting.
const { db, ready } = startEmbeddedServer({
  dataDir: config.dataDir,
  port: config.port,
  host: '0.0.0.0',
  localMode: false,
});

ready.then((port) => {
  const settings = getSettings(db);
  const providers = buildProviders(settings);
  console.log(`[gamehub] server on http://0.0.0.0:${port}`);
  console.log(`[gamehub] library: ${settings.libraryDir} (read-only by design — seeding safe)`);
  console.log(
    `[gamehub] sources: ${providers.length ? providers.map((p) => p.name).join(', ') : 'none configured — add one in Settings'}`
  );
});
