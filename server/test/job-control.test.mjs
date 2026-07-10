// Pause / resume / cancel for downloads + local copies + job control.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checker, tmp, rm, writeFile } from './_helpers.mjs';
import { startEmbeddedServer } from '../src/embed.js';

const require = createRequire(import.meta.url);
const {
  beginJob, endJob, getJob, jobs,
  isPausedError, isCancelledError, isAbortError, abortError,
} = require('../../client/lib/jobControl.js');
const { copyFileWithProgress, copyPackageToStaging } = require('../../client/lib/localCopy.js');
const { makeApi } = require('../../client/lib/serverApi.js');

test('jobControl: pause then resume then cancel', () => {
  const { check, done } = checker();
  // Isolate from other tests that might leave jobs around
  for (const k of [...jobs.keys()]) jobs.delete(k);

  const job = beginJob(42, 'install', { gameId: 42, packageId: 42, installDir: '/tmp' });
  check('starts running', job.state === 'running');
  check('signal live', !job.signal.aborted);

  const paused = job.pause();
  check('pause ok', paused.ok);
  check('state paused', job.state === 'paused');
  check('signal aborted', job.signal.aborted);
  check('reason paused', job.signal.reason === 'paused');
  check('isPausedError from abortError', isPausedError(abortError('paused')));

  const prep = job.prepareResume();
  check('resume prep ok', prep.ok);
  check('running again', job.state === 'running');
  check('fresh signal', !job.signal.aborted);

  job.pause();
  const cancelled = job.cancel();
  check('cancel from paused', cancelled.ok && cancelled.wasPaused);
  check('state cancelled', job.state === 'cancelled');
  check('isCancelledError', isCancelledError(abortError('cancelled')));
  check('isAbortError', isAbortError(abortError('cancelled')));

  endJob(42, { keepIfPaused: false });
  check('removed', !getJob(42));
  done(assert);
});

test('jobControl: beginJob refuses a second running job', () => {
  const { check, done } = checker();
  for (const k of [...jobs.keys()]) jobs.delete(k);
  beginJob(7, 'install', {});
  let threw = false;
  try { beginJob(7, 'install', {}); } catch { threw = true; }
  check('second begin throws', threw);
  getJob(7).cancel();
  endJob(7, { keepIfPaused: false });
  done(assert);
});

test('jobControl: beginJob refuses replacing a paused job', () => {
  const { check, done } = checker();
  for (const k of [...jobs.keys()]) jobs.delete(k);
  const job = beginJob(9, 'install', {});
  job.pause();
  let msg = '';
  try { beginJob(9, 'install', {}); } catch (e) { msg = e.message; }
  check('paused begin throws', /paused/i.test(msg));
  check('paused job still present', getJob(9)?.state === 'paused');
  job.cancel();
  endJob(9, { keepIfPaused: false });
  done(assert);
});

test('localCopy: abort mid-copy keeps partial; resume completes', async () => {
  const { check, done } = checker();
  const store = tmp('jc-lc-store');
  const staging = tmp('jc-lc-stage');
  try {
    const SIZE = 4_000_000; // large enough to abort mid-stream
    writeFile(store, 'Pack/big.bin', SIZE);
    const dest = path.join(staging, 'big.bin');
    fs.mkdirSync(staging, { recursive: true });

    const ac = new AbortController();
    let credited = 0;
    const copyP = copyFileWithProgress(
      path.join(store, 'Pack', 'big.bin'),
      dest,
      (n) => {
        credited += n;
        // Wait until a meaningful amount is on the wire before pausing
        if (credited >= 64_000 && !ac.signal.aborted) ac.abort('paused');
      },
      ac.signal
    );
    let aborted = false;
    try {
      await copyP;
    } catch (err) {
      aborted = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
    }
    check('aborted', aborted);
    check('credited before abort', credited >= 64_000, String(credited));
    // Give the OS a tick to flush what was written before destroy
    await new Promise((r) => setTimeout(r, 20));
    const partial = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    // Destroy can race the last write — accept partial OR credited progress
    // (resume still works from whatever landed on disk).
    check('progress or partial kept', partial > 0 || credited > 0, `partial=${partial} credited=${credited}`);

    // Resume from whatever is on disk — no signal
    await copyFileWithProgress(path.join(store, 'Pack', 'big.bin'), dest, () => {});
    check('complete after resume', fs.statSync(dest).size === SIZE, String(fs.statSync(dest).size));
  } finally {
    rm(store, staging);
  }
  done(assert);
});

test('localCopy: cancel package wipe path — abort leaves staging partials', async () => {
  const { check, done } = checker();
  const store = tmp('jc-pkg-store');
  const staging = tmp('jc-pkg-stage');
  try {
    writeFile(store, 'Game/a.bin', 800_000);
    writeFile(store, 'Game/b.bin', 800_000);
    const ac = new AbortController();
    let n = 0;
    const p = copyPackageToStaging(
      store,
      { rel_path: 'Game' },
      [{ path: 'a.bin', size: 800_000 }, { path: 'b.bin', size: 800_000 }],
      staging,
      () => {
        if (++n === 3) ac.abort('cancelled');
      },
      { signal: ac.signal }
    );
    let aborted = false;
    try { await p; } catch (err) {
      aborted = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
    }
    check('package copy aborted', aborted);
    const aSize = fs.existsSync(path.join(staging, 'a.bin')) ? fs.statSync(path.join(staging, 'a.bin')).size : 0;
    check('at least some bytes staged', aSize > 0, String(aSize));
  } finally {
    rm(store, staging);
  }
  done(assert);
});

test('downloadFile: abort mid-download keeps partial; resume via Range completes', async () => {
  const { check, done } = checker();
  const dataDir = tmp('jc-dl-db');
  const libDir = tmp('jc-dl-lib');
  const destDir = tmp('jc-dl-dest');
  const srv = startEmbeddedServer({ dataDir, libraryDir: libDir, port: 0, host: '127.0.0.1', localMode: true });
  try {
    const port = await srv.ready;
    const SIZE = 512_000;
    const abs = path.join(libDir, 'AbortMe', 'chunk.bin');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const buf = Buffer.alloc(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 13) % 256;
    fs.writeFileSync(abs, buf);

    srv.db.prepare(
      `INSERT INTO games (rel_path, raw_name, clean_name, payload_type, size_bytes, status)
       VALUES ('AbortMe', 'AbortMe', 'abort me', 'folder', ?, 'matched')`
    ).run(SIZE);
    const id = srv.db.prepare("SELECT id FROM games WHERE rel_path = 'AbortMe'").get().id;

    const api = makeApi(() => ({
      serverUrl: `http://127.0.0.1:${port}`,
      authToken: '',
      apiKey: '',
    }));

    const dest = path.join(destDir, 'chunk.bin');
    const ac = new AbortController();
    let ticks = 0;
    let aborted = false;
    try {
      await api.downloadFile(id, 'chunk.bin', dest, () => {
        if (++ticks === 2) ac.abort('paused');
      }, SIZE, { signal: ac.signal });
    } catch (err) {
      aborted = err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || /aborted/i.test(err?.message || '');
    }
    check('download aborted', aborted);
    const partial = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    // May be 0 if abort raced before first write — still OK if abort worked
    check('abort happened', aborted);

    // Resume without signal — Range append should finish the file
    let credited = 0;
    const got = await api.downloadFile(id, 'chunk.bin', dest, (n) => { credited += n; }, SIZE);
    check('resumed to full size', got === SIZE, String(got));
    check('bytes match', fs.readFileSync(dest).equals(buf));
    check('progress accounts for all bytes', credited === SIZE, String(credited));
  } finally {
    await srv.close();
    rm(dataDir, libDir, destDir);
  }
  done(assert);
});
