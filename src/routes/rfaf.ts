import type { FastifyInstance } from 'fastify';
import {
  getFixtures,
  getPlayerStats,
  getScorers,
  getSeasons,
  getStandings,
  refreshAll,
} from '../cache/rfaf.js';

interface SeasonQuery {
  Querystring: { season?: string };
}

export async function rfafRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/rfaf/seasons', async () => {
    return getSeasons();
  });

  app.get<SeasonQuery>('/api/rfaf/standings', async (req) => {
    return getStandings(false, req.query.season);
  });

  app.get<SeasonQuery>('/api/rfaf/scorers', async (req) => {
    return getScorers(false, req.query.season);
  });

  app.get<SeasonQuery>('/api/rfaf/fixtures', async (req) => {
    return getFixtures(false, req.query.season);
  });

  app.get<{ Querystring: { player?: string; season?: string } }>(
    '/api/rfaf/player-stats',
    async (req) => {
      return getPlayerStats(false, req.query.player, req.query.season);
    },
  );

  app.post<SeasonQuery>('/api/rfaf/refresh', async (req) => {
    await refreshAll(req.query.season);
    return { ok: true };
  });
}
