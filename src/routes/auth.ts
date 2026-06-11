import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { env, FOOTBAR_BASE } from '../env.js';
import { challengeFromVerifier, generateCodeVerifier, generateState } from '../oauth/pkce.js';
import { clearTokens, exchangeAuthCode, getValidAccessToken, loadTokens } from '../oauth/tokens.js';

const SESSION_COOKIE = 'sid';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const STATE_TTL_MS = 10 * 60 * 1000;

function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

function setSessionCookie(reply: import('fastify').FastifyReply, sid: string): void {
  reply.setCookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
    signed: true,
  });
}

export function currentUserId(req: import('fastify').FastifyRequest): number | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const row = db
    .prepare('SELECT user_id FROM app_sessions WHERE sid = ?')
    .get(unsigned.value) as { user_id: number } | undefined;
  return row?.user_id ?? null;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/login', async (req, reply) => {
    // Headless first: when the backend already holds valid Footbar tokens (or
    // can mint them with FOOTBAR_USERNAME/PASSWORD), the app session can be
    // created directly — no Footbar OAuth page in the browser.
    try {
      const tokens = await getValidAccessToken();
      if (tokens.user_id) {
        const sid = newSessionId();
        db.prepare(
          'INSERT INTO app_sessions (sid, user_id, created_at) VALUES (?, ?, ?)',
        ).run(sid, tokens.user_id, Date.now());
        setSessionCookie(reply, sid);
        reply.redirect(env.FRONTEND_ORIGIN + '/');
        return;
      }
    } catch (e) {
      req.log.warn(e, 'headless login unavailable, falling back to browser OAuth');
    }

    const verifier = generateCodeVerifier();
    const challenge = challengeFromVerifier(verifier);
    const state = generateState();
    db.prepare(
      'INSERT INTO oauth_state (state, code_verifier, created_at) VALUES (?, ?, ?)',
    ).run(state, verifier, Date.now());

    db.prepare('DELETE FROM oauth_state WHERE created_at < ?').run(Date.now() - STATE_TTL_MS);

    const url = new URL(`${FOOTBAR_BASE}/oauth/authorize/`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', env.FOOTBAR_CLIENT_ID);
    url.searchParams.set('redirect_uri', env.REDIRECT_URI);
    url.searchParams.set('scope', 'read');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/callback',
    async (req, reply) => {
      const { code, state, error } = req.query;
      if (error) {
        reply.code(400).type('text/plain').send(`OAuth error: ${error}`);
        return;
      }
      if (!code || !state) {
        reply.code(400).type('text/plain').send('Missing code or state');
        return;
      }
      const row = db
        .prepare('SELECT code_verifier, created_at FROM oauth_state WHERE state = ?')
        .get(state) as { code_verifier: string; created_at: number } | undefined;
      if (!row) {
        reply.code(400).type('text/plain').send('Unknown state');
        return;
      }
      db.prepare('DELETE FROM oauth_state WHERE state = ?').run(state);
      if (Date.now() - row.created_at > STATE_TTL_MS) {
        reply.code(400).type('text/plain').send('State expired');
        return;
      }

      try {
        const tokens = await exchangeAuthCode({ code, code_verifier: row.code_verifier });
        const sid = newSessionId();
        db.prepare(
          'INSERT INTO app_sessions (sid, user_id, created_at) VALUES (?, ?, ?)',
        ).run(sid, tokens.user_id, Date.now());
        setSessionCookie(reply, sid);
        reply.redirect(env.FRONTEND_ORIGIN + '/');
      } catch (e) {
        req.log.error(e);
        reply.code(500).type('text/plain').send('Token exchange failed');
      }
    },
  );

  app.get('/auth/status', async (req, reply) => {
    let userId = currentUserId(req);
    let tokens = loadTokens();
    if (userId === null || tokens === null || tokens.user_id !== userId) {
      // Auto-provision the browser session: the scheduler keeps server-side
      // Footbar tokens alive, so a visitor with no (or a stale) cookie can be
      // signed in on this very response — the login page never shows.
      try {
        tokens = await getValidAccessToken();
        if (tokens.user_id) {
          const sid = newSessionId();
          db.prepare(
            'INSERT INTO app_sessions (sid, user_id, created_at) VALUES (?, ?, ?)',
          ).run(sid, tokens.user_id, Date.now());
          setSessionCookie(reply, sid);
          userId = tokens.user_id;
        }
      } catch (e) {
        req.log.warn(e, 'auto-login unavailable, manual login required');
      }
    }
    return {
      authenticated: userId !== null && tokens !== null && tokens.user_id === userId,
      user_id: userId,
    };
  });

  app.post('/auth/logout', async (req, reply) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        db.prepare('DELETE FROM app_sessions WHERE sid = ?').run(unsigned.value);
      }
    }
    clearTokens();
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
