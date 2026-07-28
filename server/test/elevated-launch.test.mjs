// Elevated game-launch helper (Scheduled Task) — shape + elevation detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const elev = require('../../client/lib/elevatedLaunch.js');

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')),
  '../..'
);

test('looksLikeElevationFailure matches common spawn errors', () => {
  assert.equal(elev.looksLikeElevationFailure('EACCES'), true);
  assert.equal(elev.looksLikeElevationFailure('elevation required'), true);
  assert.equal(elev.looksLikeElevationFailure('740'), true);
  assert.equal(elev.looksLikeElevationFailure('ENOENT'), false);
});

test('elevatedGameLauncher.ps1 ships and writes response pid', () => {
  const ps1 = fs.readFileSync(path.join(root, 'client/lib/elevatedGameLauncher.ps1'), 'utf8');
  assert.match(ps1, /BridgeDir/);
  assert.match(ps1, /Start-Process/);
  assert.match(ps1, /response\.json/);
  assert.match(ps1, /pid/);
});

test('elevatedLaunch module registers GamehubElevatedLaunch task', () => {
  const src = fs.readFileSync(path.join(root, 'client/lib/elevatedLaunch.js'), 'utf8');
  assert.equal(elev.TASK_NAME, 'GamehubElevatedLaunch');
  assert.match(src, /RunLevel Highest/);
  assert.match(src, /schtasks/);
  assert.match(src, /Register-ScheduledTask/);
});

test('status reports unsupported off Windows', () => {
  if (process.platform === 'win32') {
    const st = elev.status();
    assert.equal(st.supported, true);
    assert.equal(typeof st.registered, 'boolean');
  } else {
    assert.equal(elev.status().supported, false);
    assert.equal(elev.isRegistered(), false);
  }
});
