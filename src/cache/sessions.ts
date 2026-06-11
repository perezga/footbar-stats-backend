import { db, getSyncState, setSyncState } from '../db.js';
import { fetchSessionDetail, fetchSessionList } from '../footbar/client.js';
import type { MatchType, SessionAPI, SessionListAPI } from '../footbar/types.js';
import { tryParse } from '../util/json.js';
import { invalidateDetailsCache } from './derive.js';

const LIST_TTL_MS = 60 * 60 * 1000;
const LAST_SYNC_KEY = 'last_list_sync';

const upsertList = db.prepare(
  `INSERT INTO sessions (id, start_date, match_type, position, list_data)
   VALUES (@id, @start_date, @match_type, @position, @list_data)
   ON CONFLICT(id) DO UPDATE SET
     start_date = excluded.start_date,
     match_type = excluded.match_type,
     position = excluded.position,
     list_data = excluded.list_data`,
);

async function syncList(): Promise<void> {
  const page = await fetchSessionList();
  const writeAll = db.transaction((items: SessionListAPI[]) => {
    for (const s of items) {
      upsertList.run({
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
  setSyncState(LAST_SYNC_KEY, Date.now().toString());
}

export async function ensureListFresh(force = false): Promise<void> {
  const last = Number(getSyncState(LAST_SYNC_KEY) ?? 0);
  if (!force && Date.now() - last < LIST_TTL_MS) return;
  await syncList();
}

export interface SessionListFilters {
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
  const where: string[] = [];
  const params: Record<string, string | number> = {};
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
    db.prepare(`SELECT COUNT(*) as c FROM sessions ${whereSql}`).get(params) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT list_data FROM sessions ${whereSql} ORDER BY start_date DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as { list_data: string }[];

  return {
    count,
    results: rows.flatMap((r) => tryParse<SessionListAPI>(r.list_data) ?? []),
    last_sync: Number(getSyncState(LAST_SYNC_KEY) ?? 0),
  };
}

/** Every cached session list row, newest first (for merged views). */
export function listAllSessions(matchType?: MatchType): SessionListAPI[] {
  const rows = (
    matchType
      ? db
          .prepare('SELECT list_data FROM sessions WHERE match_type = ? ORDER BY start_date DESC')
          .all(matchType)
      : db.prepare('SELECT list_data FROM sessions ORDER BY start_date DESC').all()
  ) as { list_data: string }[];
  return rows.flatMap((r) => tryParse<SessionListAPI>(r.list_data) ?? []);
}

export async function getSessionDetail(id: number): Promise<SessionAPI> {
  const row = db
    .prepare('SELECT detail_data, detail_fetched_at FROM sessions WHERE id = ?')
    .get(id) as { detail_data: string | null; detail_fetched_at: number | null } | undefined;
  if (row?.detail_data) {
    // A corrupt cached detail counts as a miss and is re-fetched below.
    const cached = tryParse<SessionAPI>(row.detail_data);
    if (cached) return cached;
  }
  const fresh = await fetchSessionDetail(id);
  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id) as
    | { id: number }
    | undefined;
  if (existing) {
    db.prepare(
      `UPDATE sessions SET detail_data = @detail_data, detail_fetched_at = @detail_fetched_at WHERE id = @id`,
    ).run({
      id: fresh.id,
      detail_data: JSON.stringify(fresh),
      detail_fetched_at: Date.now(),
    });
  } else if (fresh.start_date && fresh.match_type) {
    db.prepare(
      `INSERT INTO sessions (id, start_date, match_type, position, list_data, detail_data, detail_fetched_at)
       VALUES (@id, @start_date, @match_type, @position, @list_data, @detail_data, @detail_fetched_at)`,
    ).run({
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

/**
 * Force a fresh fetch of one session: drop the cached detail, re-fetch it, and
 * sync the list metadata (start_date/match_type/…) from the fresh result so a
 * session that was later reclassified/retimed in Footbar is fully corrected.
 */
export async function refreshSessionDetail(id: number): Promise<SessionAPI> {
  db.prepare('UPDATE sessions SET detail_data = NULL, detail_fetched_at = NULL WHERE id = ?').run(
    id,
  );
  const fresh = await getSessionDetail(id); // detail_data is null -> re-fetches and stores
  db.prepare(
    `UPDATE sessions SET start_date = @start_date, match_type = @match_type,
       position = @position, list_data = @list_data WHERE id = @id`,
  ).run({
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

export function getLastSync(): number {
  return Number(getSyncState(LAST_SYNC_KEY) ?? 0);
}
