import type { FastifyInstance } from 'fastify';
import {
  computeAverages,
  computeRecords,
  computeTrend,
  TREND_METRICS,
  type TrendMetric,
} from '../cache/derive.js';
import type { MatchType } from '../footbar/types.js';
import { currentUserId } from './auth.js';

const MATCH_TYPES = new Set<MatchType>(['11', 'ss', 'tr', 'ru']);

function parseMatchType(raw?: string): MatchType | undefined {
  return raw && MATCH_TYPES.has(raw as MatchType) ? (raw as MatchType) : undefined;
}

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { match_type?: string } }>('/api/stats/records', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    const matchType = parseMatchType(req.query.match_type);
    return { match_type: matchType ?? null, records: computeRecords(matchType) };
  });

  app.get<{ Querystring: { metric?: string; limit?: string; match_type?: string } }>(
    '/api/stats/trends',
    async (req, reply) => {
      if (currentUserId(req) === null) {
        reply.code(401);
        return { error: 'Not authenticated' };
      }
      const metric = req.query.metric as TrendMetric | undefined;
      if (!metric || !TREND_METRICS.includes(metric)) {
        reply.code(400);
        return { error: 'Invalid metric', allowed: TREND_METRICS };
      }
      const limit = req.query.limit ? Number(req.query.limit) : 30;
      const matchType = parseMatchType(req.query.match_type);
      return { metric, match_type: matchType ?? null, points: computeTrend(metric, limit, matchType) };
    },
  );

  app.get<{ Querystring: { match_type?: string; exclude?: string; window?: string } }>(
    '/api/stats/averages',
    async (req, reply) => {
      if (currentUserId(req) === null) {
        reply.code(401);
        return { error: 'Not authenticated' };
      }
      const matchType = parseMatchType(req.query.match_type);
      const exclude = Number(req.query.exclude);
      const window = Math.min(Math.max(req.query.window ? Number(req.query.window) || 10 : 10, 1), 100);
      const result = computeAverages(matchType, Number.isFinite(exclude) ? exclude : undefined, window);
      return { match_type: matchType ?? null, window, ...result };
    },
  );
}
