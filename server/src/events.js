// Persistent event log backing the Errors tab.
// Events can carry an `action` (where to resolve this) and a `game_id`;
// game-linked warnings/errors are auto-cleared when the game is resolved.
const MAX_EVENTS = 500;

export function initEvents(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,          -- info | warn | error
      source TEXT NOT NULL,         -- scanner | matcher | provider | api
      message TEXT NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);
  `);
  // migrations for pre-0.3 databases
  for (const col of ['game_id INTEGER', 'action TEXT']) {
    try {
      db.exec(`ALTER TABLE events ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
}

export function logEvent(db, level, source, message, detail = '', opts = {}) {
  try {
    db.prepare(
      'INSERT INTO events (level, source, message, detail, game_id, action) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      level,
      source,
      message,
      String(detail || ''),
      opts.gameId ?? null,
      opts.action ? JSON.stringify(opts.action) : null
    );
    db.prepare(
      `DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ${MAX_EVENTS})`
    ).run();
  } catch (err) {
    console.error('[events] failed to log:', err.message);
  }
  const line = `[${source}] ${message}${detail ? ` — ${detail}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function listEvents(db, { level, limit = 200 } = {}) {
  const rows =
    level && level !== 'all'
      ? db.prepare('SELECT * FROM events WHERE level = ? ORDER BY id DESC LIMIT ?').all(level, limit)
      : db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ...r, action: r.action ? JSON.parse(r.action) : null }));
}

export function deleteEvent(db, id) {
  return db.prepare('DELETE FROM events WHERE id = ?').run(id).changes > 0;
}

export function clearEvents(db) {
  db.prepare('DELETE FROM events').run();
}

// a game got matched/ignored — its outstanding warnings/errors are resolved
export function clearGameEvents(db, gameId) {
  db.prepare("DELETE FROM events WHERE game_id = ? AND level IN ('warn', 'error')").run(gameId);
}

export function errorCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM events WHERE level = 'error'").get().n;
}
