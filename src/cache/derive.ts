import { db } from '../db.js';
import type { SessionAPI } from '../footbar/types.js';
import { tryParse } from '../util/json.js';
import { madridDateKey } from './fixtureLink.js';
import { getPlayerMatches } from './rfaf.js';

export interface RecordEntry {
  metric: string;
  value: number;
  /** Null when the record's match has no Footbar session (fixture-only). */
  session_id: number | null;
  session_title: string;
  start_date: string;
}

interface DetailRow {
  detail_data: string;
}

// Stats endpoints re-derive from every cached detail; parsing them all per
// request gets slow as sessions accumulate, so keep the parsed pool in memory
// until a session write invalidates it.
const detailsCache = new Map<string, SessionAPI[]>();

export function invalidateDetailsCache(): void {
  detailsCache.clear();
}

function allDetails(matchType?: string): SessionAPI[] {
  const key = matchType ?? 'all';
  const hit = detailsCache.get(key);
  if (hit) return hit;
  const rows = (
    matchType
      ? db
          .prepare(
            'SELECT detail_data FROM sessions WHERE detail_data IS NOT NULL AND match_type = ?',
          )
          .all(matchType)
      : db.prepare('SELECT detail_data FROM sessions WHERE detail_data IS NOT NULL').all()
  ) as DetailRow[];
  // A corrupt row drops out of the pool instead of failing the whole request.
  const details = rows.flatMap((r) => tryParse<SessionAPI>(r.detail_data) ?? []);
  detailsCache.set(key, details);
  return details;
}

const RECORD_METRICS: { key: keyof SessionAPI; label: string }[] = [
  { key: 'distance', label: 'Longest distance' },
  { key: 'sprint_speed', label: 'Top sprint speed' },
  { key: 'shot_speed', label: 'Top shot speed' },
  { key: 'sprint_count', label: 'Most sprints' },
  { key: 'shot_count', label: 'Most shots' },
  { key: 'pass_count', label: 'Most passes' },
  { key: 'hsr_plus', label: 'Most high-speed running' },
  { key: 'playing_time', label: 'Longest playing time' },
];

export function computeRecords(matchType?: string): RecordEntry[] {
  const details = allDetails(matchType);
  if (details.length === 0) return [];
  const out: RecordEntry[] = [];
  for (const { key, label } of RECORD_METRICS) {
    let best: SessionAPI | null = null;
    let bestVal = -Infinity;
    for (const s of details) {
      const v = s[key];
      if (typeof v === 'number' && v > bestVal) {
        bestVal = v;
        best = s;
      }
    }
    if (best) {
      out.push({
        metric: label,
        value: bestVal,
        session_id: best.id,
        session_title: best.title,
        start_date: best.start_date,
      });
    }
  }
  return out;
}

export type TrendMetric =
  | 'distance'
  | 'sprint_count'
  | 'sprint_speed'
  | 'avg_sprint_speed'
  | 'shot_count'
  | 'shot_speed'
  | 'avg_shot_speed'
  | 'pass_count'
  | 'activity'
  | 'playing_time'
  | 'hsr_plus'
  | 'time_running'
  | 'run_count'
  | 'dribble_count';

export const TREND_METRICS: TrendMetric[] = [
  'distance',
  'sprint_count',
  'sprint_speed',
  'avg_sprint_speed',
  'shot_count',
  'shot_speed',
  'avg_shot_speed',
  'pass_count',
  'activity',
  'playing_time',
  'hsr_plus',
  'time_running',
  'run_count',
  'dribble_count',
];

export interface TrendPoint {
  /** Null when the point's match has no Footbar session (fixture-only). */
  session_id: number | null;
  start_date: string;
  title: string;
  value: number;
}

// --- Goals (from RFAF player-match events, not Footbar session details) ---

interface MatchGoals {
  date: string;
  title: string;
  goals: number;
  session_id: number | null;
}

/** Footbar session id per Madrid calendar day (Game sessions only). */
function sessionIdByDay(): Map<string, number> {
  const rows = db.prepare("SELECT id, start_date FROM sessions WHERE match_type = '11'").all() as {
    id: number;
    start_date: string;
  }[];
  const map = new Map<string, number>();
  for (const r of rows) {
    const key = madridDateKey(r.start_date);
    if (key) map.set(key, r.id);
  }
  return map;
}

/**
 * The player's league matches with his goal count, date-ascending, linked to
 * the same-day Footbar session when one exists. Empty when RFAF is down so
 * stats endpoints degrade instead of failing.
 */
async function playerMatchGoals(): Promise<MatchGoals[]> {
  let matches: Awaited<ReturnType<typeof getPlayerMatches>>['results'];
  try {
    matches = (await getPlayerMatches()).results;
  } catch {
    return [];
  }
  const byDay = sessionIdByDay();
  return matches
    .flatMap((m) => (m.date === null ? [] : [{ ...m, date: m.date }]))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((m) => ({
      date: m.date,
      title: `${m.home} vs ${m.away}`,
      goals: m.events.filter((e) => e.kind === 'goal').length,
      session_id: byDay.get(m.date) ?? null,
    }));
}

export async function computeGoalsTrend(limit = 30): Promise<TrendPoint[]> {
  const matches = await playerMatchGoals();
  return matches.slice(-limit).map((m) => ({
    session_id: m.session_id,
    start_date: m.date,
    title: m.title,
    value: m.goals,
  }));
}

/** Most goals in one match, or null with no goals yet / RFAF unavailable. */
export async function computeGoalsRecord(): Promise<RecordEntry | null> {
  let best: MatchGoals | null = null;
  for (const m of await playerMatchGoals()) {
    if (!best || m.goals > best.goals) best = m;
    // On a tie, prefer a match that can link to its Footbar session.
    else if (m.goals === best.goals && best.session_id === null && m.session_id !== null) best = m;
  }
  if (!best || best.goals === 0) return null;
  return {
    metric: 'Most goals in a match',
    value: best.goals,
    session_id: best.session_id,
    session_title: best.title,
    start_date: best.date,
  };
}

/** Metrics averaged for the session-vs-average comparison (the detail tiles). */
export const AVERAGE_METRICS = [
  'distance',
  'playing_time',
  'sprint_count',
  'sprint_speed',
  'avg_sprint_speed',
  'shot_count',
  'shot_speed',
  'avg_shot_speed',
  'pass_count',
  'activity',
  'hsr_plus',
  'time_with_ball',
  'acceleration',
  'stop_and_go',
  'run_count',
  'time_running',
  'dribble_count',
] as const;
export type AverageMetric = (typeof AVERAGE_METRICS)[number];

export interface MetricAverage {
  mean: number;
  /** Sessions where the metric was present; nullable metrics carry their own n. */
  n: number;
}

/**
 * Per-metric mean over the player's most recent `window` sessions of the same
 * match type, excluding the session being compared. Only sessions whose detail
 * is already cached enter the pool (details are fetched lazily on first open).
 */
export function computeAverages(
  matchType?: string,
  excludeId?: number,
  window = 10,
): { count: number; averages: Partial<Record<AverageMetric, MetricAverage>> } {
  const pool = allDetails(matchType)
    .filter((s) => s.id !== excludeId)
    .sort((a, b) => b.start_date.localeCompare(a.start_date))
    .slice(0, window);
  const averages: Partial<Record<AverageMetric, MetricAverage>> = {};
  for (const key of AVERAGE_METRICS) {
    let sum = 0;
    let n = 0;
    for (const s of pool) {
      const v = (s as unknown as Record<string, unknown>)[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    if (n > 0) averages[key] = { mean: sum / n, n };
  }
  return { count: pool.length, averages };
}

export function computeTrend(metric: TrendMetric, limit = 30, matchType?: string): TrendPoint[] {
  const details = allDetails(matchType)
    .filter((s) => typeof (s as unknown as Record<string, unknown>)[metric] === 'number')
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const recent = details.slice(-limit);
  return recent.map((s) => ({
    session_id: s.id,
    start_date: s.start_date,
    title: s.title,
    value: (s as unknown as Record<string, number>)[metric] ?? 0,
  }));
}
