import type { FastifyInstance } from 'fastify';
import { computeRecords, computeTrend, TREND_METRICS, type TrendMetric } from '../cache/derive.js';
import { currentUserId } from './auth.js';

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats/records', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    return { records: computeRecords() };
  });

  app.get<{ Querystring: { metric?: string; limit?: string } }>(
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
      return { metric, points: computeTrend(metric, limit) };
    },
  );
}
