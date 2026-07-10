// Per-game install/download job control: pause, resume, cancel.
// Pause aborts the current transfer/extract but keeps staging partials so
// resume can continue (HTTP Range / local copy offset / re-extract).
// Cancel aborts and wipes staging (and any work dirs registered on the job).

function abortError(reason = 'cancelled') {
  const err = new Error(reason === 'paused' ? 'Paused' : 'Cancelled');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  err.reason = reason;
  return err;
}

function isAbortError(err) {
  return !!(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.message === 'This operation was aborted'));
}

function isPausedError(err) {
  return isAbortError(err) && (err.reason === 'paused' || err.message === 'Paused');
}

function isCancelledError(err) {
  return isAbortError(err) && !isPausedError(err);
}

class Job {
  constructor(gameId, kind, args) {
    this.gameId = gameId;
    this.kind = kind; // 'install' | 'dlc' | 'update'
    this.args = args;
    this.state = 'running'; // running | paused | cancelled
    this.controller = new AbortController();
    this.pct = 0;
    this.message = '';
    this.phase = 'downloading';
    this.stagingDirs = []; // wiped on cancel
    this.workDirs = []; // wiped on pause+cancel (partial extract)
  }

  get signal() {
    return this.controller.signal;
  }

  trackStaging(...dirs) {
    for (const d of dirs) {
      if (d && !this.stagingDirs.includes(d)) this.stagingDirs.push(d);
    }
  }

  trackWork(...dirs) {
    for (const d of dirs) {
      if (d && !this.workDirs.includes(d)) this.workDirs.push(d);
    }
  }

  throwIfAborted() {
    if (this.state === 'paused') throw abortError('paused');
    if (this.state === 'cancelled' || this.controller.signal.aborted) throw abortError('cancelled');
  }

  pause() {
    if (this.state !== 'running') return { ok: false, error: 'Not running' };
    this.state = 'paused';
    try {
      this.controller.abort('paused');
    } catch { /* already aborted */ }
    return { ok: true };
  }

  // Fresh AbortController for the next run after a pause.
  prepareResume() {
    if (this.state !== 'paused') return { ok: false, error: 'Not paused' };
    this.state = 'running';
    this.controller = new AbortController();
    return { ok: true };
  }

  cancel() {
    if (this.state === 'cancelled') return { ok: true };
    const wasPaused = this.state === 'paused';
    this.state = 'cancelled';
    try {
      this.controller.abort('cancelled');
    } catch { /* */ }
    return { ok: true, wasPaused };
  }

  wipeWorkDirs() {
    const fs = require('node:fs');
    for (const d of this.workDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    this.workDirs = [];
  }

  wipeStaging() {
    const fs = require('node:fs');
    this.wipeWorkDirs();
    for (const d of this.stagingDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    this.stagingDirs = [];
  }
}

// Active jobs keyed by logical gameId (canonical).
const jobs = new Map();

function getJob(gameId) {
  return jobs.get(gameId) || null;
}

function beginJob(gameId, kind, args) {
  const existing = jobs.get(gameId);
  if (existing && existing.state === 'running') {
    throw new Error('Already busy with this game.');
  }
  // Replacing a paused job (e.g. user clicked Install again) — cancel the old one.
  if (existing) {
    existing.cancel();
    existing.wipeStaging();
    jobs.delete(gameId);
  }
  const job = new Job(gameId, kind, args);
  jobs.set(gameId, job);
  return job;
}

function endJob(gameId, { keepIfPaused = true } = {}) {
  const job = jobs.get(gameId);
  if (!job) return;
  if (keepIfPaused && job.state === 'paused') return;
  jobs.delete(gameId);
}

module.exports = {
  Job,
  jobs,
  getJob,
  beginJob,
  endJob,
  abortError,
  isAbortError,
  isPausedError,
  isCancelledError,
};
