// Windows game-process adoption helpers (pure bits + script shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const win = require('../../client/lib/winGameProcess.js');

test('processExists: invalid pid is false', () => {
  assert.equal(win.processExists(0), false);
  assert.equal(win.processExists(-1), false);
  assert.equal(win.processExists(null), false);
});

test('processExists: this process is alive', () => {
  assert.equal(win.processExists(process.pid), true);
});

test('watchGamePid: cancel does not fire onExit', async () => {
  let exited = false;
  const w = win.watchGamePid(process.pid, {
    started: Date.now(),
    pollMs: 50,
    onExit: () => { exited = true; },
  });
  w.cancel();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(exited, false);
});

test('winGameProcess module ships launchUnelevated explorer hand-off', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), '../../client/lib/winGameProcess.js'),
    'utf8'
  );
  assert.match(src, /explorer\.exe/);
  assert.match(src, /Run as administrator/);
  assert.match(src, /waitForNewPid/);
});
