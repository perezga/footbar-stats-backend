import type { FastifyInstance } from 'fastify';
import {
  ensureListFresh,
  getLastSync,
  getSessionDetail,
  listSessions,
} from '../cache/sessions.js';
import type { MatchType } from '../footbar/types.js';
import { currentUserId } from './auth.js';

const MATCH_TYPES = new Set<MatchType>(['11', 'ss', 'tr', 'ru']);

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      match_type?: string;
      from?: string;
      to?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/sessions', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    await ensureListFresh(false);
    const q = req.query;
    const matchType =
      q.match_type && MATCH_TYPES.has(q.match_type as MatchType)
        ? (q.match_type as MatchType)
        : undefined;
    return listSessions({
      matchType,
      from: q.from,
      to: q.to,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
  });

  app.post('/api/sessions/refresh', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    await ensureListFresh(true);
    return { ok: true, last_sync: getLastSync() };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      reply.code(400);
      return { error: 'Invalid id' };
    }
    return getSessionDetail(id);
  });
}
