#!/usr/bin/env node
// Every installer type Gamehub automates, installed for real on Windows CI
// through the same library calls installGame()/installDlc() use:
//   fingerprint → eligibility → silent install (into the Program-Files-style
//   library) → verify → the game exe actually runs → registered uninstall.
//
//   node test-e2e/engines.e2e.js <fixturesDir> <workRoot>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');

const lib = path.join(__dirname, '..', 'lib');
const installer = require(path.join(lib, 'installer'));
const silent = require(path.join(lib, 'silentInstall'));
const libraryRoot = require(path.join(lib, 'libraryRoot'));
const uninstallReg = require(path.join(lib, 'uninstallRegistry'));
const { fingerprintInstaller } = require(path.join(lib, 'fingerprint'));

const [fixtures, workRoot] = process.argv.slice(2);
const log = (...a) => console.log('  ·', ...a);
const results = [];
async function step(name, fn, timeoutMs = 6 * 60 * 1000) {
  const t = Date.now();
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), timeoutMs); })]);
    results.push(`ok   ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.stack || err.message}`);
  } finally { clearTimeout(timer); }
}
const gamesDir = path.join(workRoot, 'Gamehub', 'games'); // shaped like Program Files (x86)\Gamehub\games

function stage(kind, title, file) {
  const installDir = path.join(gamesDir, title);
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.mkdirSync(installDir, { recursive: true });
  const dest = path.join(installDir, file);
  fs.copyFileSync(path.join(fixtures, kind, file), dest);
  return { installDir, setup: dest };
}

async function silentInstall(kind, title, file, engine) {
  const { installDir, setup } = stage(kind, title, file);
  const fp = fingerprintInstaller(setup);
  log(kind, 'fingerprint:', fp.engine, fp.confidence, fp.support, fp.evidence.slice(0, 4).join(' '));
  assert.strictEqual(fp.engine, engine);
  const elig = silent.canAutoSilentInstall({ fingerprint: fp, autoSilentPref: true, targetDir: installDir, libraryRoots: [gamesDir] });
  assert.ok(elig.ok, `eligible: ${elig.reason}`);
  const res = await silent.attemptSilentInstallSafe({
    setupExe: setup, installDir, payloadDir: path.join(gamesDir, '_staging', `${title}-setup`), title,
    libraryRoots: [gamesDir], logDir: path.join(gamesDir, '_staging'),
    onPhase: (p, e) => log(kind, p, e?.message || ''),
  });
  log(kind, 'result:', res.ok, res.reason, res.error || '', 'dir:', res.targetDir, 'uninstaller:', JSON.stringify(res.uninstaller));
  assert.ok(res.ok, `silent install failed: ${res.reason} ${res.error || ''}`);
  const top = installer.rankGameExes(res.targetDir, title)[0];
  assert.ok(top, 'a launcher was found');
  assert.strictEqual(path.basename(top.path), `${title}.exe`);
  assert.strictEqual(execFileSync(top.path, { encoding: 'utf8' }).trim(), `${title.toUpperCase()}-OK`);
  return { res, top, installDir };
}

(async () => {
  console.log('7-Zip:', installer.find7zip());

  await step('library: default folder + one-time Users grant (Steam model)', async () => {
    assert.match(libraryRoot.defaultGamesDir(), /\\Program Files \(x86\)\\Gamehub\\games$/i);
    const root = path.join(libraryRoot.programFilesX86(), 'GamehubE2E');
    fs.rmSync(root, { recursive: true, force: true });
    const r = await libraryRoot.runGrant(root, { elevated: true }); // runner is already admin
    assert.ok(r.ok, JSON.stringify(r));
    const acl = execFileSync('icacls.exe', [root], { encoding: 'utf8' });
    log(acl.split(/\r?\n/).filter((l) => /Users/i.test(l)).join(' | '));
    assert.match(acl, /BUILTIN\\Users:\(OI\)\(CI\)\(M\)/i);
    assert.ok(libraryRoot.isWritable(path.join(root, 'games')));
    fs.rmSync(root, { recursive: true, force: true });
  });

  await step('NSIS: silent into the library', async () => {
    const { res } = await silentInstall('nsis', 'NsisGame', 'setup.exe', 'nsis');
    assert.strictEqual(path.resolve(res.targetDir), path.resolve(path.join(gamesDir, 'NsisGame')));
  });

  await step('MSI: msiexec /qn into the library, then silent uninstall', async () => {
    const { res } = await silentInstall('msi', 'MsiGame', 'game.msi', 'msi');
    assert.ok(res.uninstaller?.exe, 'registered uninstaller captured');
    // what Uninstall does for an MSI Gamehub installed silently
    const args = `${String(res.uninstaller.args).replace(/\/I(\s*\{)/i, '/X$1')} /qn /norestart`;
    const u = spawnSync(res.uninstaller.exe, [args], { windowsVerbatimArguments: true, encoding: 'utf8' });
    log('msi uninstall:', u.status);
    assert.ok([0, 3010, 1641].includes(u.status), `uninstall exit ${u.status}`);
    assert.ok(!fs.existsSync(path.join(res.targetDir, 'MsiGame.exe')), 'files removed');
  });

  await step('WiX Burn bundle (not named setup.exe): found, /quiet InstallFolder= into the library', async () => {
    const { installDir } = stage('burn', 'BundleGame', 'BundleGame-1.0.exe');
    assert.strictEqual(path.basename(installer.findInstaller(installDir) || ''), 'BundleGame-1.0.exe', 'found by fingerprint, not name');
    assert.ok(installer.isInstallerPrimary(installDir, 'BundleGame'), 'setup is the next step, not "play the bundle"');
    await silentInstall('burn', 'BundleGame', 'BundleGame-1.0.exe', 'burn');
  });

  await step('Self-extracting setup.exe (RAR SFX): unpacked, never run', async () => {
    const { installDir, setup } = stage('sfx', 'SfxGame', 'setup.exe');
    assert.ok(!fingerprintInstaller(setup).automatable, 'not an installer engine');
    const type = await installer.unwrapSelfExtractor(setup, installDir);
    assert.match(type, /^Rar5?$/);
    assert.ok(!fs.existsSync(setup), 'sfx stub removed');
    const top = installer.rankGameExes(installDir, 'SfxGame')[0];
    assert.strictEqual(execFileSync(top.path, { encoding: 'utf8' }).trim(), 'SFXGAME-OK');
  });

  await step('Inno DLC: silent straight into the installed game', async () => {
    const gameDir = path.join(gamesDir, 'Mygame');
    fs.rmSync(gameDir, { recursive: true, force: true });
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'Mygame.exe'), 'x');
    const setup = path.join(fixtures, 'dlc', 'setup.exe');
    const fp = fingerprintInstaller(setup);
    assert.strictEqual(fp.engine, 'inno');
    const r = await silent.runSilentInno(setup, gameDir, { engine: 'inno', requiresAdmin: !!fp.requiresAdmin, logPath: path.join(workRoot, 'dlc.log') });
    log('dlc:', JSON.stringify({ ok: r.ok, exitCode: r.exitCode, error: r.error }));
    assert.ok(r.ok, r.error);
    assert.ok(fs.existsSync(path.join(gameDir, 'DLC', 'dlc.pak')), 'DLC landed in the game folder');
    assert.ok(fs.existsSync(path.join(gameDir, 'Mygame.exe')), 'game untouched');
  });

  // tidy: anything registered by the MSI/Burn tests
  try {
    const reg = await uninstallReg.snapshot();
    for (const [, e] of reg) if (/^(BundleGame|NsisGame)$/.test(e.displayName || '')) log('registered:', e.displayName, e.uninstallString);
  } catch { /* */ }

  console.log('\n' + results.join('\n'));
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})();
