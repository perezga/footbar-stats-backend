import { db } from '../db.js';
import type { SessionAPI } from '../footbar/types.js';

export interface RecordEntry {
  metric: string;
  value: number;
  session_id: number;
  session_title: string;
  start_date: string;
}

interface DetailRow {
  detail_data: string;
}

function allDetails(matchType?: string): SessionAPI[] {
  const rows = (
    matchType
      ? db
          .prepare(
            'SELECT detail_data FROM sessions WHERE detail_data IS NOT NULL AND match_type = ?',
          )
          .all(matchType)
      : db.prepare('SELECT detail_data FROM sessions WHERE detail_data IS NOT NULL').all()
  ) as DetailRow[];
  return rows.map((r) => JSON.parse(r.detail_data) as SessionAPI);
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
  | 'hsr_plus';

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
];

export interface TrendPoint {
  session_id: number;
  start_date: string;
  title: string;
  value: number;
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
    value: ((s as unknown as Record<string, number>)[metric]) ?? 0,
  }));
}
