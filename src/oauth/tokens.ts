import { db } from '../db.js';
import { env, FOOTBAR_BASE } from '../env.js';

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user_id: number;
  scope: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  /** Present on the auth-code exchange; password grants may omit it. */
  user?: { id: number };
}

export function loadTokens(playerId: number): StoredTokens | null {
  const row = db
    .prepare(
      'SELECT access_token, refresh_token, expires_at, footbar_user_id, scope FROM oauth_tokens WHERE player_id = ?',
    )
    .get(playerId) as (Omit<StoredTokens, 'user_id'> & { footbar_user_id: number }) | undefined;
  if (!row) return null;
  return {
    ...row,
    user_id: row.footbar_user_id,
  };
}

export function saveTokens(playerId: number, t: StoredTokens): void {
  db.prepare(
    `INSERT INTO oauth_tokens (player_id, access_token, refresh_token, expires_at, footbar_user_id, scope)
     VALUES (@player_id, @access_token, @refresh_token, @expires_at, @footbar_user_id, @scope)
     ON CONFLICT(player_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       footbar_user_id = excluded.footbar_user_id,
       scope = excluded.scope`,
  ).run({
    ...t,
    player_id: playerId,
    footbar_user_id: t.user_id,
  });

  // Also update the player record with the footbar_user_id if not already set.
  db.prepare('UPDATE players SET footbar_user_id = ? WHERE id = ? AND footbar_user_id IS NULL').run(
    t.user_id,
    playerId,
  );
}

export function clearTokens(playerId: number): void {
  db.prepare('DELETE FROM oauth_tokens WHERE player_id = ?').run(playerId);
}

function tokenToStored(resp: TokenResponse, playerId: number): StoredTokens {
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_at: Date.now() + resp.expires_in * 1000 - 60_000,
    // Password grants don't echo the user; keep the id from a previous login.
    user_id: resp.user?.id ?? loadTokens(playerId)?.user_id ?? 0,
    scope: resp.scope,
  };
}

export async function exchangeAuthCode(params: {
  code: string;
  code_verifier: string;
  playerId: number;
}): Promise<StoredTokens> {
  const body = new URLSearchParams({
    client_id: env.FOOTBAR_CLIENT_ID,
    client_secret: env.FOOTBAR_CLIENT_SECRET,
    code: params.code,
    code_verifier: params.code_verifier,
    grant_type: 'authorization_code',
    redirect_uri: env.REDIRECT_URI,
    scope: 'read',
  });
  const res = await fetch(`${FOOTBAR_BASE}/oauth/token/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as TokenResponse;
  const stored = tokenToStored(json, params.playerId);
  saveTokens(params.playerId, stored);
  return stored;
}

export async function refreshAccessToken(
  refreshToken: string,
  playerId: number,
): Promise<StoredTokens> {
  const body = new URLSearchParams({
    client_id: env.FOOTBAR_CLIENT_ID,
    client_secret: env.FOOTBAR_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(`${FOOTBAR_BASE}/oauth/token/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Refresh failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as TokenResponse;
  const stored = tokenToStored(json, playerId);
  saveTokens(playerId, stored);
  return stored;
}

/**
 * Headless login with the configured Footbar account (OAuth password grant).
 * Lets the background sync authenticate without a browser OAuth round-trip.
 */
export async function loginWithPassword(playerId: number): Promise<StoredTokens> {
  if (!env.FOOTBAR_USERNAME || !env.FOOTBAR_PASSWORD) {
    throw new Error('Not authenticated (set FOOTBAR_USERNAME/FOOTBAR_PASSWORD for headless login)');
  }
  const body = new URLSearchParams({
    client_id: env.FOOTBAR_CLIENT_ID,
    client_secret: env.FOOTBAR_CLIENT_SECRET,
    grant_type: 'password',
    username: env.FOOTBAR_USERNAME,
    password: env.FOOTBAR_PASSWORD,
    scope: 'read',
  });
  const res = await fetch(`${FOOTBAR_BASE}/oauth/token/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Footbar password login failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as TokenResponse;
  const stored = tokenToStored(json, playerId);
  saveTokens(playerId, stored);
  return stored;
}

export async function getValidAccessToken(playerId: number): Promise<StoredTokens> {
  const tokens = loadTokens(playerId);
  if (!tokens) return loginWithPassword(playerId);
  if (Date.now() < tokens.expires_at) return tokens;
  try {
    return await refreshAccessToken(tokens.refresh_token, playerId);
  } catch (e) {
    // The refresh token can rot (rotation, revocation); re-login if we can.
    if (env.FOOTBAR_USERNAME && env.FOOTBAR_PASSWORD) return loginWithPassword(playerId);
    throw e;
  }
}
