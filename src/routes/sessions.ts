import type { FastifyInstance } from 'fastify';
import {
  buildFixtureIndex,
  combineLegRows,
  enrichSession,
  fixtureOnlySession,
  madridDateKey,
  type DayFixture,
  type FixtureOnlySession,
} from '../cache/fixtureLink.js';
import {
  ensureListFresh,
  getLastSync,
  getSessionDetail,
  listAllSessions,
  listSessions,
  refreshSessionDetail,
} from '../cache/sessions.js';
import type { MatchType } from '../footbar/types.js';
import { currentUserId } from './auth.js';

/** Build the fixture index, tolerating RFAF being slow/unavailable. */
async function safeFixtureIndex(app: FastifyInstance): Promise<Map<string, DayFixture>> {
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
      include_fixtures?: string;
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
    const index = await safeFixtureIndex(app);

    if (q.include_fixtures === '1') {
      // Merged view: every session plus the season's fixtures the tracker
      // didn't record (id null), one date-sorted paginated feed.
      const sessions = listAllSessions(matchType).map((s) => enrichSession(s, index));
      const rows: ((typeof sessions)[number] | FixtureOnlySession)[] = [...sessions];
      if (!matchType || matchType === '11') {
        const sessionDays = new Set(
          sessions.filter((s) => s.match_type === '11').map((s) => madridDateKey(s.start_date)),
        );
        for (const [date, day] of index) {
          if (!sessionDays.has(date)) rows.push(fixtureOnlySession(date, day));
        }
      }
      rows.sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
      // One line per opponent: both league legs collapse into the kept row.
      const combined = combineLegRows(rows);
      const limit = Math.min(q.limit ? Number(q.limit) : 50, 200);
      const offset = q.offset ? Number(q.offset) : 0;
      return {
        count: combined.length,
        results: combined.slice(offset, offset + limit),
        last_sync: getLastSync(),
      };
    }

    const page = listSessions({
      matchType,
      from: q.from,
      to: q.to,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
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
