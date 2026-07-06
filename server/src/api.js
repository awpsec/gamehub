import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchAllProviders, scoreCandidate, enrichCandidate } from './matcher.js';
import { streamZip, zipSize } from './zipstream.js';
import { saveSettings } from './settings.js';
import { listEvents, clearEvents, deleteEvent, clearGameEvents, errorCount, logEvent } from './events.js';
import {
  countUsers, createUser, authenticate, createToken, getUserByToken,
  deleteToken, listUsers, setPassword, deleteUser, verifyPassword,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function listFilesRecursive(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (st.isFile()) {
      out.push({ path: rel.split(path.sep).join('/'), size: st.size });
      continue;
    }
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.toLowerCase().endsWith('.!qb')) continue;
      stack.push(rel ? path.join(rel, e.name) : e.name);
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function createApi({ config, db, getSettings, getProviders, triggerScan }) {
  const app = express();
  app.use(express.json({ limit: '512kb' })); // headroom for small avatar data URLs

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, X-Auth-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ---------- authentication ----------
  // Guests can BROWSE (status + game listings/detail) with no account. Signing
  // in is only required to DOWNLOAD or to change anything — so we can track who
  // has what. A session token (X-Auth-Token header or ?token= on download
  // links) or the Settings API key identifies the user; both are optional here.
  const AUTH_EXEMPT = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/setup', '/api/auth/me']);

  // GET routes a guest may read without signing in (NOT downloads/files/search)
  function guestReadable(req) {
    if (req.method !== 'GET') return false;
    if (req.path === '/api/status' || req.path === '/api/games') return true;
    if (/^\/api\/games\/\d+$/.test(req.path)) return true; // game detail + candidates
    return false;
  }

  // resolve a token/api-key into req.user (or leave undefined = guest)
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next(); // static UI
    const token = req.headers['x-auth-token'] || req.query.token;
    if (token) {
      const user = getUserByToken(db, token);
      if (user) req.user = user;
    }
    if (!req.user) {
      const { apiKey } = getSettings();
      const provided = req.headers['x-api-key'] || req.query.apikey;
      if (apiKey && provided === apiKey) req.user = { id: 0, username: 'api-key', role: 'admin' };
    }
    next();
  });

  // gate: signed-in required for everything except auth endpoints, setup mode,
  // and the guest-readable browse routes
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();
    if (AUTH_EXEMPT.has(req.path)) return next();
    if (countUsers(db) === 0) return next(); // first-run setup, no accounts yet
    if (req.user) return next();
    if (guestReadable(req)) return next(); // browse as guest
    res.status(401).json({ error: 'sign in required' });
  });

  const requireAdmin = (req, res, next) => {
    if (countUsers(db) === 0 || req.user?.role === 'admin') return next();
    res.status(403).json({ error: 'admin access required' });
  };

  app.use('/', express.static(path.join(__dirname, '..', 'public')));

  const gameById = db.prepare('SELECT * FROM games WHERE id = ?');

  // ---------- status ----------
  app.get('/api/status', (req, res) => {
    const counts = {};
    for (const row of db
      .prepare('SELECT status, COUNT(*) AS n FROM games GROUP BY status')
      .all()) {
      counts[row.status] = row.n;
    }
    const settings = getSettings();
    const library = { path: settings.libraryDir, ok: true, entries: 0 };
    try {
      library.entries = fs.readdirSync(settings.libraryDir).length;
    } catch (err) {
      library.ok = false;
      library.error = err.message;
    }
    res.json({
      app: 'gamehub-server',
      version: '0.3.0',
      library,
      providers: getProviders().map((p) => p.name),
      autoMatchThreshold: settings.autoMatchThreshold,
      counts,
      errorCount: errorCount(db),
    });
  });

  // ---------- games ----------
  app.get('/api/games', (req, res) => {
    const { status } = req.query;
    const rows = status
      ? db.prepare('SELECT * FROM games WHERE status = ? ORDER BY updated_at DESC').all(status)
      : db.prepare('SELECT * FROM games ORDER BY updated_at DESC').all();
    res.json(rows);
  });

  app.get('/api/games/:id', (req, res) => {
    const game = gameById.get(req.params.id);
    if (!game) return res.status(404).json({ error: 'not found' });
    const candidates = db
      .prepare('SELECT * FROM candidates WHERE game_id = ? ORDER BY score DESC')
      .all(game.id);
    res.json({ ...game, candidates });
  });

  app.get('/api/games/:id/files', (req, res) => {
    const game = gameById.get(req.params.id);
    if (!game) return res.status(404).json({ error: 'not found' });
    const base = path.join(getSettings().libraryDir, game.rel_path);
    try {
      res.json(listFilesRecursive(base));
    } catch (err) {
      logEvent(db, 'error', 'api', `Failed to enumerate files for “${game.rel_path}”`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/games/:id/download', (req, res) => {
    const game = gameById.get(req.params.id);
    if (!game) return res.status(404).json({ error: 'not found' });
    const base = path.resolve(getSettings().libraryDir, game.rel_path);
    let target = base;
    if (req.query.path) {
      target = path.resolve(base, String(req.query.path));
      if (target !== base && !target.startsWith(base + path.sep)) {
        return res.status(400).json({ error: 'invalid path' });
      }
    }
    let st;
    try {
      st = fs.statSync(target);
    } catch {
      return res.status(404).json({ error: 'file not found' });
    }
    if (!st.isFile()) return res.status(400).json({ error: 'not a file; use /files to enumerate' });
    res.download(target);
  });

  // the whole release as ONE download — streamed zip (store method, ZIP64).
  // Pure reads from the library: originals are never modified, no temp files.
  app.get('/api/games/:id/zip', async (req, res) => {
    const game = gameById.get(req.params.id);
    if (!game) return res.status(404).json({ error: 'not found' });
    const base = path.join(getSettings().libraryDir, game.rel_path);
    let files;
    try {
      const list = listFilesRecursive(base);
      const root = (game.meta_title || game.clean_name).replace(/[<>:"/\\|?*]/g, '').trim() || 'game';
      files = list.map((f) => ({
        name: `${root}/${f.path || path.basename(game.rel_path)}`,
        absPath: f.path ? path.join(base, ...f.path.split('/')) : base,
        size: f.size,
      }));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    const title = (game.meta_title || game.clean_name).replace(/[^\w .-]/g, '') || 'game';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${title}.zip"`);
    res.setHeader('Content-Length', String(zipSize(files)));
    try {
      await streamZip(res, files);
    } catch (err) {
      logEvent(db, 'error', 'api', `Zip download failed for “${game.rel_path}”`, err.message);
      res.destroy(); // mid-stream failure — length no longer matches
    }
  });

  app.get('/api/games/:id/search', requireAdmin, async (req, res) => {
    const game = gameById.get(req.params.id);
    if (!game) return res.status(404).json({ error: 'not found' });
    const q = String(req.query.q || game.clean_name);
    try {
      const results = await searchAllProviders(getProviders(), q, db);
      const scored = results
        .map((c) => ({ ...c, score: scoreCandidate(game.clean_name, game.hint_year, c) }))
        .sort((a, b) => b.score - a.score);
      res.json(scored);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/games/:id/match', requireAdmin, async (req, res) => {
    const game = gameById.get(req.params.id);
    if (!game) return res.status(404).json({ error: 'not found' });
    let c = req.body || {};
    if (!c.title) return res.status(400).json({ error: 'title required' });
    // pull year/summary/genres for sources that support it (e.g. Steam)
    if (c.provider && c.providerId) {
      c = await enrichCandidate(getProviders(), c);
    }
    db.prepare(
      `UPDATE games SET status = 'matched', confidence = 1.0,
         provider = @provider, provider_id = @providerId,
         meta_title = @title, meta_year = @year, meta_cover = @cover,
         meta_summary = @summary, meta_genres = @genres,
         meta_hero = @hero, meta_ratings = @ratings, meta_media = @media, meta_compat = @compat,
         updated_at = datetime('now')
       WHERE id = @id`
    ).run({
      id: game.id,
      provider: c.provider || 'manual',
      providerId: String(c.providerId || ''),
      title: c.title,
      year: c.year || null,
      cover: c.cover || null,
      summary: c.summary || null,
      genres: c.genres || null,
      hero: c.hero || null,
      ratings: c.ratings && Object.keys(c.ratings).length ? JSON.stringify(c.ratings) : null,
      media: c.media ? JSON.stringify(c.media) : null,
      compat: c.compat ? JSON.stringify(c.compat) : null,
    });
    clearGameEvents(db, game.id); // outstanding match warnings are now resolved
    logEvent(db, 'info', 'api', `Manually matched “${game.raw_name}” → “${c.title}”`);
    res.json({ ok: true });
  });

  // override artwork — for when the provider's asset is wrong/stale
  // (e.g. Steam renamed a game but never updated its portrait capsule)
  app.post('/api/games/:id/cover', requireAdmin, (req, res) => {
    const game = gameById.get(req.params.id);
    if (!game) return res.status(404).json({ error: 'not found' });
    const cover = String(req.body?.cover || '').trim();
    if (!/^https?:\/\//.test(cover) && !cover.startsWith('/')) {
      return res.status(400).json({ error: 'cover must be a URL' });
    }
    db.prepare("UPDATE games SET meta_cover = ?, updated_at = datetime('now') WHERE id = ?").run(cover, game.id);
    logEvent(db, 'info', 'api', `Cover overridden for “${game.meta_title || game.raw_name}”`);
    res.json({ ok: true });
  });

  app.post('/api/games/:id/ignore', requireAdmin, (req, res) => {
    const info = db
      .prepare("UPDATE games SET status = 'ignored', updated_at = datetime('now') WHERE id = ?")
      .run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'not found' });
    clearGameEvents(db, Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/games/:id/rematch', requireAdmin, (req, res) => {
    const info = db
      .prepare("UPDATE games SET status = 'new', updated_at = datetime('now') WHERE id = ?")
      .run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'not found' });
    triggerScan();
    res.json({ ok: true });
  });

  app.post('/api/rematch-all', requireAdmin, (req, res) => {
    const info = db
      .prepare(
        "UPDATE games SET status = 'new', updated_at = datetime('now') WHERE status IN ('unmatched', 'pending')"
      )
      .run();
    triggerScan();
    res.json({ ok: true, queued: info.changes });
  });

  app.post('/api/rescan', requireAdmin, (req, res) => {
    triggerScan();
    res.json({ ok: true, message: 'scan started' });
  });

  // ---------- auth ----------
  app.get('/api/auth/status', (req, res) => {
    const n = countUsers(db);
    res.json({ setupRequired: n === 0, authRequired: n > 0 });
  });

  app.post('/api/auth/setup', (req, res) => {
    if (countUsers(db) > 0) return res.status(400).json({ error: 'setup already completed' });
    try {
      const user = createUser(db, req.body?.username, req.body?.password, 'admin');
      const token = createToken(db, user.id);
      logEvent(db, 'info', 'api', `Admin account “${user.username}” created`);
      res.json({ token, user });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const user = authenticate(db, req.body?.username, req.body?.password);
    if (!user) {
      logEvent(db, 'warn', 'api', `Failed login for “${String(req.body?.username || '').trim() || '?'}”`);
      return res.status(401).json({ error: 'invalid username or password' });
    }
    res.json({ token: createToken(db, user.id), user });
  });

  app.post('/api/auth/logout', (req, res) => {
    deleteToken(db, req.headers['x-auth-token']);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    if (req.user) return res.json(req.user);
    if (countUsers(db) === 0) return res.json({ id: 0, username: null, role: 'admin', setupMode: true });
    res.json({ id: 0, username: null, role: 'guest' }); // browsing without an account
  });

  app.post('/api/auth/password', (req, res) => {
    if (!req.user || req.user.id === 0) return res.status(400).json({ error: 'no user session' });
    const row = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
    if (!row || !verifyPassword(String(req.body?.current || ''), row.password)) {
      return res.status(400).json({ error: 'current password is incorrect' });
    }
    try {
      setPassword(db, req.user.id, req.body?.next);
      const token = createToken(db, req.user.id); // old sessions were invalidated
      res.json({ ok: true, token });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---------- playtime / profiles / social ----------
  // report a finished play session → accumulate the per-user total + log a
  // session row (used for time-windowed leaderboards like "this week")
  const addPlaytime = db.prepare(`
    INSERT INTO playtime (user_id, game_id, seconds, last_played)
    VALUES (@u, @g, @s, datetime('now'))
    ON CONFLICT(user_id, game_id) DO UPDATE SET seconds = seconds + excluded.seconds, last_played = datetime('now')`);
  const addSession = db.prepare('INSERT INTO play_sessions (user_id, game_id, seconds) VALUES (@u, @g, @s)');
  // one session = one running-total bump + one windowed row, written atomically so
  // the weekly (play_sessions) and all-time (playtime) leaderboards can never diverge
  const recordSession = db.transaction((u, g, s) => {
    addPlaytime.run({ u, g, s });
    addSession.run({ u, g, s });
  });
  app.post('/api/playtime', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'sign in required' });
    const g = parseInt(req.body?.gameId, 10);
    const s = Math.max(0, Math.round(Number(req.body?.seconds) || 0));
    if (!g || s <= 0) return res.json({ ok: true }); // nothing worth recording
    recordSession(req.user.id, g, s);
    res.json({ ok: true });
  });

  // live "now playing" presence — in-memory, refreshed by the client while a game
  // runs and expiring on its own if the client goes away without a clean stop.
  const gameBrief = (id) => {
    const g = db.prepare('SELECT meta_title, clean_name, meta_cover FROM games WHERE id = ?').get(id);
    return g ? { id, title: g.meta_title || g.clean_name, cover: g.meta_cover } : null;
  };
  const presence = new Map(); // userId -> { gameId, at }
  const PRESENCE_TTL = 150000; // 2.5 min without a heartbeat → considered offline
  const currentlyPlaying = (userId) => {
    const p = presence.get(userId);
    if (!p || Date.now() - p.at > PRESENCE_TTL) return null;
    return gameBrief(p.gameId);
  };
  app.post('/api/me/status', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'sign in required' });
    const g = parseInt(req.body?.gameId, 10);
    if (g) presence.set(req.user.id, { gameId: g, at: Date.now() });
    else presence.delete(req.user.id);
    res.json({ ok: true });
  });

  // profile: every game a user has played, joined with its metadata. Shared by
  // "my stats" and any member's public stats.
  const statGames = db.prepare(`
    SELECT p.game_id AS id, p.seconds, p.last_played,
           g.meta_title, g.clean_name, g.meta_cover, g.meta_year
    FROM playtime p JOIN games g ON g.id = p.game_id
    WHERE p.user_id = ? AND p.seconds > 0
    ORDER BY p.seconds DESC`);
  const userStats = (userId) => {
    const u = db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(userId);
    if (!u) return null;
    const games = statGames.all(userId);
    return {
      id: u.id, username: u.username, avatar: u.avatar || null,
      playing: currentlyPlaying(u.id),
      totalSeconds: games.reduce((a, x) => a + x.seconds, 0), games,
    };
  };

  app.get('/api/me/stats', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'sign in required' });
    res.json({ ...userStats(req.user.id), me: true });
  });

  // any member's public stats (signed-in users can view each other's profiles)
  app.get('/api/users/:id/stats', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'sign in required' });
    const stats = userStats(Number(req.params.id));
    if (!stats) return res.status(404).json({ error: 'user not found' });
    res.json({ ...stats, me: stats.id === req.user.id });
  });

  // set / clear my profile picture (a small, client-downscaled data URL)
  app.post('/api/me/avatar', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'sign in required' });
    const avatar = req.body?.avatar;
    if (avatar === null || avatar === '') {
      db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(req.user.id);
      return res.json({ avatar: null });
    }
    if (typeof avatar !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
      return res.status(400).json({ error: 'avatar must be a PNG, JPEG, WebP or GIF image' });
    }
    if (avatar.length > 96 * 1024) return res.status(413).json({ error: 'image too large — please choose a smaller picture' });
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.user.id);
    res.json({ avatar });
  });

  // social: leaderboards of both players and games, weekly + all-time
  app.get('/api/social/leaderboard', (req, res) => {
    const users = db.prepare('SELECT id, username, avatar FROM users').all();
    const weeklyRows = db.prepare(
      `SELECT user_id, game_id, SUM(seconds) AS seconds FROM play_sessions
       WHERE ended_at >= datetime('now','-7 days') GROUP BY user_id, game_id`).all();
    const totalRows = db.prepare('SELECT user_id, game_id, seconds FROM playtime WHERE seconds > 0').all();
    const gCache = new Map();
    const gInfo = (id) => {
      if (!gCache.has(id)) {
        const g = db.prepare('SELECT meta_title, clean_name, meta_cover FROM games WHERE id = ?').get(id);
        gCache.set(id, g ? { id, title: g.meta_title || g.clean_name, cover: g.meta_cover } : { id, title: 'Unknown', cover: null });
      }
      return gCache.get(id);
    };
    // per-user totals + each user's single most-played game, for a window's rows
    const byUser = (rows) => {
      const by = {};
      for (const r of rows) {
        const u = by[r.user_id] || (by[r.user_id] = { total: 0, top: null });
        u.total += r.seconds;
        if (!u.top || r.seconds > u.top.seconds) u.top = { game: gInfo(r.game_id), seconds: r.seconds };
      }
      return by;
    };
    // per-game totals + distinct player count, ranked — "what's hot on the server"
    const byGame = (rows) => {
      const by = {};
      for (const r of rows) {
        const g = by[r.game_id] || (by[r.game_id] = { seconds: 0, players: new Set() });
        g.seconds += r.seconds;
        g.players.add(r.user_id);
      }
      return Object.entries(by)
        .map(([id, v]) => ({ ...gInfo(Number(id)), seconds: v.seconds, players: v.players.size }))
        .sort((a, b) => b.seconds - a.seconds);
    };
    const week = byUser(weeklyRows), all = byUser(totalRows);
    const list = users
      .map((u) => ({
        id: u.id, username: u.username, avatar: u.avatar || null,
        me: req.user ? u.id === req.user.id : false,
        playing: currentlyPlaying(u.id),
        week: week[u.id] || { total: 0, top: null },
        allTime: all[u.id] || { total: 0, top: null },
      }))
      .filter((u) => u.week.total > 0 || u.allTime.total > 0)
      .sort((a, b) => b.week.total - a.week.total || b.allTime.total - a.allTime.total);
    res.json({ users: list, games: { week: byGame(weeklyRows), allTime: byGame(totalRows) } });
  });

  // ---------- user management (admin) ----------
  app.get('/api/users', requireAdmin, (req, res) => {
    res.json(listUsers(db));
  });

  app.post('/api/users', requireAdmin, (req, res) => {
    try {
      const user = createUser(db, req.body?.username, req.body?.password, req.body?.role || 'user');
      logEvent(db, 'info', 'api', `User “${user.username}” created (${user.role})`);
      res.json(user);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/users/:id/reset', requireAdmin, (req, res) => {
    try {
      setPassword(db, Number(req.params.id), req.body?.password);
      logEvent(db, 'info', 'api', `Password reset for user #${req.params.id}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/users/:id', requireAdmin, (req, res) => {
    if (req.user && Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'cannot delete your own account' });
    }
    try {
      if (!deleteUser(db, Number(req.params.id))) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---------- settings ----------
  app.get('/api/settings', (req, res) => {
    res.json(getSettings());
  });

  app.put('/api/settings', (req, res) => {
    const applied = saveSettings(db, req.body || {});
    logEvent(db, 'info', 'api', `Settings updated: ${Object.keys(applied).join(', ') || 'none'}`);
    res.json(getSettings());
  });

  // validate configured sources with a live search
  app.post('/api/settings/test-sources', async (req, res) => {
    const providers = getProviders();
    if (providers.length === 0) return res.json([]);
    const results = [];
    for (const p of providers) {
      try {
        const hits = await p.search('Portal');
        results.push({ name: p.name, ok: true, results: hits.length });
      } catch (err) {
        results.push({ name: p.name, ok: false, error: err.message });
        logEvent(db, 'error', 'provider', `${p.name} test failed`, err.message);
      }
    }
    res.json(results);
  });

  // ---------- events / errors ----------
  // the operational log (scanner errors, library-path problems, failed logins,
  // account changes) is admin-only — same boundary as the web UI's Errors tab
  app.get('/api/events', requireAdmin, (req, res) => {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    res.json(listEvents(db, { level: req.query.level, limit }));
  });

  app.delete('/api/events/:id', requireAdmin, (req, res) => {
    if (!deleteEvent(db, req.params.id)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  app.delete('/api/events', requireAdmin, (req, res) => {
    clearEvents(db);
    res.json({ ok: true });
  });

  return app;
}
