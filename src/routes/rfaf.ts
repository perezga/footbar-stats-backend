import type { FastifyInstance } from 'fastify';
import { invalidateFixtureIndex } from '../cache/fixtureLink.js';
import {
  getFixtures,
  getPlayerStats,
  getScorers,
  getSeasons,
  getStandings,
  refreshAll,
} from '../cache/rfaf.js';
import { getRfafPlayerId } from '../db.js';

interface SeasonQuery {
  Querystring: { season?: string };
}

export async function rfafRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/rfaf/seasons', async (req) => {
    const playerId = getRfafPlayerId(req.userId!) ?? undefined;
    return getSeasons(playerId);
  });

  app.get<SeasonQuery>('/api/rfaf/standings', async (req) => {
    const playerId = getRfafPlayerId(req.userId!) ?? undefined;
    return getStandings(false, req.query.season, playerId);
  });

  app.get<SeasonQuery>('/api/rfaf/scorers', async (req) => {
    const playerId = getRfafPlayerId(req.userId!) ?? undefined;
    return getScorers(false, req.query.season, playerId);
  });

  app.get<SeasonQuery>('/api/rfaf/fixtures', async (req) => {
    const playerId = getRfafPlayerId(req.userId!) ?? undefined;
    return getFixtures(false, req.query.season, playerId);
  });

  app.get<{ Querystring: { player?: string; season?: string } }>(
    '/api/rfaf/player-stats',
    async (req) => {
      const playerId = req.query.player ?? getRfafPlayerId(req.userId!) ?? undefined;
      return getPlayerStats(false, playerId, req.query.season);
    },
  );

  app.post<SeasonQuery>('/api/rfaf/refresh', async (req) => {
    const playerId = getRfafPlayerId(req.userId!) ?? undefined;
    await refreshAll(req.query.season, playerId);
    invalidateFixtureIndex();
    return { ok: true };
  });
}
