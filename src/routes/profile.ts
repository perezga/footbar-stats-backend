import type { FastifyInstance } from 'fastify';
import { getProfile } from '../cache/profile.js';
import { setRfafPlayerId, getRfafPlayerId } from '../db.js';
import { z } from 'zod';

const LinkRfafSchema = z.object({
  playerId: z.string().min(1),
});

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { refresh?: string } }>('/api/profile', async (req) => {
    const force = req.query.refresh === '1';
    const profile = await getProfile(req.userId!, force);
    const rfafPlayerId = getRfafPlayerId(req.userId!);
    return { ...profile, rfaf_player_id: rfafPlayerId };
  });

  app.post('/api/profile/rfaf', async (req, reply) => {
    const parsed = LinkRfafSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid playerId' };
    }
    setRfafPlayerId(req.userId!, parsed.data.playerId);
    return { ok: true, rfaf_player_id: parsed.data.playerId };
  });
}
