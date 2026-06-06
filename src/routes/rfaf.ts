import type { FastifyInstance } from 'fastify';
import { getFixtures, getScorers, getStandings, refreshAll } from '../cache/rfaf.js';
import { currentUserId } from './auth.js';

export async function rfafRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/rfaf/standings', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    return getStandings();
  });

  app.get('/api/rfaf/scorers', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    return getScorers();
  });

  app.get('/api/rfaf/fixtures', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    return getFixtures();
  });

  app.post('/api/rfaf/refresh', async (req, reply) => {
    if (currentUserId(req) === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    await refreshAll();
    return { ok: true };
  });
}
