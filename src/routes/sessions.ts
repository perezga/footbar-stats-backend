import type { FastifyInstance } from 'fastify';
import {
  buildFixtureIndex,
  combineLegRows,
  type DayFixture,
  enrichSession,
  type FixtureIndex,
  type FixtureOnlySession,
  fixtureOnlySession,
  madridDateKey,
} from '../cache/fixtureLink.js';
import {
  ensureListFresh,
  getLastSync,
  getSessionDetail,
  listAllSessions,
  listSessions,
  refreshSessionDetail,
} from '../cache/sessions.js';
import { db } from '../db.js';
import type { MatchType } from '../footbar/types.js';

/** Build the fixture index, tolerating RFAF being slow/unavailable. */
async function safeFixtureIndex(
  app: FastifyInstance,
  playerId: number,
): Promise<FixtureIndex> {
  try {
    return await buildFixtureIndex(playerId);
  } catch (e) {
    app.log.warn(
      { err: e },
      `fixture enrichment skipped for player ${playerId}: RFAF fetch failed`,
    );
    return { byDate: new Map(), all: [] };
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
    if (!req.playerId) {
      return reply.status(400).send({ error: 'Player context required' });
    }

    if (req.userId) {
      await ensureListFresh(req.playerId, req.userId);
    }

    const q = req.query;
    const matchType =
      q.match_type && MATCH_TYPES.has(q.match_type as MatchType)
        ? (q.match_type as MatchType)
        : undefined;

    const index = await safeFixtureIndex(app, req.playerId);
    const player = db.prepare('SELECT rfaf_own_team FROM players WHERE id = ?').get(req.playerId) as
      | { rfaf_own_team: string }
      | undefined;
    const ownTeamName = player?.rfaf_own_team ?? '';

    if (q.include_fixtures === '1') {
      // Merged view: every session plus the season's fixtures the tracker
      // didn't record (id null), one date-sorted paginated feed.
      const sessions = req.userId
        ? listAllSessions(req.userId, matchType).map((s) =>
            enrichSession(s, index.byDate, ownTeamName),
          )
        : [];
      const rows: ((typeof sessions)[number] | FixtureOnlySession)[] = [...sessions];
      if (!matchType || matchType === '11') {
        const sessionDays = new Set(
          sessions.filter((s) => s.match_type === '11').map((s) => madridDateKey(s.start_date)),
        );
        for (const day of index.all) {
          const date = day.fixture.date;
          if (!date || !sessionDays.has(date)) rows.push(fixtureOnlySession(date, day, ownTeamName));
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
        last_sync: req.userId ? getLastSync(req.userId) : 0,
      };
    }

    if (!req.userId) {
      return { count: 0, results: [], last_sync: 0 };
    }

    const page = listSessions({
      footbarUserId: req.userId,
      matchType,
      from: q.from,
      to: q.to,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
    return { ...page, results: page.results.map((s) => enrichSession(s, index.byDate, ownTeamName)) };
  });

  app.post('/api/sessions/refresh', async (req, reply) => {
    if (!req.playerId) return reply.status(400).send({ error: 'Player context required' });
    if (!req.userId) return { ok: true, last_sync: 0 };
    await ensureListFresh(req.playerId, req.userId, true);
    return { ok: true, last_sync: getLastSync(req.userId) };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    if (!req.playerId) return reply.status(400).send({ error: 'Player context required' });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      reply.code(400);
      return { error: 'Invalid id' };
    }
    if (!req.userId) return reply.status(404).send({ error: 'Session not found' });
    const detail = await getSessionDetail(req.playerId, id, req.userId);
    const index = await safeFixtureIndex(app, req.playerId);
    const player = db.prepare('SELECT rfaf_own_team FROM players WHERE id = ?').get(req.playerId) as
      | { rfaf_own_team: string }
      | undefined;
    const ownTeamName = player?.rfaf_own_team ?? '';
    return enrichSession(detail, index.byDate, ownTeamName);
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/refresh', async (req, reply) => {
    if (!req.playerId) return reply.status(400).send({ error: 'Player context required' });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      reply.code(400);
      return { error: 'Invalid id' };
    }
    if (!req.userId) return reply.status(404).send({ error: 'Session not found' });
    const detail = await refreshSessionDetail(req.playerId, id, req.userId);
    const index = await safeFixtureIndex(app, req.playerId);
    const player = db.prepare('SELECT rfaf_own_team FROM players WHERE id = ?').get(req.playerId) as
      | { rfaf_own_team: string }
      | undefined;
    const ownTeamName = player?.rfaf_own_team ?? '';
    return enrichSession(detail, index.byDate, ownTeamName);
  });
}
