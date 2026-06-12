import type { FastifyInstance } from 'fastify';
import {
  computeAverages,
  computeGoalsRecord,
  computeGoalsTrend,
  computeRecords,
  computeTrend,
  TREND_METRICS,
  type TrendMetric,
} from '../cache/derive.js';
import type { MatchType } from '../footbar/types.js';

const MATCH_TYPES = new Set<MatchType>(['11', 'ss', 'tr', 'ru']);

function parseMatchType(raw?: string): MatchType | undefined {
  return raw && MATCH_TYPES.has(raw as MatchType) ? (raw as MatchType) : undefined;
}

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { match_type?: string } }>('/api/stats/records', async (req) => {
    const matchType = parseMatchType(req.query.match_type);
    const records = computeRecords(matchType);
    // Goals come from RFAF match events, so they only exist for league games.
    if (!matchType || matchType === '11') {
      const goals = await computeGoalsRecord();
      if (goals) records.push(goals);
    }
    return { match_type: matchType ?? null, records };
  });

  app.get<{ Querystring: { metric?: string; limit?: string; match_type?: string } }>(
    '/api/stats/trends',
    async (req, reply) => {
      const metric = req.query.metric as TrendMetric | 'goals' | undefined;
      if (!metric || (metric !== 'goals' && !TREND_METRICS.includes(metric))) {
        reply.code(400);
        return { error: 'Invalid metric', allowed: [...TREND_METRICS, 'goals'] };
      }
      const limit = req.query.limit ? Number(req.query.limit) : 30;
      const matchType = parseMatchType(req.query.match_type);
      if (metric === 'goals') {
        // Goals come from RFAF match events, so they only exist for league games.
        const points = matchType && matchType !== '11' ? [] : await computeGoalsTrend(limit);
        return { metric, match_type: matchType ?? null, points };
      }
      return {
        metric,
        match_type: matchType ?? null,
        points: computeTrend(metric, limit, matchType),
      };
    },
  );

  app.get<{ Querystring: { match_type?: string; exclude?: string; window?: string } }>(
    '/api/stats/averages',
    async (req) => {
      const matchType = parseMatchType(req.query.match_type);
      const exclude = Number(req.query.exclude);
      const window = Math.min(
        Math.max(req.query.window ? Number(req.query.window) || 10 : 10, 1),
        100,
      );
      const result = computeAverages(
        matchType,
        Number.isFinite(exclude) ? exclude : undefined,
        window,
      );
      return { match_type: matchType ?? null, window, ...result };
    },
  );
}
