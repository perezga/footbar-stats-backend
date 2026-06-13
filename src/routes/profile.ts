import type { FastifyInstance } from 'fastify';
import { getProfile } from '../cache/profile.js';

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { refresh?: string } }>('/api/profile', async (req, reply) => {
    if (!req.playerId) {
      return reply.status(400).send({ error: 'Player context required' });
    }
    if (!req.userId) {
      return reply.status(404).send({ error: 'Profile not found' });
    }
    const force = req.query.refresh === '1';
    return getProfile(req.playerId, req.userId, force);
  });
}
