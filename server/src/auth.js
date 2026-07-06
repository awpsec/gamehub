// Local user accounts + session tokens. Passwords are scrypt-hashed
// (node:crypto — no external dependencies). First created user is the admin.
import crypto from 'node:crypto';

const TOKEN_TTL_DAYS = 30;

export function initAuth(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password TEXT NOT NULL,          -- salt:hash (scrypt)
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
  `);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test);
  } catch {
    return false;
  }
}

export function countUsers(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function createUser(db, username, password, role = 'user') {
  username = String(username || '').trim();
  if (username.length < 2) throw new Error('username must be at least 2 characters');
  if (String(password || '').length < 6) throw new Error('password must be at least 6 characters');
  if (!['admin', 'user'].includes(role)) role = 'user';
  const info = db
    .prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), role);
  return { id: info.lastInsertRowid, username, role };
}

export function authenticate(db, username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password)) return null;
  return { id: user.id, username: user.username, role: user.role };
}

export function createToken(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO tokens (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+${TOKEN_TTL_DAYS} days'))`
  ).run(token, userId);
  return token;
}

export function getUserByToken(db, token) {
  if (!token) return null;
  // NB: expired tokens are rejected by the WHERE clause below, so we don't need
  // to prune on every request — a periodic sweepExpiredTokens() handles cleanup.
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role FROM tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token = ? AND t.expires_at >= datetime('now')`
    )
    .get(String(token));
  return row || null;
}

// GC expired session tokens. Called on a timer (not per-request) to avoid a DB
// write on every authenticated API call.
export function sweepExpiredTokens(db) {
  return db.prepare("DELETE FROM tokens WHERE expires_at < datetime('now')").run().changes;
}

export function deleteToken(db, token) {
  db.prepare('DELETE FROM tokens WHERE token = ?').run(String(token || ''));
}

export function listUsers(db) {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all();
}

export function setPassword(db, userId, password) {
  if (String(password || '').length < 6) throw new Error('password must be at least 6 characters');
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(password), userId);
  db.prepare('DELETE FROM tokens WHERE user_id = ?').run(userId); // invalidate old sessions
}

export function deleteUser(db, userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  if (user.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    if (admins <= 1) throw new Error('cannot delete the last admin');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return true;
}
