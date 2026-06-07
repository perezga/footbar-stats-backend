import type { FastifyInstance } from 'fastify';
import { buildFixtureIndex, enrichSession } from '../cache/fixtureLink.js';
import {
  ensureListFresh,
  getLastSync,
  getSessionDetail,
  listSessions,
  refreshSessionDetail,
} from '../cache/sessions.js';
import type { Fixture } from '../rfaf/types.js';
import type { MatchType } from '../footbar/types.js';
import { currentUserId } from './auth.js';

/** Build the fixture index, tolerating RFAF being slow/unavailable. */
async function safeFixtureIndex(app: FastifyInstance): Promise<Map<string, Fixture>> {
  try {
    return await buildFixtureIndex();
  } catch (e) {
    app.log.warn({ err: e }, 'fixture enrichment skipped: RFAF fetch failed');
    return new Map();
  }
}

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
    const page = listSessions({
      matchType,
      from: q.from,
      to: q.to,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
    const index = await safeFixtureIndex(app);
    return { ...page, results: page.results.map((s) => enrichSession(s, index)) };
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
    const detail = await getSessionDetail(id);
    const index = await safeFixtureIndex(app);
    return enrichSession(detail, index);
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/refresh', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      reply.code(400);
      return { error: 'Invalid id' };
    }
    const detail = await refreshSessionDetail(id);
    const index = await safeFixtureIndex(app);
    return enrichSession(detail, index);
  });
}
