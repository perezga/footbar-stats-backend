import type { FastifyInstance } from 'fastify';
import {
  getFixtures,
  getPlayerStats,
  getScorers,
  getSeasons,
  getStandings,
  refreshAll,
} from '../cache/rfaf.js';
import { currentUserId } from './auth.js';

interface SeasonQuery {
  Querystring: { season?: string };
}

export async function rfafRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/rfaf/seasons', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    return getSeasons();
  });

  app.get<SeasonQuery>('/api/rfaf/standings', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    return getStandings(false, req.query.season);
  });

  app.get<SeasonQuery>('/api/rfaf/scorers', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    return getScorers(false, req.query.season);
  });

  app.get<SeasonQuery>('/api/rfaf/fixtures', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    return getFixtures(false, req.query.season);
  });

  app.get<{ Querystring: { player?: string; season?: string } }>(
    '/api/rfaf/player-stats',
    async (req, reply) => {
      if (currentUserId(req) === null) {
        reply.code(401);
        return { error: 'Not authenticated' };
      }
      return getPlayerStats(false, req.query.player, req.query.season);
    },
  );

  app.post<SeasonQuery>('/api/rfaf/refresh', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    await refreshAll(req.query.season);
    return { ok: true };
  });
}
