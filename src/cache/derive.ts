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
// Outer map key is footbarUserId, inner map key is matchType (or 'all').
const detailsCache = new Map<number, Map<string, SessionAPI[]>>();

export function invalidateDetailsCache(footbarUserId?: number): void {
  if (footbarUserId !== undefined) {
    detailsCache.delete(footbarUserId);
  } else {
    detailsCache.clear();
  }
}

function allDetails(footbarUserId: number, matchType?: string): SessionAPI[] {
  const typeKey = matchType ?? 'all';
  let userMap = detailsCache.get(footbarUserId);
  if (!userMap) {
    userMap = new Map();
    detailsCache.set(footbarUserId, userMap);
  }
  const hit = userMap.get(typeKey);
  if (hit) return hit;
  const rows = (
    matchType
      ? db
          .prepare(
            'SELECT detail_data FROM sessions WHERE footbar_user_id = ? AND detail_data IS NOT NULL AND match_type = ?',
          )
          .all(footbarUserId, matchType)
      : db
          .prepare(
            'SELECT detail_data FROM sessions WHERE footbar_user_id = ? AND detail_data IS NOT NULL',
          )
          .all(footbarUserId)
  ) as DetailRow[];
  // A corrupt row drops out of the pool instead of failing the whole request.
  const details = rows.flatMap((r) => tryParse<SessionAPI>(r.detail_data) ?? []);
  userMap.set(typeKey, details);
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

export function computeRecords(footbarUserId: number, matchType?: string): RecordEntry[] {
  const details = allDetails(footbarUserId, matchType);
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
function sessionIdByDay(footbarUserId: number): Map<string, number> {
  const rows = db
    .prepare("SELECT id, start_date FROM sessions WHERE footbar_user_id = ? AND match_type = '11'")
    .all(footbarUserId) as {
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
async function playerMatchGoals(playerId: number, footbarUserId: number): Promise<MatchGoals[]> {
  let matches: Awaited<ReturnType<typeof getPlayerMatches>>['results'];
  try {
    matches = (await getPlayerMatches(playerId)).results;
  } catch {
    return [];
  }
  const byDay = sessionIdByDay(footbarUserId);
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

export async function computeGoalsTrend(
  playerId: number,
  footbarUserId: number,
  limit = 30,
): Promise<TrendPoint[]> {
  const matches = await playerMatchGoals(playerId, footbarUserId);
  return matches.slice(-limit).map((m) => ({
    session_id: m.session_id,
    start_date: m.date,
    title: m.title,
    value: m.goals,
  }));
}

/** Most goals in one match, or null with no goals yet / RFAF unavailable. */
export async function computeGoalsRecord(
  playerId: number,
  footbarUserId: number,
): Promise<RecordEntry | null> {
  let best: MatchGoals | null = null;
  for (const m of await playerMatchGoals(playerId, footbarUserId)) {
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

// --- Player level (derived from all available season matches) ---

export const LEVEL_WINDOW = 100;

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
async function goalsPerMatch(
  playerId: number,
  footbarUserId: number,
  sessionIds: number[],
): Promise<number | null> {
  const wanted = new Set(sessionIds);
  const inWindow = (await playerMatchGoals(playerId, footbarUserId)).filter(
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
export async function computeLevel(playerId: number, footbarUserId: number): Promise<LevelResult> {
  // Build a pool of recent matches from both Footbar and RFAF.
  // 1. Get RFAF matches (source of goals and dateless fixtures)
  let rfafMatches: MatchGoals[] = [];
  try {
    rfafMatches = await playerMatchGoals(playerId, footbarUserId);
  } catch {
    // RFAF down: proceed with Footbar-only if available
  }

  // 2. Get Footbar details for metrics
  const footbarPool = allDetails(footbarUserId)
    .filter((s) => s.match_type === '11' || s.match_type === 'ss');

  // 3. Combine into a unified pool of unique matches, newest first.
  // We identify matches by their Footbar ID or their RFAF date.
  const seenSessions = new Set<number>();
  const seenDates = new Set<string>();
  const pool: { id?: number; date?: string; title: string; session?: SessionAPI; goals?: number }[] = [];

  // Add Footbar sessions first as they have the most metrics
  for (const s of footbarPool) {
    const date = madridDateKey(s.start_date);
    const rfaf = date ? rfafMatches.find(m => m.date === date) : undefined;
    pool.push({
      id: s.id,
      date: date ?? undefined,
      title: s.title,
      session: s,
      goals: rfaf?.goals,
    });
    if (s.id) seenSessions.add(s.id);
    if (date) seenDates.add(date);
  }

  // Add RFAF matches that don't have a Footbar session yet
  for (const m of rfafMatches) {
    if (m.session_id && seenSessions.has(m.session_id)) continue;
    if (m.date && seenDates.has(m.date)) continue;
    pool.push({
      date: m.date,
      title: m.title,
      goals: m.goals,
    });
  }

  // Sort by date descending and take the window
  pool.sort((a, b) => {
    const dateA = a.date || '0000-00-00';
    const dateB = b.date || '0000-00-00';
    return dateB.localeCompare(dateA);
  });
  
  const activePool = pool.slice(0, LEVEL_WINDOW);

  if (activePool.length === 0) {
    return { level: null, level_index: null, window: LEVEL_WINDOW, matches: [], reasons: [] };
  }

  const sessions = activePool.map(p => p.session).filter((s): s is SessionAPI => !!s);
  
  const nums = (key: keyof SessionAPI): number[] =>
    sessions.map((s) => s[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
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

  // Goals from RFAF
  const goalVals = activePool.map(p => p.goals).filter((v): v is number => v !== undefined);
  const avgGoals = goalVals.length > 0 ? goalVals.reduce((a, b) => a + b, 0) / activePool.length : null;
  
  add(
    'goals',
    'Goles por partido',
    avgGoals,
    [0.25, 0.5, 1, 1.5],
    (v) => v.toFixed(1),
  );

  if (reasons.length === 0) {
    return { level: null, level_index: null, window: LEVEL_WINDOW, matches: [], reasons: [] };
  }

  const overall = Math.round(reasons.reduce((sum, r) => sum + r.level, 0) / reasons.length);
  return {
    level: LEVEL_NAMES[overall]!,
    level_index: overall,
    window: LEVEL_WINDOW,
    matches: activePool.map((p) => ({ 
      session_id: p.id ?? 0, 
      title: p.title, 
      start_date: p.date ?? 'Unknown' 
    })),
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
  footbarUserId: number,
  matchType?: string,
  excludeId?: number,
  window = 10,
): { count: number; averages: Partial<Record<AverageMetric, MetricAverage>> } {
  const pool = allDetails(footbarUserId, matchType)
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

export function computeTrend(
  footbarUserId: number,
  metric: TrendMetric,
  limit = 30,
  matchType?: string,
): TrendPoint[] {
  const details = allDetails(footbarUserId, matchType)
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
