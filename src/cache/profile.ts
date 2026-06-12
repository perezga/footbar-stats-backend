import { db } from '../db.js';
import { fetchProfile } from '../footbar/client.js';
import type { ProfileAPI } from '../footbar/types.js';
import { tryParse } from '../util/json.js';

const TTL_MS = 24 * 60 * 60 * 1000;

interface ProfileRow {
  app_user_id: number;
  data: string;
  fetched_at: number;
}

export async function getProfile(appUserId: number, force = false): Promise<ProfileAPI | null> {
  const row = db
    .prepare('SELECT data, fetched_at FROM footbar_profiles WHERE app_user_id = ?')
    .get(appUserId) as ProfileRow | undefined;

  if (!force && row && Date.now() - row.fetched_at < TTL_MS) {
    const cached = tryParse<ProfileAPI>(row.data);
    if (cached) return cached;
  }

  // We need the Footbar user_id to fetch the profile.
  const link = db
    .prepare('SELECT footbar_user_id FROM footbar_links WHERE app_user_id = ?')
    .get(appUserId) as { footbar_user_id: number } | undefined;
  if (!link) return null;

  try {
    const fresh = await fetchProfile(link.footbar_user_id, appUserId);
    db.prepare(
      `INSERT INTO footbar_profiles (app_user_id, data, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(app_user_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
    ).run(appUserId, JSON.stringify(fresh), Date.now());
    return fresh;
  } catch (e) {
    // If we have a cached version, return it even if expired, if fetch fails.
    if (row) {
      const cached = tryParse<ProfileAPI>(row.data);
      if (cached) return cached;
    }
    throw e;
  }
}

export function deleteProfile(appUserId: number): void {
  db.prepare('DELETE FROM footbar_profiles WHERE app_user_id = ?').run(appUserId);
}
