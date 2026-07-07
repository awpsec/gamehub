// Copies the server source into client/embedded so the desktop app can run it
// in-process (serverless mode). Runs before `start` and `dist`. The embedded
// copy resolves its deps (express, better-sqlite3) from the CLIENT's
// node_modules, which are rebuilt for Electron's ABI — so the same code runs
// under Electron's Node without a second, mismatched better-sqlite3.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', '..', 'server', 'src');
const dest = path.join(here, '..', 'embedded');

if (!fs.existsSync(src)) {
  console.error(`[sync-server] server source not found at ${src}`);
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
// The server is ESM (import/export) but the client package.json is CommonJS, so
// Node would parse these copied .js files as CJS and choke on `import`. A nested
// package.json scopes them to ESM; dependency resolution still walks up to the
// client's node_modules (express, better-sqlite3 rebuilt for Electron).
fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2) + '\n');
const count = fs.readdirSync(dest, { recursive: true }).filter((f) => String(f).endsWith('.js')).length;
console.log(`[sync-server] copied ${count} server file(s) -> client/embedded`);
