import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
// DB_PATH override lets tests/CI point at a throwaway database.
const dbPath = process.env.DB_PATH ?? resolve(here, '..', 'data', 'footbar.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    footbar_user_id INTEGER UNIQUE,
    rfaf_player_id TEXT UNIQUE,
    rfaf_season TEXT,
    rfaf_team_id INTEGER,
    rfaf_group_id TEXT,
    rfaf_competition_id TEXT,
    rfaf_own_player TEXT,
    rfaf_own_team TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    footbar_user_id INTEGER NOT NULL,
    scope TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profile (
    footbar_user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    footbar_user_id INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    match_type TEXT NOT NULL,
    position TEXT,
    list_data TEXT NOT NULL,
    detail_data TEXT,
    detail_fetched_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(footbar_user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_date DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_match_type ON sessions(match_type);

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_sessions (
    sid TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_state (
    state TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rfaf_cache (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
`);

export function getSyncState(key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSyncState(key: string, value: string): void {
  db.prepare(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
