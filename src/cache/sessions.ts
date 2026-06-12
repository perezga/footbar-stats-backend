import { db, getSyncState, setSyncState } from '../db.js';
import { fetchSessionDetail, fetchSessionList } from '../footbar/client.js';
import type { MatchType, SessionAPI, SessionListAPI } from '../footbar/types.js';
import { tryParse } from '../util/json.js';
import { invalidateDetailsCache } from './derive.js';

const LIST_TTL_MS = 60 * 60 * 1000;
const LAST_SYNC_KEY = 'last_list_sync';

const upsertList = db.prepare(
  `INSERT INTO footbar_sessions (app_user_id, id, start_date, match_type, position, list_data)
   VALUES (@app_user_id, @id, @start_date, @match_type, @position, @list_data)
   ON CONFLICT(app_user_id, id) DO UPDATE SET
     start_date = excluded.start_date,
     match_type = excluded.match_type,
     position = excluded.position,
     list_data = excluded.list_data`,
);

async function syncList(appUserId: number): Promise<void> {
  const page = await fetchSessionList(appUserId);
  const writeAll = db.transaction((items: SessionListAPI[]) => {
    for (const s of items) {
      upsertList.run({
        app_user_id: appUserId,
        id: s.id,
        start_date: s.start_date,
        match_type: s.match_type,
        position: s.position ?? null,
        list_data: JSON.stringify(s),
      });
    }
  });
  writeAll(page.results);
  invalidateDetailsCache();
  setSyncState(LAST_SYNC_KEY, Date.now().toString(), appUserId);
}

export async function ensureListFresh(appUserId: number, force = false): Promise<void> {
  const link = db.prepare('SELECT 1 FROM footbar_links WHERE app_user_id = ?').get(appUserId);
  if (!link) return;

  const last = Number(getSyncState(LAST_SYNC_KEY, appUserId) ?? 0);
  if (!force && Date.now() - last < LIST_TTL_MS) return;
  await syncList(appUserId);
}

export interface SessionListFilters {
  appUserId: number;
  matchType?: MatchType;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface SessionListResult {
  count: number;
  results: SessionListAPI[];
  last_sync: number;
}

export function listSessions(filters: SessionListFilters): SessionListResult {
  const where: string[] = ['app_user_id = @app_user_id'];
  const params: Record<string, string | number> = { app_user_id: filters.appUserId };
  if (filters.matchType) {
    where.push('match_type = @match_type');
    params.match_type = filters.matchType;
  }
  if (filters.from) {
    where.push('start_date >= @from');
    params.from = filters.from;
  }
  if (filters.to) {
    where.push('start_date <= @to');
    params.to = filters.to;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  const count = (
    db.prepare(`SELECT COUNT(*) as c FROM footbar_sessions ${whereSql}`).get(params) as {
      c: number;
    }
  ).c;
  const rows = db
    .prepare(
      `SELECT list_data FROM footbar_sessions ${whereSql} ORDER BY start_date DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as { list_data: string }[];

  return {
    count,
    results: rows.flatMap((r) => tryParse<SessionListAPI>(r.list_data) ?? []),
    last_sync: Number(getSyncState(LAST_SYNC_KEY, filters.appUserId) ?? 0),
  };
}

/** Every cached session list row for a user, newest first (for merged views). */
export function listAllSessions(appUserId: number, matchType?: MatchType): SessionListAPI[] {
  const rows = (
    matchType
      ? db
          .prepare(
            'SELECT list_data FROM footbar_sessions WHERE app_user_id = ? AND match_type = ? ORDER BY start_date DESC',
          )
          .all(appUserId, matchType)
      : db
          .prepare(
            'SELECT list_data FROM footbar_sessions WHERE app_user_id = ? ORDER BY start_date DESC',
          )
          .all(appUserId)
  ) as { list_data: string }[];
  return rows.flatMap((r) => tryParse<SessionListAPI>(r.list_data) ?? []);
}

export async function getSessionDetail(id: number, appUserId: number): Promise<SessionAPI | null> {
  const row = db
    .prepare(
      'SELECT detail_data, detail_fetched_at FROM footbar_sessions WHERE app_user_id = ? AND id = ?',
    )
    .get(appUserId, id) as
    | { detail_data: string | null; detail_fetched_at: number | null }
    | undefined;

  if (row?.detail_data) {
    const cached = tryParse<SessionAPI>(row.detail_data);
    if (cached) return cached;
  }

  const link = db.prepare('SELECT 1 FROM footbar_links WHERE app_user_id = ?').get(appUserId);
  if (!link) return null;

  const fresh = await fetchSessionDetail(id, appUserId);
  const existing = db
    .prepare('SELECT id FROM footbar_sessions WHERE app_user_id = ? AND id = ?')
    .get(appUserId, id) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE footbar_sessions SET detail_data = @detail_data, detail_fetched_at = @detail_fetched_at 
       WHERE app_user_id = @app_user_id AND id = @id`,
    ).run({
      app_user_id: appUserId,
      id: fresh.id,
      detail_data: JSON.stringify(fresh),
      detail_fetched_at: Date.now(),
    });
  } else if (fresh.start_date && fresh.match_type) {
    db.prepare(
      `INSERT INTO footbar_sessions (app_user_id, id, start_date, match_type, position, list_data, detail_data, detail_fetched_at)
       VALUES (@app_user_id, @id, @start_date, @match_type, @position, @list_data, @detail_data, @detail_fetched_at)`,
    ).run({
      app_user_id: appUserId,
      id: fresh.id,
      start_date: fresh.start_date,
      match_type: fresh.match_type,
      position: fresh.position ?? null,
      list_data: JSON.stringify({
        id: fresh.id,
        start_date: fresh.start_date,
        stop_date: fresh.stop_date,
        title: fresh.title,
        location: fresh.location,
        match_type: fresh.match_type,
        position: fresh.position,
        score_stars: fresh.score_stars,
        tracker_data: fresh.tracker_data,
      }),
      detail_data: JSON.stringify(fresh),
      detail_fetched_at: Date.now(),
    });
  }
  invalidateDetailsCache();
  return fresh;
}

export async function refreshSessionDetail(
  id: number,
  appUserId: number,
): Promise<SessionAPI | null> {
  db.prepare(
    'UPDATE footbar_sessions SET detail_data = NULL, detail_fetched_at = NULL WHERE app_user_id = ? AND id = ?',
  ).run(appUserId, id);
  const fresh = await getSessionDetail(id, appUserId);
  if (!fresh) return null;

  db.prepare(
    `UPDATE footbar_sessions SET start_date = @start_date, match_type = @match_type,
       position = @position, list_data = @list_data WHERE app_user_id = @app_user_id AND id = @id`,
  ).run({
    app_user_id: appUserId,
    id: fresh.id,
    start_date: fresh.start_date,
    match_type: fresh.match_type,
    position: fresh.position ?? null,
    list_data: JSON.stringify({
      id: fresh.id,
      start_date: fresh.start_date,
      stop_date: fresh.stop_date,
      title: fresh.title,
      location: fresh.location,
      match_type: fresh.match_type,
      position: fresh.position,
      score_stars: fresh.score_stars,
      tracker_data: fresh.tracker_data,
    }),
  });
  invalidateDetailsCache();
  return fresh;
}

export function getLastSync(appUserId: number): number {
  return Number(getSyncState(LAST_SYNC_KEY, appUserId) ?? 0);
}

export function deleteSessions(appUserId: number): void {
  db.prepare('DELETE FROM footbar_sessions WHERE app_user_id = ?').run(appUserId);
}
