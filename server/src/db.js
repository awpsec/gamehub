import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { initSettings } from './settings.js';
import { initEvents } from './events.js';
import { initAuth } from './auth.js';

export function initDb(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(path.join(config.dataDir, 'gamehub.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rel_path TEXT UNIQUE NOT NULL,
      raw_name TEXT NOT NULL,
      clean_name TEXT NOT NULL,
      hint_year INTEGER,
      payload_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new',
      confidence REAL,
      provider TEXT,
      provider_id TEXT,
      meta_title TEXT,
      meta_year INTEGER,
      meta_cover TEXT,
      meta_summary TEXT,
      meta_genres TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      title TEXT NOT NULL,
      year INTEGER,
      cover TEXT,
      summary TEXT,
      genres TEXT,
      score REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
    CREATE INDEX IF NOT EXISTS idx_candidates_game ON candidates(game_id);
  `);

  // migrations for pre-0.4 databases
  for (const col of ['meta_hero TEXT', 'meta_ratings TEXT', 'meta_media TEXT', 'meta_compat TEXT', 'meta_price TEXT', 'meta_about TEXT', 'meta_released TEXT', 'meta_tags TEXT', 'matched_manually INTEGER DEFAULT 0', 'meta_kind TEXT', 'meta_parent_id TEXT', 'meta_parent_title TEXT', 'meta_dlc TEXT', 'is_update INTEGER DEFAULT 0']) {
    try {
      db.exec(`ALTER TABLE games ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }

  initSettings(db);
  initEvents(db);
  initAuth(db);
  // profile picture (small data URL) for user differentiation — added post-0.8
  try { db.exec('ALTER TABLE users ADD COLUMN avatar TEXT'); } catch { /* column already exists */ }

  // per-user playtime (for profiles + the social/leaderboard tab). `playtime`
  // holds running totals; `play_sessions` records each session so we can do
  // time-windowed stats like "most played this week".
  db.exec(`
    CREATE TABLE IF NOT EXISTS playtime (
      user_id INTEGER NOT NULL,
      game_id INTEGER NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0,
      last_played TEXT,
      PRIMARY KEY (user_id, game_id)
    );
    CREATE TABLE IF NOT EXISTS play_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      game_id INTEGER NOT NULL,
      seconds INTEGER NOT NULL,
      ended_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON play_sessions(user_id, ended_at);
  `);

  return db;
}
