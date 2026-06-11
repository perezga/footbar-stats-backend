import { db } from '../db.js';
import { fetchProfile } from '../footbar/client.js';
import type { ProfileAPI } from '../footbar/types.js';
import { tryParse } from '../util/json.js';

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
    // A corrupt cached profile counts as a miss and is re-fetched below.
    const cached = tryParse<ProfileAPI>(row.data);
    if (cached) return cached;
  }
  const fresh = await fetchProfile(userId);
  db.prepare(
    `INSERT INTO profile (user_id, data, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
  ).run(userId, JSON.stringify(fresh), Date.now());
  return fresh;
}
