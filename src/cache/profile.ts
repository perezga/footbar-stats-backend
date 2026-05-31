import { db } from '../db.js';
import { fetchProfile } from '../footbar/client.js';
import type { ProfileAPI } from '../footbar/types.js';

const TTL_MS = 24 * 60 * 60 * 1000;

interface ProfileRow {
  user_id: number;
  data: string;
  fetched_at: number;
}

export async function getProfile(userId: number, force = false): Promise<ProfileAPI> {
  const row = db
    .prepare('SELECT user_id, data, fetched_at FROM profile WHERE user_id = ?')
    .get(userId) as ProfileRow | undefined;
  if (!force && row && Date.now() - row.fetched_at < TTL_MS) {
    return JSON.parse(row.data) as ProfileAPI;
  }
  const fresh = await fetchProfile(userId);
  db.prepare(
    `INSERT INTO profile (user_id, data, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
  ).run(userId, JSON.stringify(fresh), Date.now());
  return fresh;
}
