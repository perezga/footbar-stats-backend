import { db } from '../db.js';
import { env, FOOTBAR_BASE } from '../env.js';

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user_id: number; // This is the FOOTBAR user_id
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

export function loadTokens(appUserId?: number): StoredTokens | null {
  if (appUserId === undefined) {
    // Return the first one available if no user specified (headless/admin)
    const row = db
      .prepare(
        'SELECT access_token, refresh_token, expires_at, footbar_user_id as user_id, scope FROM footbar_links LIMIT 1',
      )
      .get() as StoredTokens | undefined;
    return row ?? null;
  }
  const row = db
    .prepare(
      'SELECT access_token, refresh_token, expires_at, footbar_user_id as user_id, scope FROM footbar_links WHERE app_user_id = ?',
    )
    .get(appUserId) as StoredTokens | undefined;
  return row ?? null;
}

export function saveTokens(t: StoredTokens, appUserId: number): void {
  db.prepare(
    `INSERT INTO footbar_links (app_user_id, footbar_user_id, access_token, refresh_token, expires_at, scope)
     VALUES (?, @user_id, @access_token, @refresh_token, @expires_at, @scope)
     ON CONFLICT(app_user_id) DO UPDATE SET
       footbar_user_id = excluded.footbar_user_id,
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       scope = excluded.scope`,
  ).run(appUserId, t);
}

export function clearTokens(appUserId: number): void {
  db.prepare('DELETE FROM footbar_links WHERE app_user_id = ?').run(appUserId);
}

function tokenToStored(resp: TokenResponse, footbarUserId?: number): StoredTokens {
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_at: Date.now() + resp.expires_in * 1000 - 60_000,
    // Password grants don't echo the user; keep the id from a previous login or the requested one.
    user_id: resp.user?.id ?? footbarUserId ?? 0,
    scope: resp.scope,
  };
}

export async function exchangeAuthCode(params: {
  code: string;
  code_verifier: string;
  appUserId: number;
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
  const stored = tokenToStored(json);
  saveTokens(stored, params.appUserId);
  return stored;
}

export async function refreshAccessToken(
  refreshToken: string,
  appUserId: number,
  footbarUserId: number,
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
  const stored = tokenToStored(json, footbarUserId);
  saveTokens(stored, appUserId);
  return stored;
}

/**
 * Headless login with the configured Footbar account (OAuth password grant).
 * Does NOT link to an internal user automatically.
 */
export async function loginWithPassword(): Promise<StoredTokens> {
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
  const stored = tokenToStored(json);
  return stored;
}

export async function getValidAccessToken(appUserId?: number): Promise<StoredTokens> {
  const tokens = loadTokens(appUserId);
  if (!tokens) {
    if (appUserId === undefined) return loginWithPassword();
    throw new Error(`Footbar not linked for user ${appUserId}`);
  }
  if (Date.now() < tokens.expires_at) return tokens;

  try {
    return await refreshAccessToken(tokens.refresh_token, appUserId!, tokens.user_id);
  } catch (e) {
    if (appUserId === undefined || loadTokens()?.user_id === tokens.user_id) {
      return loginWithPassword();
    }
    throw e;
  }
}
