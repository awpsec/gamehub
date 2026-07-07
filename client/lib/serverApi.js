// Talks to the Gamehub server. All HTTP happens in the main process.
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function makeApi(getConfig) {
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

  async function login(username, password) {
    // brand-new server with no accounts yet? the first sign-in CREATES the
    // admin account — install, type credentials, done.
    let endpoint = 'login';
    try {
      const st = await authStatus();
      if (st.setupRequired) endpoint = 'setup';
    } catch { /* fall through to login */ }
    const res = await fetch(`${base()}/api/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${endpoint} failed (${res.status})`);
    return { ...data, created: endpoint === 'setup' }; // { token, user, created }
  }

  async function authStatus() {
    const res = await fetch(`${base()}/api/auth/status`);
    if (!res.ok) throw new Error(`server unreachable (${res.status})`);
    return res.json(); // { setupRequired, authRequired }
  }

  async function getJson(p) {
    const res = await fetch(`${base()}${p}`, { headers: headers() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async function postJson(p, payload) {
    const res = await fetch(`${base()}${p}`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async function downloadFile(gameId, relPath, destPath, onProgress) {
    const q = relPath ? `?path=${encodeURIComponent(relPath)}` : '';
    const res = await fetch(`${base()}/api/games/${gameId}/download${q}`, { headers: headers() });
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${relPath || 'file'}`);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    let done = 0;
    const counter = new (require('node:stream').Transform)({
      transform(chunk, enc, cb) {
        done += chunk.length;
        onProgress?.(chunk.length);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath));
    return done;
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
    downloadFile,
    login,
    authStatus,
    reportPlaytime: (gameId, seconds) => postJson('/api/playtime', { gameId, seconds }).catch(() => {}),
    setStatus: (gameId) => postJson('/api/me/status', { gameId }).catch(() => {}),
    myStats: () => getJson('/api/me/stats'),
    userStats: (id) => getJson(`/api/users/${id}/stats`),
    leaderboard: () => getJson('/api/social/leaderboard'),
    setAvatar: (avatar) => postJson('/api/me/avatar', { avatar }),
    rescan: () => postJson('/api/rescan').catch(() => ({})), // best-effort: local/admin scans, guests just reload
  };
}

module.exports = { makeApi };
