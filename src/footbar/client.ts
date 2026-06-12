import { db } from '../db.js';
import { FOOTBAR_BASE } from '../env.js';
import { getValidAccessToken, loadTokens, refreshAccessToken } from '../oauth/tokens.js';
import type { PaginatedSessionList, ProfileAPI, SessionAPI } from './types.js';

class FootbarError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, appUserId: number, attempt = 0): Promise<T> {
  const tokens = await getValidAccessToken(appUserId);
  const res = await fetch(`${FOOTBAR_BASE}${path}`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (res.status === 401 && attempt === 0) {
    const current = loadTokens(appUserId);
    if (current) {
      await refreshAccessToken(current.refresh_token, appUserId, current.user_id);
    }
    return call<T>(path, appUserId, 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new FootbarError(res.status, `Footbar ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function fetchProfile(footbarUserId: number, appUserId: number): Promise<ProfileAPI> {
  const page = await call<{ results: ProfileAPI[] }>(
    `/v1/profile/detail/?user_id=${footbarUserId}`,
    appUserId,
  );
  const profile = page.results[0];
  if (!profile) throw new FootbarError(404, `Profile ${footbarUserId} not found`);
  return profile;
}

export function fetchSessionList(appUserId: number): Promise<PaginatedSessionList> {
  return call<PaginatedSessionList>('/v1/session/list/', appUserId);
}

export async function fetchSessionDetail(id: number, appUserId: number): Promise<SessionAPI> {
  const page = await call<{ results: SessionAPI[] }>(`/v1/session/detail/?id=${id}`, appUserId);
  const session = page.results[0];
  if (!session) throw new FootbarError(404, `Session ${id} not found`);
  return session;
}

export { FootbarError };
