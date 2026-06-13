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
import { searchPlayers } from '../rfaf/client.js';
import { mapSearchPlayers } from '../rfaf/map.js';

export async function publicRfafRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q: string } }>('/api/rfaf/search', async (req, reply) => {
    const { q } = req.query;
    if (!q) return reply.status(400).send({ error: 'Query parameter "q" is required' });
    const results = await searchPlayers(q);
    return mapSearchPlayers(results);
  });
}

export async function rfafRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/rfaf/seasons', async (req, reply) => {
    if (!req.playerId) return reply.status(400).send({ error: 'Player context required' });
    return getSeasons(req.playerId);
  });

  app.get<{ Querystring: { season?: string } }>('/api/rfaf/standings', async (req, reply) => {
    if (!req.playerId) return reply.status(400).send({ error: 'Player context required' });
    return getStandings(req.playerId, false, req.query.season);
  });

  app.get<{ Querystring: { season?: string } }>('/api/rfaf/scorers', async (req, reply) => {
    if (!req.playerId) return reply.status(400).send({ error: 'Player context required' });
    return getScorers(req.playerId, false, req.query.season);
  });

  app.get<{ Querystring: { season?: string } }>('/api/rfaf/fixtures', async (req, reply) => {
    if (!req.playerId) return reply.status(400).send({ error: 'Player context required' });
    return getFixtures(req.playerId, false, req.query.season);
  });

  app.get<{ Querystring: { player?: string; season?: string } }>(
    '/api/rfaf/player-stats',
    async (req, reply) => {
      if (!req.playerId) return reply.status(400).send({ error: 'Player context required' });
      return getPlayerStats(req.playerId, false, req.query.player, req.query.season);
    },
  );

  app.post<{ Querystring: { season?: string } }>('/api/rfaf/refresh', async (req, reply) => {
    if (!req.playerId) return reply.status(400).send({ error: 'Player context required' });
    await refreshAll(req.playerId, req.query.season);
    invalidateFixtureIndex(req.playerId);
    return { ok: true };
  });
}
