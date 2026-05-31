import type { FastifyInstance } from 'fastify';
import { getProfile } from '../cache/profile.js';
import { currentUserId } from './auth.js';

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { refresh?: string } }>('/api/profile', async (req, reply) => {
    const userId = currentUserId(req);
    if (userId === null) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    const force = req.query.refresh === '1';
    return getProfile(userId, force);
  });
}
