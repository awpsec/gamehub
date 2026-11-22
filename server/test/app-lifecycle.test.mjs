// Client update plumbing: the rotating updater log and the installer's
// "please quit" request (see client/build/installer.nsh).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const life = require('../../client/lib/appLifecycle.js');

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gh-life-'));

test('updater log appends timestamped lines and formats errors', () => {
  const dir = path.join(mkdir(), 'logs'); // created on first write
  const log = life.makeLogger(dir, 'updater.log', { now: () => new Date('2026-01-02T03:04:05Z') });
  log.write('info', 'hello', { v: 1 });
  log.write('error', new Error('boom'));
  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /^2026-01-02T03:04:05\.000Z \[info\] hello \{"v":1\}\n/);
  assert.match(text, /\[error\] Error: boom/);
});

test('updater log rotates past maxBytes and keeps one old copy', () => {
  const dir = mkdir();
  const log = life.makeLogger(dir, 'u.log', { maxBytes: 50 });
  for (let i = 0; i < 6; i++) log.write('info', `line ${i} ${'x'.repeat(20)}`);
  assert.ok(fs.existsSync(`${log.file}.1`));
  assert.ok(fs.statSync(log.file).size <= 50 + 80);
  assert.match(fs.readFileSync(log.file, 'utf8'), /line 5/);
});

test('updater log never throws on an unwritable dir', () => {
  const file = path.join(mkdir(), 'not-a-dir');
  fs.writeFileSync(file, '');
  const log = life.makeLogger(path.join(file, 'logs'));
  assert.doesNotThrow(() => log.write('info', 'x'));
});

function fakeTimers() {
  const t = { fn: null, cleared: false };
  return {
    t,
    _setInterval: (fn) => { t.fn = fn; return { unref() {} }; },
    _clearInterval: () => { t.cleared = true; },
  };
}

test('quit request: stale file is cleared on start, a new one fires once and is removed', () => {
  const dir = mkdir();
  const file = path.join(dir, life.QUIT_REQUEST_FILE);
  fs.writeFileSync(file, '1'); // left over from an earlier run
  const ft = fakeTimers();
  let calls = 0;
  const stop = life.watchQuitRequest(dir, () => { calls++; }, ft);
  assert.ok(!fs.existsSync(file), 'stale request removed at start');
  ft.t.fn();
  assert.strictEqual(calls, 0);
  fs.writeFileSync(file, '1'); // installer asks
  ft.t.fn();
  assert.strictEqual(calls, 1);
  assert.ok(!fs.existsSync(file), 'request consumed');
  fs.writeFileSync(file, '1');
  ft.t.fn();
  assert.strictEqual(calls, 1, 'fires only once');
  stop();
  assert.ok(ft.t.cleared);
});

test('quit request: a throwing handler does not escape the timer', () => {
  const dir = mkdir();
  const ft = fakeTimers();
  life.watchQuitRequest(dir, () => { throw new Error('x'); }, ft);
  fs.writeFileSync(path.join(dir, life.QUIT_REQUEST_FILE), '1');
  assert.doesNotThrow(() => ft.t.fn());
});

test('installer.nsh writes the same file name Gamehub watches', () => {
  const nsh = fs.readFileSync(new URL('../../client/build/installer.nsh', import.meta.url), 'utf8');
  assert.ok(nsh.includes(`$APPDATA\\Gamehub\\${life.QUIT_REQUEST_FILE}`));
  assert.match(nsh, /!macro customCheckAppRunning[\s\S]*_CHECK_APP_RUNNING[\s\S]*!macroend/);
  // the stock check needs these when a custom macro is defined
  assert.match(nsh, /!include "getProcessInfo\.nsh"/);
  assert.match(nsh, /^Var pid$/m);
});

test('main process takes the single-instance lock and releases it before relaunching', () => {
  const main = fs.readFileSync(new URL('../../client/main.js', import.meta.url), 'utf8');
  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /app\.on\('second-instance'/);
  // every relaunch path hands the lock to the new copy first
  for (const fn of ['restartElevatedApp', 'restartUnelevatedApp']) {
    const re = new RegExp(`releaseInstanceLock\\(\\);\\s*const r = elevatedLaunch\\.${fn}\\(\\)`, 'g');
    assert.ok((main.match(re) || []).length >= 1, fn);
  }
  assert.strictEqual((main.match(/releaseInstanceLock\(\);\s*const r = elevatedLaunch\.restartElevatedApp\(\)/g) || []).length, 2);
});
