import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { syncPlayerConfig } from '../cache/rfaf.js';

export async function playerRoutes(app: FastifyInstance): Promise<void> {
  // List all players
  app.get('/api/players', async () => {
    return db.prepare('SELECT * FROM players ORDER BY name ASC').all();
  });

  // Create a new player
  app.post<{
    Body: {
      name: string;
      rfaf_player_id?: string;
      rfaf_own_player?: string;
    };
  }>('/api/players', async (req, reply) => {
    const { name, rfaf_player_id, rfaf_own_player } = req.body;
    if (!name) return reply.status(400).send({ error: 'Name is required' });

    const result = db
      .prepare(
        'INSERT INTO players (name, rfaf_player_id, rfaf_own_player, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(name, rfaf_player_id ?? null, rfaf_own_player ?? null, Date.now());

    const playerId = Number(result.lastInsertRowid);

    if (rfaf_player_id) {
      try {
        await syncPlayerConfig(playerId);
      } catch (e) {
        app.log.warn(e, `Initial RFAF sync failed for player ${playerId}`);
      }
    }

    const newPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
    return newPlayer;
  });

  // Get a specific player
  app.get<{ Params: { id: string } }>('/api/players/:id', async (req, reply) => {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
    if (!player) return reply.status(404).send({ error: 'Player not found' });
    return player;
  });

  // Update a player (including RFAF config)
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      rfaf_player_id?: string;
      rfaf_season?: string;
      rfaf_team_id?: number;
      rfaf_group_id?: string;
      rfaf_competition_id?: string;
      rfaf_own_player?: string;
      rfaf_own_team?: string;
    };
  }>('/api/players/:id', async (req, reply) => {
    const fields = Object.entries(req.body)
      .filter(([_, v]) => v !== undefined)
      .map(([k]) => `${k} = @${k}`);

    if (fields.length === 0) return reply.status(400).send({ error: 'No fields to update' });

    const sql = `UPDATE players SET ${fields.join(', ')} WHERE id = @id`;
    const result = db.prepare(sql).run({ ...req.body, id: req.params.id });

    if (result.changes === 0) return reply.status(404).send({ error: 'Player not found' });
    return db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  });

  // Delete a player
  app.delete<{ Params: { id: string } }>('/api/players/:id', async (req, reply) => {
    const result = db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return reply.status(404).send({ error: 'Player not found' });
    return { success: true };
  });
}
