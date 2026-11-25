#!/usr/bin/env node
// Emulator downloads, for real (CI, open internet): for each emulator Gamehub
// offers, find the newest OFFICIAL build, download + unpack it exactly as
// "Set up emulator → Download" does, make it portable, and start it once to
// prove it's a working program. Catches a project moving its downloads.
//
//   node test-e2e/emulators.e2e.js <workDir> [eden ryujinx dolphin]
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');

const lib = path.join(__dirname, '..', 'lib');
const emulators = require(path.join(lib, 'emulators'));
const installer = require(path.join(lib, 'installer'));

const [work, ...only] = process.argv.slice(2);
const ids = only.length ? only : Object.keys(emulators.EMULATORS);
const log = (...a) => console.log('  ·', ...a);

function isRunning(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

(async () => {
  const results = [];
  for (const id of ids) {
    const t0 = Date.now();
    try {
      const rel = await emulators.resolveLatest(id);
      log(id, 'latest:', rel.version, rel.name, '←', rel.source);
      const got = await emulators.installEmulator(id, {
        root: path.join(work, 'emulators'),
        extract: (a, d) => installer.extractFile(a, d),
        onProgress: (p) => { if (p.phase !== 'downloading' || p.pct % 25 === 0) log(id, p.phase, p.pct ?? '', p.message || ''); },
      });
      log(id, 'installed:', got.exe);
      assert.ok(fs.existsSync(got.exe), 'program exists');
      const portable = emulators.EMULATORS[id].portable;
      assert.ok(fs.existsSync(path.join(path.dirname(got.exe), portable.dir || portable.file)), 'portable marker');
      log(id, 'needs:', JSON.stringify(emulators.missingRequirements(id, got.exe)));

      // start it (no game) for a few seconds: a real, runnable program
      const child = spawn(got.exe, [], { cwd: path.dirname(got.exe), detached: true, stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 8000));
      const alive = isRunning(child.pid);
      log(id, 'started, still running after 8 s:', alive, 'exit:', child.exitCode);
      try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch { /* */ }
      assert.ok(alive || child.exitCode === 0, `${id} exited immediately (code ${child.exitCode})`);
      results.push(`ok   ${id} ${got.version} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      results.push(`FAIL ${id}: ${err.message}`);
      if (id === 'ryujinx') {
        try {
          const r = await fetch('https://git.ryujinx.app/api/v4/projects?search=ryujinx&simple=true&per_page=20', { headers: { 'User-Agent': 'Gamehub' } });
          log('git.ryujinx.app projects:', r.status, (await r.json()).map((p) => p.path_with_namespace).join(', '));
        } catch (e) { log('git.ryujinx.app probe failed:', e.message); }
      }
    }
  }
  console.log('\n' + results.join('\n'));
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})();
