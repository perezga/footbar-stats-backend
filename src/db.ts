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
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nickname TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS footbar_links (
    app_user_id INTEGER PRIMARY KEY,
    footbar_user_id INTEGER UNIQUE NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    scope TEXT NOT NULL,
    FOREIGN KEY(app_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rfaf_links (
    app_user_id INTEGER PRIMARY KEY,
    rfaf_player_id TEXT NOT NULL,
    FOREIGN KEY(app_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS footbar_profiles (
    app_user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    FOREIGN KEY(app_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS footbar_sessions (
    app_user_id INTEGER NOT NULL,
    id INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    match_type TEXT NOT NULL,
    position TEXT,
    list_data TEXT NOT NULL,
    detail_data TEXT,
    detail_fetched_at INTEGER,
    PRIMARY KEY (app_user_id, id),
    FOREIGN KEY(app_user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_footbar_sessions_user_start ON footbar_sessions(app_user_id, start_date DESC);
  CREATE INDEX IF NOT EXISTS idx_footbar_sessions_user_match_type ON footbar_sessions(app_user_id, match_type);

  CREATE TABLE IF NOT EXISTS sync_state (
    user_id INTEGER NOT NULL DEFAULT 0,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS app_sessions (
    sid TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL, -- References users.id
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
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

// --- Migrations to the new independent identity schema ---
const tableInfo = db.pragma('table_info(app_sessions)') as { name: string }[];
// We can detect if we are on the "Footbar-as-ID" schema if app_sessions has no FK to users
// or if the 'users' table is empty but 'oauth_tokens' has data.
const hasUsersTable = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
  .get();

if (hasUsersTable) {
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  const hasOldTokens = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_tokens'")
    .get();

  if (userCount === 0 && hasOldTokens) {
    db.transaction(() => {
      // 1. Get all unique Footbar user IDs we have data for.
      const footbarUserIds = db.prepare('SELECT user_id FROM oauth_tokens').all() as {
        user_id: number;
      }[];

      for (const { user_id } of footbarUserIds) {
        // 2. Create an internal user for each Footbar user.
        const res = db
          .prepare(
            'INSERT INTO users (email, password_hash, nickname, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(
            `footbar_${user_id}@internal.temp`,
            'MIGRATED_USER',
            `Player ${user_id}`,
            Date.now(),
          );
        const appUserId = res.lastInsertRowid as number;

        // 3. Migrate oauth_tokens -> footbar_links
        db.prepare(`
                    INSERT INTO footbar_links (app_user_id, footbar_user_id, access_token, refresh_token, expires_at, scope)
                    SELECT ?, user_id, access_token, refresh_token, expires_at, scope FROM oauth_tokens WHERE user_id = ?
                `).run(appUserId, user_id);

        // 4. Migrate profile -> footbar_profiles
        db.prepare(`
                    INSERT INTO footbar_profiles (app_user_id, data, fetched_at)
                    SELECT ?, data, fetched_at FROM profile WHERE user_id = ?
                `).run(appUserId, user_id);

        // 5. Migrate sessions -> footbar_sessions
        db.prepare(`
                    INSERT INTO footbar_sessions (app_user_id, id, start_date, match_type, position, list_data, detail_data, detail_fetched_at)
                    SELECT ?, id, start_date, match_type, position, list_data, detail_data, detail_fetched_at FROM sessions WHERE user_id = ?
                `).run(appUserId, user_id);

        // 6. Migrate user_rfaf_link -> rfaf_links
        db.prepare(`
                    INSERT INTO rfaf_links (app_user_id, rfaf_player_id)
                    SELECT ?, cod_player FROM user_rfaf_link WHERE user_id = ?
                `).run(appUserId, user_id);

        // 7. Update app_sessions to point to new appUserId
        db.prepare('UPDATE app_sessions SET user_id = ? WHERE user_id = ?').run(appUserId, user_id);

        // 8. Update sync_state
        db.prepare('UPDATE sync_state SET user_id = ? WHERE user_id = ?').run(appUserId, user_id);
      }

      // Clean up old tables
      db.exec(`
                DROP TABLE IF EXISTS oauth_tokens;
                DROP TABLE IF EXISTS profile;
                DROP TABLE IF EXISTS sessions;
                DROP TABLE IF EXISTS user_rfaf_link;
            `);
    })();
  }
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
  const row = db
    .prepare('SELECT rfaf_player_id FROM rfaf_links WHERE app_user_id = ?')
    .get(userId) as { rfaf_player_id: string } | undefined;
  return row?.rfaf_player_id ?? null;
}

export function setRfafPlayerId(userId: number, rfafPlayerId: string): void {
  db.prepare(
    'INSERT INTO rfaf_links (app_user_id, rfaf_player_id) VALUES (?, ?) ON CONFLICT(app_user_id) DO UPDATE SET rfaf_player_id = excluded.rfaf_player_id',
  ).run(userId, rfafPlayerId);
}

export function deleteRfafLink(userId: number): void {
  db.prepare('DELETE FROM rfaf_links WHERE app_user_id = ?').run(userId);
}
