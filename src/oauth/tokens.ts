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
  user: { id: number };
}

export function loadTokens(): StoredTokens | null {
  const row = db
    .prepare('SELECT access_token, refresh_token, expires_at, user_id, scope FROM oauth_tokens WHERE id = 1')
    .get() as StoredTokens | undefined;
  return row ?? null;
}

export function saveTokens(t: StoredTokens): void {
  db.prepare(
    `INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, user_id, scope)
     VALUES (1, @access_token, @refresh_token, @expires_at, @user_id, @scope)
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       user_id = excluded.user_id,
       scope = excluded.scope`,
  ).run(t);
}

export function clearTokens(): void {
  db.prepare('DELETE FROM oauth_tokens WHERE id = 1').run();
}

function tokenToStored(resp: TokenResponse): StoredTokens {
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_at: Date.now() + resp.expires_in * 1000 - 60_000,
    user_id: resp.user.id,
    scope: resp.scope,
  };
}

export async function exchangeAuthCode(params: {
  code: string;
  code_verifier: string;
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
  saveTokens(stored);
  return stored;
}

export async function refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
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
  const stored = tokenToStored(json);
  saveTokens(stored);
  return stored;
}

export async function getValidAccessToken(): Promise<StoredTokens> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');
  if (Date.now() < tokens.expires_at) return tokens;
  return refreshAccessToken(tokens.refresh_token);
}
