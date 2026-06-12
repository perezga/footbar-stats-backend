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

// --- Player level (derived from the last LEVEL_WINDOW matches) ---

export const LEVEL_WINDOW = 3;

export type PlayerLevelId = 'principiante' | 'novato' | 'amateur' | 'pro' | 'goat';

export const LEVEL_NAMES: readonly PlayerLevelId[] = [
  'principiante',
  'novato',
  'amateur',
  'pro',
  'goat',
];

export interface LevelReason {
  metric: string;
  /** Criterion name shown to the user (Spanish, like the profile UI). */
  label: string;
  /** Formatted value ('5.2 km', '27.4 km/h'). */
  display: string;
  /** Level this criterion alone would give (0..4 index into LEVEL_NAMES). */
  level: number;
  level_name: PlayerLevelId;
}

export interface LevelMatchRef {
  session_id: number;
  title: string;
  start_date: string;
}

export interface LevelResult {
  /** Null when no match details are cached yet. */
  level: PlayerLevelId | null;
  level_index: number | null;
  window: number;
  /** The matches the level was derived from (newest first). */
  matches: LevelMatchRef[];
  reasons: LevelReason[];
}

/** Highest level whose threshold the value reaches (0..4). */
function levelOf(value: number, thresholds: readonly number[]): number {
  let lvl = 0;
  thresholds.forEach((t, i) => {
    if (value >= t) lvl = i + 1;
  });
  return lvl;
}

/** Average goals per match over the window's RFAF-linked matches, or null. */
async function goalsPerMatch(sessionIds: number[]): Promise<number | null> {
  const wanted = new Set(sessionIds);
  const inWindow = (await playerMatchGoals()).filter(
    (m) => m.session_id !== null && wanted.has(m.session_id),
  );
  if (inWindow.length === 0) return null;
  return inWindow.reduce((sum, m) => sum + m.goals, 0) / inWindow.length;
}

/**
 * Player level from his last `LEVEL_WINDOW` matches ('11'/'ss' sessions with a
 * cached detail). Each criterion maps its per-match value onto the level scale
 * via per-level thresholds; the overall level is the rounded mean. Criteria
 * without data (no RFAF goals, metric missing) simply drop out.
 */
export async function computeLevel(): Promise<LevelResult> {
  const pool = allDetails()
    .filter((s) => s.match_type === '11' || s.match_type === 'ss')
    .sort((a, b) => b.start_date.localeCompare(a.start_date))
    .slice(0, LEVEL_WINDOW);
  if (pool.length === 0) {
    return { level: null, level_index: null, window: LEVEL_WINDOW, matches: [], reasons: [] };
  }

  const nums = (key: keyof SessionAPI): number[] =>
    pool.map((s) => s[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const avg = (key: keyof SessionAPI): number | null => {
    const vals = nums(key);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const max = (key: keyof SessionAPI): number | null => {
    const vals = nums(key);
    return vals.length > 0 ? Math.max(...vals) : null;
  };

  const reasons: LevelReason[] = [];
  const add = (
    metric: string,
    label: string,
    value: number | null,
    thresholds: readonly number[],
    display: (v: number) => string,
  ): void => {
    if (value === null) return;
    const level = levelOf(value, thresholds);
    reasons.push({
      metric,
      label,
      display: display(value),
      level,
      level_name: LEVEL_NAMES[level]!,
    });
  };

  const km = (v: number) => `${(v / 1000).toFixed(1)} km`;
  const kmh = (v: number) => `${(v * 3.6).toFixed(1)} km/h`;

  add('distance', 'Distancia por partido', avg('distance'), [3000, 4500, 6000, 8000], km);
  // 18 / 22 / 25 / 30 km/h expressed in m/s (the metric's unit).
  add('sprint_speed', 'Velocidad punta', max('sprint_speed'), [5.0, 6.11, 6.94, 8.33], kmh);
  add('sprint_count', 'Sprints por partido', avg('sprint_count'), [5, 10, 18, 28], (v) =>
    v.toFixed(0),
  );
  add('pass_count', 'Pases por partido', avg('pass_count'), [10, 20, 35, 50], (v) => v.toFixed(0));
  // score_stars is deliberately not a criterion: its scale is undocumented and
  // most cached sessions carry 0 (unrated), which would drag the level down.
  add(
    'goals',
    'Goles por partido',
    await goalsPerMatch(pool.map((s) => s.id)),
    [0.25, 0.5, 1, 1.5],
    (v) => v.toFixed(1),
  );

  const overall = Math.round(reasons.reduce((sum, r) => sum + r.level, 0) / reasons.length);
  return {
    level: LEVEL_NAMES[overall]!,
    level_index: overall,
    window: LEVEL_WINDOW,
    matches: pool.map((s) => ({ session_id: s.id, title: s.title, start_date: s.start_date })),
    reasons,
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
