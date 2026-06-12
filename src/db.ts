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
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    user_id INTEGER PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    scope TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profile (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    user_id INTEGER NOT NULL,
    id INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    match_type TEXT NOT NULL,
    position TEXT,
    list_data TEXT NOT NULL,
    detail_data TEXT,
    detail_fetched_at INTEGER,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_start ON sessions(user_id, start_date DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_match_type ON sessions(user_id, match_type);

  CREATE TABLE IF NOT EXISTS sync_state (
    user_id INTEGER NOT NULL DEFAULT 0,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
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

  CREATE TABLE IF NOT EXISTS user_rfaf_link (
    user_id INTEGER PRIMARY KEY,
    cod_player TEXT NOT NULL
  );
`);

// --- Migrations for existing single-user data ---
const info = db.pragma('table_info(sessions)') as { name: string }[];
if (!info.some((c) => c.name === 'user_id')) {
  db.transaction(() => {
    // 1. Get the current user_id if we have one.
    const row = db.prepare('SELECT user_id FROM oauth_tokens LIMIT 1').get() as
      | { user_id: number }
      | undefined;
    const defaultUserId = row?.user_id ?? 0;

    // 2. oauth_tokens: remove the id=1 constraint by recreating it.
    db.exec(`
      ALTER TABLE oauth_tokens RENAME TO oauth_tokens_old;
      CREATE TABLE oauth_tokens (
        user_id INTEGER PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        scope TEXT NOT NULL
      );
      INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scope)
      SELECT user_id, access_token, refresh_token, expires_at, scope FROM oauth_tokens_old;
      DROP TABLE oauth_tokens_old;
    `);

    // 3. sessions: add user_id column.
    db.exec(`
      ALTER TABLE sessions RENAME TO sessions_old;
      CREATE TABLE sessions (
        user_id INTEGER NOT NULL,
        id INTEGER NOT NULL,
        start_date TEXT NOT NULL,
        match_type TEXT NOT NULL,
        position TEXT,
        list_data TEXT NOT NULL,
        detail_data TEXT,
        detail_fetched_at INTEGER,
        PRIMARY KEY (user_id, id)
      );
      INSERT INTO sessions (user_id, id, start_date, match_type, position, list_data, detail_data, detail_fetched_at)
      SELECT ${defaultUserId}, id, start_date, match_type, position, list_data, detail_data, detail_fetched_at FROM sessions_old;
      DROP TABLE sessions_old;
      CREATE INDEX idx_sessions_user_start ON sessions(user_id, start_date DESC);
      CREATE INDEX idx_sessions_user_match_type ON sessions(user_id, match_type);
    `);

    // 4. sync_state: add user_id column.
    db.exec(`
      ALTER TABLE sync_state RENAME TO sync_state_old;
      CREATE TABLE sync_state (
        user_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      INSERT INTO sync_state (user_id, key, value)
      SELECT CASE WHEN key LIKE 'rfaf_%' THEN 0 ELSE ${defaultUserId} END, key, value FROM sync_state_old;
      DROP TABLE sync_state_old;
    `);

    // 5. Initialize user_rfaf_link for the default user if RFAF_CODPLAYER is set.
    const codPlayer = process.env.RFAF_CODPLAYER;
    if (defaultUserId && codPlayer) {
      db.prepare('INSERT OR IGNORE INTO user_rfaf_link (user_id, cod_player) VALUES (?, ?)').run(
        defaultUserId,
        codPlayer,
      );
    }
  })();
}

export function getSyncState(key: string, userId = 0): string | null {
  const row = db
    .prepare('SELECT value FROM sync_state WHERE user_id = ? AND key = ?')
    .get(userId, key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSyncState(key: string, value: string, userId = 0): void {
  db.prepare(
    'INSERT INTO sync_state (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
  ).run(userId, key, value);
}

export function getRfafPlayerId(userId: number): string | null {
  const row = db.prepare('SELECT cod_player FROM user_rfaf_link WHERE user_id = ?').get(userId) as
    | { cod_player: string }
    | undefined;
  return row?.cod_player ?? null;
}

export function setRfafPlayerId(userId: number, codPlayer: string): void {
  db.prepare(
    'INSERT INTO user_rfaf_link (user_id, cod_player) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET cod_player = excluded.cod_player',
  ).run(userId, codPlayer);
}
