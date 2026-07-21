// Talks to the Gamehub server. All HTTP happens in the main process.
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

/** Default timeout for JSON API calls (not downloads). */
const JSON_TIMEOUT_MS = 30_000;
/** Rescan used to block on a full FS walk — keep a generous ceiling anyway. */
const RESCAN_TIMEOUT_MS = 45_000;

function makeApi(getConfig, {
  jsonTimeoutMs = JSON_TIMEOUT_MS,
  rescanTimeoutMs = RESCAN_TIMEOUT_MS,
} = {}) {
  function headers() {
    const { apiKey, authToken } = getConfig();
    const h = {};
    if (authToken) h['X-Auth-Token'] = authToken;
    if (apiKey) h['X-Api-Key'] = apiKey;
    return h;
  }
  function base() {
    return getConfig().serverUrl.replace(/\/+$/, '');
  }

  async function fetchJson(url, opts = {}, timeoutMs = jsonTimeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // If the caller already passed a signal, abort with it too.
    const onCallerAbort = () => ctrl.abort();
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      return res;
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        const e = new Error(`request timed out after ${timeoutMs}ms`);
        e.code = 'ETIMEDOUT';
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onCallerAbort);
    }
  }

  async function login(username, password) {
    // brand-new server with no accounts yet? the first sign-in CREATES the
    // admin account — install, type credentials, done.
    let endpoint = 'login';
    try {
      const st = await authStatus();
      if (st.setupRequired) endpoint = 'setup';
    } catch { /* fall through to login */ }
    const res = await fetchJson(`${base()}/api/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${endpoint} failed (${res.status})`);
    return { ...data, created: endpoint === 'setup' }; // { token, user, created }
  }

  async function authStatus() {
    const res = await fetchJson(`${base()}/api/auth/status`);
    if (!res.ok) throw new Error(`server unreachable (${res.status})`);
    return res.json(); // { setupRequired, authRequired }
  }

  async function getJson(p, timeoutMs = jsonTimeoutMs) {
    const res = await fetchJson(`${base()}${p}`, { headers: headers() }, timeoutMs);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async function postJson(p, payload, timeoutMs = jsonTimeoutMs) {
    const res = await fetchJson(`${base()}${p}`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }, timeoutMs);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  // Stream a response body to destPath. onProgress gets each new chunk length.
  // startBytes is already on disk (for progress accounting on resume).
  // signal aborts the pipeline mid-flight (pause/cancel) — partial file is kept.
  async function writeBody(res, destPath, flags, startBytes, onProgress, signal) {
    let done = startBytes;
    const counter = new (require('node:stream').Transform)({
      transform(chunk, enc, cb) {
        done += chunk.length;
        onProgress?.(chunk.length);
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body),
      counter,
      fs.createWriteStream(destPath, { flags }),
      { signal }
    );
    return done;
  }

  // Download one library file. Resumes when destPath already has a partial
  // copy (Range + append). Returns total bytes now on disk for that file.
  // onProgress is called with byte deltas (including a one-shot credit for
  // bytes already present when resuming / skipping a complete file).
  // opts.signal — AbortSignal for pause/cancel (partials kept on disk).
  async function downloadFile(gameId, relPath, destPath, onProgress, expectedSize, opts = {}) {
    const signal = opts.signal;
    if (signal?.aborted) {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      err.reason = signal.reason;
      throw err;
    }
    const q = relPath ? `?path=${encodeURIComponent(relPath)}` : '';
    const url = `${base()}/api/games/${gameId}/download${q}`;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    let existing = 0;
    try {
      existing = fs.statSync(destPath).size;
    } catch { /* no partial yet */ }

    // Partial larger than the server file is corrupt — start over.
    if (existing > 0 && expectedSize != null && existing > expectedSize) {
      fs.rmSync(destPath, { force: true });
      existing = 0;
    }
    // Already complete — credit progress and skip the network round-trip.
    if (existing > 0 && expectedSize != null && existing === expectedSize) {
      onProgress?.(existing);
      return existing;
    }

    const reqHeaders = { ...headers() };
    if (existing > 0) reqHeaders.Range = `bytes=${existing}-`;

    let res = await fetch(url, { headers: reqHeaders, signal });

    // Stale partial (Range not satisfiable) — wipe and fetch the full file.
    if (res.status === 416) {
      if (expectedSize != null && existing === expectedSize) {
        onProgress?.(existing);
        return existing;
      }
      fs.rmSync(destPath, { force: true });
      existing = 0;
      res = await fetch(url, { headers: { ...headers() }, signal });
    }

    if (res.status === 200) {
      // Full body — discard any partial and rewrite from byte 0.
      if (existing > 0) {
        fs.rmSync(destPath, { force: true });
        existing = 0;
      }
      return writeBody(res, destPath, 'w', 0, onProgress, signal);
    }

    if (res.status === 206) {
      if (existing > 0) onProgress?.(existing);
      return writeBody(res, destPath, 'a', existing, onProgress, signal);
    }

    throw new Error(`download failed (${res.status}) for ${relPath || 'file'}`);
  }

  async function logout() {
    await fetch(`${base()}/api/auth/logout`, { method: 'POST', headers: headers() });
  }

  return {
    logout,
    status: () => getJson('/api/status'),
    library: () => getJson('/api/games?status=matched'),
    game: (id) => getJson(`/api/games/${id}`),
    files: (id) => getJson(`/api/games/${id}/files`),
    dlc: (id) => getJson(`/api/games/${id}/dlc`),
    downloadFile,
    login,
    authStatus,
    reportPlaytime: (gameId, seconds) => postJson('/api/playtime', { gameId, seconds }).catch(() => {}),
    setStatus: (gameId) => postJson('/api/me/status', { gameId }).catch(() => {}),
    myStats: () => getJson('/api/me/stats'),
    userStats: (id) => getJson(`/api/users/${id}/stats`),
    leaderboard: () => getJson('/api/social/leaderboard'),
    setAvatar: (avatar) => postJson('/api/me/avatar', { avatar }),
    // Admin/local: kick a library scan. Guests get 403 — swallow so Refresh still
    // reloads the matched list. Timeout so a hung server never greys the button forever.
    rescan: () => postJson('/api/rescan', {}, rescanTimeoutMs).catch(() => ({})),
  };
}

module.exports = { makeApi, JSON_TIMEOUT_MS, RESCAN_TIMEOUT_MS };