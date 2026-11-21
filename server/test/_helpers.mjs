// Shared helpers for the Gamehub test suite (node:test, zero deps).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// A unique, freshly-created temp dir under the OS temp root (isolated per test).
export function tmp(name) {
  const id = randomBytes(6).toString('hex');
  const d = path.join(os.tmpdir(), `gamehub-test-${process.pid}-${id}-${name}`);
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

// Write a sparse-ish file of `bytes` at base/rel (creates parent dirs).
// Avoids Buffer.alloc(huge) which OOMs when tests run in parallel.
export function writeFile(base, rel, bytes) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const n = Math.max(0, Math.floor(Number(bytes) || 0));
  if (n <= 64 * 1024) {
    fs.writeFileSync(p, Buffer.alloc(n));
    return;
  }
  const fd = fs.openSync(p, 'w');
  try {
    fs.writeSync(fd, Buffer.alloc(1), 0, 1, 0);
    fs.ftruncateSync(fd, n);
  } finally {
    fs.closeSync(fd);
  }
}
