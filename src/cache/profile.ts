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

export async function getProfile(
  playerId: number,
  footbarUserId: number,
  force = false,
): Promise<ProfileAPI> {
  const row = db
    .prepare(
      'SELECT footbar_user_id as user_id, data, fetched_at FROM profile WHERE footbar_user_id = ?',
    )
    .get(footbarUserId) as ProfileRow | undefined;
  if (!force && row && Date.now() - row.fetched_at < TTL_MS) {
    // A corrupt cached profile counts as a miss and is re-fetched below.
    const cached = tryParse<ProfileAPI>(row.data);
    if (cached) return cached;
  }
  const fresh = await fetchProfile(playerId, footbarUserId);
  db.prepare(
    `INSERT INTO profile (footbar_user_id, data, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(footbar_user_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
  ).run(footbarUserId, JSON.stringify(fresh), Date.now());
  return fresh;
}
