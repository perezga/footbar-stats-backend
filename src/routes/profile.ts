import type { FastifyInstance } from 'fastify';
import { getProfile } from '../cache/profile.js';

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { refresh?: string } }>('/api/profile', async (req) => {
    const force = req.query.refresh === '1';
    return getProfile(req.userId!, force);
  });
}
