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
export interface AdvancedMetrics {
  // RFAF-only
  goal_contribution_pct: number | null;
  clutch_factor_pct: number | null;
  discipline_rating: number | null;
  consistency_index: number | null;
  ppg_impact: number | null;
  scorer_percentile: number | null;
  // Combined
  shot_conversion_pct: number | null;
  distance_per_goal_km: number | null;
  workload_win_vs_loss_ratio: number | null;
  possession_win_ratio: number | null;
  fatigue_resistance_pct: number | null;
  workrate_win_pct: number | null;
  luka_modric_score: number | null;
  intensity_vs_rank_ratio: number | null;
}

export async function computeAdvancedMetrics(
  playerId: number,
  footbarUserId: number,
): Promise<AdvancedMetrics> {
  const [rfafStats, rfafMatches, rfafStandings, rfafScorers, rfafFixtures] = await Promise.all([
    import('./rfaf.js').then((m) => m.getPlayerStats(playerId)),
    getPlayerMatches(playerId),
    import('./rfaf.js').then((m) => m.getStandings(playerId)),
    import('./rfaf.js').then((m) => m.getScorers(playerId)),
    import('./rfaf.js').then((m) => m.getFixtures(playerId)),
  ]);

  const footbarPool = allDetails(footbarUserId, '11');

  // 1. Goal Contribution %
  let goalContribution = null;
  const ownGoals = rfafStats.results.stats.find((s) => s.name === 'Total Goles')?.value ?? 0;
  const ownTeam = rfafStandings.results.find((s) => s.own);
  if (ownTeam && ownTeam.goals_for > 0) {
    goalContribution = (ownGoals / ownTeam.goals_for) * 100;
  }

  // 2. Clutch Factor % (Goals in last quarter / Total Goals)
  let clutchFactor = null;
  const is7v7 = ['alevin', 'benjamin', 'prebenjamin'].some(c => 
    rfafStats.results.category.toLowerCase().includes(c)
  );
  const clutchThreshold = is7v7 ? 45 : 75;

  if (ownGoals > 0) {
    const clutchGoals = rfafMatches.results.reduce(
      (sum, m) => sum + m.events.filter((e) => e.kind === 'goal' && (e.minute ?? 0) >= clutchThreshold).length,
      0,
    );
    clutchFactor = (clutchGoals / ownGoals) * 100;
  }

  // 3. Discipline Rating (Minutes per card)
  let disciplineRating = null;
  const totalCards = rfafStats.results.cards.reduce((sum, c) => sum + c.value, 0);
  if (rfafStats.results.minutes_played && totalCards > 0) {
    disciplineRating = rfafStats.results.minutes_played / totalCards;
  }

  // 4. Consistency Index (Max consecutive matches as Titular)
  let consistencyIndex = 0;
  let currentStreak = 0;
  for (const m of rfafMatches.results) {
    if (m.started) {
      currentStreak++;
      consistencyIndex = Math.max(consistencyIndex, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  // 5. Points-per-Game (Impact)
  let ppgImpact = null;
  const playedDates = new Set(rfafMatches.results.map((m) => m.date));
  const playedPoints = rfafFixtures.results
    .filter((f) => playedDates.has(f.date) && f.result)
    .map((f) => (f.result === 'W' ? 3 : f.result === 'D' ? 1 : 0));
  const missedPoints = rfafFixtures.results
    .filter((f) => !playedDates.has(f.date) && f.result)
    .map((f) => (f.result === 'W' ? 3 : f.result === 'D' ? 1 : 0));

  if (playedPoints.length > 0 && missedPoints.length > 0) {
    const ppgPlayed = playedPoints.reduce((a: number, b) => a + b, 0) / playedPoints.length;
    const ppgMissed = missedPoints.reduce((a: number, b) => a + b, 0) / missedPoints.length;
    ppgImpact = ppgPlayed - ppgMissed;
  }

  // 6. Scorer Percentile
  let scorerPercentile = null;
  const myScorer = rfafScorers.results.find((s) => s.own);
  if (myScorer && rfafScorers.results.length > 0) {
    scorerPercentile = (1 - (myScorer.rank - 1) / rfafScorers.results.length) * 100;
  }

  // --- Combined ---

  const ownTeamName = rfafStats.results.team;
  const matchResults = new Map(rfafFixtures.results.map((f) => [f.date, f.result]));

  // 7. Shot Conversion %
  let shotConversion = null;
  const totalShots = footbarPool.reduce((sum, s) => sum + (s.shot_count ?? 0), 0);
  if (totalShots > 0 && ownGoals > 0) {
    shotConversion = (ownGoals / totalShots) * 100;
  }

  // 8. Distance per Goal
  let distancePerGoal = null;
  const totalDistance = footbarPool.reduce((sum, s) => sum + (s.distance ?? 0), 0);
  if (ownGoals > 0) {
    distancePerGoal = totalDistance / 1000 / ownGoals;
  }

  // 9. Workload Win vs Loss Ratio
  let workloadRatio = null;
  const wins = footbarPool.filter((s) => matchResults.get(madridDateKey(s.start_date) ?? '') === 'W');
  const losses = footbarPool.filter((s) => matchResults.get(madridDateKey(s.start_date) ?? '') === 'L');

  if (wins.length > 0 && losses.length > 0) {
    const avgWinDist = wins.reduce((sum, s) => sum + (s.distance ?? 0), 0) / wins.length;
    const avgLossDist = losses.reduce((sum, s) => sum + (s.distance ?? 0), 0) / losses.length;
    workloadRatio = avgWinDist / avgLossDist;
  }

  // 10. Possession Win Ratio
  let possessionRatio = null;
  if (wins.length > 0 && losses.length > 0) {
    const avgWinBall = wins.reduce((sum, s) => sum + (s.time_with_ball ?? 0), 0) / wins.length;
    const avgLossBall = losses.reduce((sum, s) => sum + (s.time_with_ball ?? 0), 0) / losses.length;
    if (avgLossBall > 0) possessionRatio = avgWinBall / avgLossBall;
  }

  // 11. Fatigue Resistance % (using distance_5min bins)
  let fatigueResistance = null;
  const sessionResistances = footbarPool
    .map((s) => {
      if (!s.distance_5min || s.distance_5min.length < 4) return null;
      const mid = Math.floor(s.distance_5min.length / 2);
      const firstHalf = s.distance_5min.slice(0, mid);
      const secondHalf = s.distance_5min.slice(mid);
      const dist1 = firstHalf.reduce((sum, b) => sum + b.low + b.normal + b.high, 0);
      const dist2 = secondHalf.reduce((sum, b) => sum + b.low + b.normal + b.high, 0);
      return dist1 > 0 ? (dist2 / dist1) * 100 : null;
    })
    .filter((v): v is number => v !== null);

  if (sessionResistances.length > 0) {
    fatigueResistance = sessionResistances.reduce((a, b) => a + b, 0) / sessionResistances.length;
  }

  // 12. Workrate Win % (Win % when distance > avg)
  let workrateWinPct = null;
  if (footbarPool.length > 0) {
    const avgSeasonDist = totalDistance / footbarPool.length;
    const highWorkrateMatches = footbarPool.filter((s) => (s.distance ?? 0) > avgSeasonDist);
    if (highWorkrateMatches.length > 0) {
      const highWorkrateWins = highWorkrateMatches.filter(
        (s) => matchResults.get(madridDateKey(s.start_date) ?? '') === 'W',
      );
      workrateWinPct = (highWorkrateWins.length / highWorkrateMatches.length) * 100;
    }
  }

  // 13. Luka Modric Score (Composite)
  let modricScore = null;
  if (footbarPool.length > 0) {
    const avgPasses = footbarPool.reduce((sum, s) => sum + (s.pass_count ?? 0), 0) / footbarPool.length;
    const avgDist = totalDistance / 1000 / footbarPool.length;
    const goalsPerGame = ownGoals / (rfafMatches.results.length || 1);
    modricScore = Math.max(0, avgPasses / 5 + avgDist - goalsPerGame * 5);
  }

  // 14. Intensity vs Rank Ratio (Intensity against Top 5 vs Bottom teams)
  let intensityVsRank = null;
  const rankMap = new Map(rfafStandings.results.map((s) => [norm(s.team), s.position]));
  const rankData = footbarPool
    .map((s) => {
      const date = madridDateKey(s.start_date);
      const rfafM = date ? rfafMatches.results.find((m) => m.date === date) : undefined;
      const oppName = rfafM ? (norm(rfafM.home).includes(norm(ownTeamName)) ? rfafM.away : rfafM.home) : '';
      const oppRank = rankMap.get(norm(oppName));
      return oppRank ? { intensity: s.hsr_plus ?? 0, rank: oppRank } : null;
    })
    .filter((v): v is { intensity: number; rank: number } => v !== null);

  if (rankData.length >= 2) {
    const topIntensity = rankData.filter(d => d.rank <= 5).reduce((a, b) => a + b.intensity, 0) / (rankData.filter(d => d.rank <= 5).length || 1);
    const bottomIntensity = rankData.filter(d => d.rank > 10).reduce((a, b) => a + b.intensity, 0) / (rankData.filter(d => d.rank > 10).length || 1);
    if (bottomIntensity > 0) intensityVsRank = topIntensity / bottomIntensity;
  }

  return {
    goal_contribution_pct: goalContribution,
    clutch_factor_pct: clutchFactor,
    discipline_rating: disciplineRating,
    consistency_index: consistencyIndex || null,
    ppg_impact: ppgImpact,
    scorer_percentile: scorerPercentile,
    shot_conversion_pct: shotConversion,
    distance_per_goal_km: distancePerGoal,
    workload_win_vs_loss_ratio: workloadRatio,
    possession_win_ratio: possessionRatio,
    fatigue_resistance_pct: fatigueResistance,
    workrate_win_pct: workrateWinPct,
    luka_modric_score: modricScore,
    intensity_vs_rank_ratio: intensityVsRank,
  };
}

export function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
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
