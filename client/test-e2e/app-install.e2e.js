#!/usr/bin/env node
// The whole app, for real: launch the PACKAGED Gamehub (Playwright drives
// Electron), point it at a local Store folder full of real releases, press
// Install on each through the same IPC the Install button uses, and check the
// game is installed, verified, and actually runs. Nothing is mocked — this is
// main.js's installGame(): copy → unpack → setup (silent) → crack → launcher →
// shortcuts, into the default C:\Program Files (x86)\Gamehub\games.
//
//   node test-e2e/app-install.e2e.js <Gamehub.exe> <storeDir> <expect.json>
// expect.json: { "<store folder name>": "<what the game exe prints>" , … }
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const [exe, storeDir, expectFile] = process.argv.slice(2);
const expect = JSON.parse(fs.readFileSync(expectFile, 'utf8'));
const userData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Gamehub');
const gamesDir = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Gamehub', 'games');
const log = (...a) => console.log('  ·', ...a);

(async () => {
  // a fresh local-mode Gamehub: Store = fixtures, Library = the Steam-style default
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    mode: 'local', storeDir, gamesDir, autoSilentInstall: true, applyReleaseCrack: true,
    elevatedLaunchPrompted: true, createDesktopShortcut: true, createStartMenuShortcut: false,
  }, null, 2));
  for (const f of ['installed.json', 'library.json']) fs.rmSync(path.join(userData, f), { force: true });

  const app = await electron.launch({ executablePath: exe, env: { ...process.env, GAMEHUB_NO_CONFIRM: '1' }, timeout: 120000 });
  const page = await app.firstWindow();
  page.on('console', (m) => { if (m.type() === 'error') log('renderer error:', m.text()); });
  await page.waitForFunction(() => !!window.gamehub, null, { timeout: 60000 });

  // the embedded server scans the Store in the background — wait for every folder
  const cfg = await page.evaluate(() => window.gamehub.getConfig());
  log('local server:', cfg.serverUrl, 'library:', cfg.gamesDir);
  let games = [];
  for (let i = 0; i < 120; i++) {
    games = await (await fetch(`${cfg.serverUrl}/api/games`)).json().catch(() => []);
    if (Object.keys(expect).every((name) => games.some((g) => g.rel_path === name))) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  log('store:', games.map((g) => `${g.id}:${g.rel_path} [${g.payload_type}]`).join(', '));

  const results = [];
  for (const [name, token] of Object.entries(expect)) {
    const g = games.find((x) => x.rel_path === name);
    const t0 = Date.now();
    try {
      assert.ok(g, `"${name}" was scanned`);
      // exactly what the one-click Install button calls
      const res = await page.evaluate(({ id }) => window.gamehub.install(id, id, null).then((r) => r, (e) => ({ error: String(e && e.message || e) })), { id: g.id });
      log(name, '→', JSON.stringify(res && { status: res.status, dir: res.dir, exe: res.exe, error: res.error, mode: res.mode }));
      assert.ok(!res?.error, res?.error);
      assert.strictEqual(res.status, 'installed', `status ${res.status}`);
      assert.ok(res.exe && fs.existsSync(res.exe), 'launcher exists');
      assert.ok(path.resolve(res.dir).toLowerCase().startsWith(path.resolve(gamesDir).toLowerCase())
        || /Program Files/i.test(res.dir), `installed under the library (${res.dir})`);
      const out = execFileSync(res.exe, { encoding: 'utf8', timeout: 20000 }).trim();
      assert.strictEqual(out, token, `the game runs (${path.basename(res.exe)} printed "${out}")`);
      results.push(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      results.push(`FAIL ${name}: ${err.message}`);
    }
  }

  // installed.json is what the UI shows after a restart
  const installed = JSON.parse(fs.readFileSync(path.join(userData, 'installed.json'), 'utf8'));
  log('installed.json:', Object.values(installed).map((e) => `${e.title}=${e.status}`).join(', '));
  const updLog = path.join(userData, 'logs', 'updater.log');
  if (fs.existsSync(updLog)) log('log tail:\n' + fs.readFileSync(updLog, 'utf8').split('\n').slice(-12).join('\n'));

  await app.close().catch(() => {});
  console.log('\n' + results.join('\n'));
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
