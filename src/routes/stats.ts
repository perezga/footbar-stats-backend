import type { FastifyInstance } from 'fastify';
import {
  computeAdvancedMetrics,
  computeAverages,
  computeGoalsRecord,
  computeGoalsTrend,
  computeLevel,
  computeRecords,
  computeTrend,
  TREND_METRICS,
  type TrendMetric,
} from '../cache/derive.js';
import { ensureListFresh } from '../cache/sessions.js';
import type { MatchType } from '../footbar/types.js';

const MATCH_TYPES = new Set<MatchType>(['11', 'ss', 'tr', 'ru']);

function parseMatchType(raw?: string): MatchType | undefined {
  return raw && MATCH_TYPES.has(raw as MatchType) ? (raw as MatchType) : undefined;
}

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { match_type?: string; refresh?: string } }>(
    '/api/stats/records',
    async (req, reply) => {
      if (!req.playerId) {
        return reply.status(400).send({ error: 'Player context required' });
      }
      const matchType = parseMatchType(req.query.match_type);
      if (req.userId && req.query.refresh === '1') {
        await ensureListFresh(req.playerId, req.userId, true);
      }
      const records = req.userId ? computeRecords(req.userId, matchType) : [];
      // Goals come from RFAF match events, so they only exist for league games.
      if (!matchType || matchType === '11') {
        const goals = await computeGoalsRecord(req.playerId, req.userId ?? 0);
        if (goals) records.push(goals);
      }
      return { match_type: matchType ?? null, records };
    },
  );

  app.get<{
    Querystring: { metric?: string; limit?: string; match_type?: string; refresh?: string };
  }>('/api/stats/trends', async (req, reply) => {
    if (!req.playerId) {
      return reply.status(400).send({ error: 'Player context required' });
    }
    const metric = req.query.metric as TrendMetric | 'goals' | undefined;
    if (!metric || (metric !== 'goals' && !TREND_METRICS.includes(metric))) {
      reply.code(400);
      return { error: 'Invalid metric', allowed: [...TREND_METRICS, 'goals'] };
    }
    if (req.userId && req.query.refresh === '1') {
      await ensureListFresh(req.playerId, req.userId, true);
    }
    const limit = req.query.limit ? Number(req.query.limit) : 30;
    const matchType = parseMatchType(req.query.match_type);
    if (metric === 'goals') {
      // Goals come from RFAF match events, so they only exist for league games.
      const points =
        matchType && matchType !== '11'
          ? []
          : await computeGoalsTrend(req.playerId, req.userId ?? 0, limit);
      return { metric, match_type: matchType ?? null, points };
    }
    if (!req.userId) {
      return { metric, match_type: matchType ?? null, points: [] };
    }
    return {
      metric,
      match_type: matchType ?? null,
      points: computeTrend(req.userId, metric, limit, matchType),
    };
  });

  // Player level derived from the last matches (see computeLevel).
  app.get('/api/stats/level', async (req, reply) => {
    if (!req.playerId) {
      return reply.status(400).send({ error: 'Player context required' });
    }
    return computeLevel(req.playerId, req.userId ?? 0);
  });

  app.get<{ Querystring: { match_type?: string; exclude?: string; window?: string } }>(
    '/api/stats/averages',
    async (req, reply) => {
      if (!req.playerId) {
        return reply.status(400).send({ error: 'Player context required' });
      }
      const matchType = parseMatchType(req.query.match_type);
      const exclude = Number(req.query.exclude);
      const window = Math.min(
        Math.max(req.query.window ? Number(req.query.window) || 10 : 10, 1),
        100,
      );

      if (!req.userId) {
        return { match_type: matchType ?? null, window, count: 0, averages: {} };
      }

      const result = computeAverages(
        req.userId,
        matchType,
        Number.isFinite(exclude) ? exclude : undefined,
        window,
      );
      return { match_type: matchType ?? null, window, ...result };
    },
  );

  app.get('/api/stats/advanced', async (req, reply) => {
    if (!req.playerId) {
      return reply.status(400).send({ error: 'Player context required' });
    }
    return computeAdvancedMetrics(req.playerId, req.userId ?? 0);
  });
}
