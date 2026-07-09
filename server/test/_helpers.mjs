// Shared helpers for the Gamehub test suite (node:test, zero deps).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let seq = 0;
// A unique, freshly-created temp dir under the OS temp root (isolated per test).
export function tmp(name) {
  const d = path.join(os.tmpdir(), `gamehub-test-${process.pid}-${seq++}-${name}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Best-effort recursive delete — a just-closed SQLite WAL can briefly hold a
// Windows lock, which is harmless for a temp dir.
export function rm(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* WAL lock — harmless */ }
  }
}

// Collect labelled failures, then assert them all at once so a single test
// reports every failing check (not just the first).
export function checker() {
  const msgs = [];
  const check = (label, cond, extra = '') => {
    if (!cond) msgs.push(`  ✗ ${label}${extra ? `  <<< ${extra}` : ''}`);
  };
  const done = (assert) => assert.ok(msgs.length === 0, msgs.length ? `\n${msgs.join('\n')}` : '');
  return { check, done };
}

// Write a zero-filled file of `bytes` at base/rel (creates parent dirs).
export function writeFile(base, rel, bytes) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
}
