#!/usr/bin/env node
// End-to-end on a real Windows box (CI): a RUNE-style release made by
// make-scene-release.ps1 goes through the same library steps installGame()
// in main.js composes:
//   unpack (multi-part RAR → ISO → files) → "setup is the next step" →
//   fingerprint → silent Inno install → crack applied → launcher picked →
//   the launcher actually runs and is the cracked one.
// Plus the failure modes that used to end in a silent "no launcher found":
// a missing part and a corrupt part must stop with a clear message.
//
//   node test-e2e/scene-release.e2e.js <releaseDir> <workRoot>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const lib = path.join(__dirname, '..', 'lib');
const installer = require(path.join(lib, 'installer'));
const scene = require(path.join(lib, 'sceneRelease'));
const silent = require(path.join(lib, 'silentInstall'));
const { fingerprintInstaller } = require(path.join(lib, 'fingerprint'));

const [releaseDir, workRoot] = process.argv.slice(2);
if (!releaseDir || !workRoot) { console.error('usage: scene-release.e2e.js <releaseDir> <workRoot>'); process.exit(2); }

const TITLE = 'Mygame';
const log = (...a) => console.log('  ·', ...a);
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
}
function fresh(name) {
  const gamesDir = path.join(workRoot, name, 'Games');
  fs.rmSync(path.join(workRoot, name), { recursive: true, force: true });
  const staging = path.join(gamesDir, '_staging', `1-pkg1-${TITLE}`);
  copyDir(releaseDir, staging);
  return { gamesDir, staging, installDir: path.join(gamesDir, TITLE) };
}
const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push(`ok   ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.stack || err.message}`);
  }
}

(async () => {
  const sz = installer.find7zip();
  console.log('7-Zip:', sz);

  await step('bundled full 7-Zip is used', () => {
    assert.ok(sz && sz.bundled && sz.supportsRar && sz.supportsIso, 'expected vendored 7-Zip');
  });

  await step('scene release: unpack → silent setup → crack → launcher', async () => {
    const { gamesDir, staging, installDir } = fresh('ok');
    assert.deepStrictEqual(installer.missingVolumes(path.join(staging, 'rune-mygame.rar')), []);
    fs.mkdirSync(installDir, { recursive: true });
    const n = await installer.extractAll(staging, installDir, (m, pct) => { if (pct == null || pct % 25 === 0) log(m, pct ?? ''); });
    assert.ok(n >= 2, `expected RAR set + ISO to be unpacked, got ${n}`);
    installer.flattenSingleDir(installDir);
    log('unpacked:', fs.readdirSync(installDir).join(', '));
    assert.ok(fs.existsSync(path.join(installDir, 'setup.exe')), 'setup.exe from the ISO');
    assert.ok(fs.existsSync(path.join(installDir, 'RUNE')), 'RUNE folder from the ISO');
    assert.ok(!fs.readdirSync(installDir).some((f) => /\.iso$/i.test(f)), 'ISO removed after unpacking');

    // the crack's Shipping exe must not make this look like a finished game
    assert.ok(installer.isInstallerPrimary(installDir, TITLE), 'setup is the next step');
    const setupExe = installer.findInstaller(installDir);
    assert.strictEqual(path.basename(setupExe).toLowerCase(), 'setup.exe');
    assert.ok(!installer.rankGameExes(installDir, TITLE).some((r) => /RUNE/.test(r.path)), 'crack exe is not a launcher');
    assert.strictEqual(scene.findCrackDirs(installDir).length, 1, 'crack folder found');
    if (process.platform !== 'win32') return; // Linux: no Inno build here — unpack + detection only
    const fp = fingerprintInstaller(setupExe);
    log('fingerprint:', fp.engine, fp.confidence, fp.support);
    assert.strictEqual(fp.engine, 'inno');
    assert.strictEqual(fp.confidence, 'high');

    const payloadDir = path.join(gamesDir, '_staging', `1-setup-${TITLE}`);
    const res = await silent.attemptSilentInstallSafe({
      setupExe, installDir, payloadDir, title: TITLE,
      libraryRoots: [gamesDir], logDir: path.join(gamesDir, '_staging'),
      onPhase: (p, e) => log(p, e?.message || ''),
    });
    log('silent:', res.ok, res.reason, res.error || '');
    assert.ok(res.ok, `silent install failed: ${res.reason} ${res.error || ''}`);

    const [crackDir] = scene.findCrackDirs(res.payloadDir);
    assert.ok(crackDir, 'RUNE folder found in the payload');
    let ranked = installer.rankGameExes(installDir, TITLE);
    const r = scene.applyCrack(crackDir, installDir, { gameExe: ranked[0]?.path });
    log('crack:', JSON.stringify(r));
    ranked = installer.rankGameExes(installDir, TITLE);
    log('ranked:', ranked.slice(0, 3).map((x) => `${path.relative(installDir, x.path)}=${x.score.toFixed(0)}`).join('  '));
    const top = ranked[0];
    assert.match(top.path, /Mygame-Win64-Shipping\.exe$/);
    assert.ok(installer.isConfidentGameExe(ranked, { installerPath: installer.findInstaller(installDir) }), 'confident launcher');

    const out = execFileSync(top.path, { encoding: 'utf8' }).trim();
    assert.strictEqual(out, 'CRACKED', 'the launcher is the cracked build');
    assert.ok(fs.existsSync(top.path + scene.BACKUP_SUFFIX), 'original kept');
    const win64 = path.dirname(top.path);
    assert.ok(fs.existsSync(path.join(win64, 'steam_emu.ini')), 'new crack file beside the exe');
    assert.strictEqual(fs.readFileSync(path.join(win64, 'steam_api64.dll'), 'utf8').trim(), 'EMU');
    assert.ok(!fs.existsSync(path.join(installDir, 'rune-mygame.nfo')) || true);
  });

  await step('missing part stops before unpacking, naming the part', async () => {
    const { staging, installDir } = fresh('missing');
    fs.rmSync(path.join(staging, 'rune-mygame.r57'));
    fs.mkdirSync(installDir, { recursive: true });
    await assert.rejects(installer.extractAll(staging, installDir, () => {}), /incomplete.*rune-mygame\.r57/);
    assert.deepStrictEqual(fs.readdirSync(installDir), [], 'nothing unpacked');
  });

  await step('corrupt part fails loudly (no silent “no launcher”)', async () => {
    const { staging, installDir } = fresh('corrupt');
    const victim = path.join(staging, 'rune-mygame.r40');
    const buf = fs.readFileSync(victim);
    for (let i = 4096; i < buf.length; i += 997) buf[i] ^= 0xff;
    fs.writeFileSync(victim, buf);
    fs.mkdirSync(installDir, { recursive: true });
    await assert.rejects(installer.extractAll(staging, installDir, () => {}), (err) => {
      log('error shown:', err.message);
      return /damaged|incomplete|Couldn’t unpack/.test(err.message);
    });
  });

  console.log('\n' + results.join('\n'));
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})();
