import { env } from '../env.js';

/** Universo RFAF API (the SPA at www.universorfaf.es talks to this). */
const API_BASE = 'https://www.universorfaf.es/api/';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

export class RfafError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Cached bearer token. Minted lazily, re-minted once when a call gets a 401. */
let token: string | null = null;

function toFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** Log in with the configured account and return a bearer token. */
async function login(): Promise<string> {
  const res = await fetch(`${API_BASE}login`, {
    method: 'POST',
    headers: { 'User-Agent': UA },
    body: toFormData({ email: env.RFAF_USERNAME, password: env.RFAF_PASSWORD }),
  });
  if (res.status === 401) throw new RfafError(401, 'Universo RFAF: wrong username or password');
  if (res.status === 403) throw new RfafError(403, 'Universo RFAF: account not allowed to log in');
  if (!res.ok) throw new RfafError(res.status, `Universo RFAF: login failed (${res.status})`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new RfafError(res.status, 'Universo RFAF: login response had no token');
  return body.token;
}

/**
 * POST a FormData body to an API endpoint with the bearer token and return the
 * JSON response. Logs in lazily and retries once if the token has expired.
 */
export async function apiPost(endpoint: string, fields: Record<string, string>): Promise<unknown> {
  token ??= await login();

  let res = await rawPost(endpoint, fields);
  if (res.status === 401) {
    token = await login();
    res = await rawPost(endpoint, fields);
  }

  if (!res.ok) {
    throw new RfafError(res.status, `Universo RFAF ${res.status} for ${endpoint}`);
  }
  return res.json();
}

function rawPost(endpoint: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Authorization: `Bearer ${token}` },
    body: toFormData(fields),
  });
}

/** Profile of the logged-in account; handy to verify the login works. */
export function fetchUser(): Promise<unknown> {
  return apiPost('user', {});
}

/** League table for a group. */
export function fetchClassification(groupId: string): Promise<unknown> {
  return apiPost('novanet/competition/get-classification', {
    id_group: groupId,
    id_round: '',
  });
}

/** Top scorers for a competition/group. */
export function fetchScorers(competitionId: string, groupId: string): Promise<unknown> {
  return apiPost('novanet/competition/get-scorers', {
    id_competition: competitionId,
    id_group: groupId,
  });
}

/** Full season calendar (fixtures + results) for a team. */
export function fetchCalendarTeam(
  competitionId: string,
  groupId: string,
  teamId: string,
): Promise<unknown> {
  return apiPost('novanet/match/get-calendar-team', {
    id_competition: competitionId,
    id_group: groupId,
    id_team: teamId,
  });
}

export function fetchPlayerDetail(playerId: string): Promise<unknown> {
  return apiPost('novanet/player/get-detail-player', { id_player: playerId });
}

export function fetchPlayerGeneralStats(playerId: string, seasonId: string): Promise<unknown> {
  return apiPost('novanet/player/get-player-general-stats', {
    id_player: playerId,
    id_season: seasonId,
  });
}

/**
 * Played matches with the player's per-match events ("partidos jugados").
 * `season` is the label ('2025-2026') or start year — NOT the season id.
 */
export function fetchPlayerMatchs(playerId: string, season: string): Promise<unknown> {
  return apiPost('internal-data/player/matchs', { cod_player: playerId, season });
}

/** Same as fetchPlayerMatchs plus minutes; `season` is the label, not the id. */
export function fetchPlayerMatchsMinutes(playerId: string, season: string): Promise<unknown> {
  return apiPost('internal-data/player/matchs-minutes', {
    cod_player: playerId,
    season,
  });
}
