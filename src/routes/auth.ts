import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { env, FOOTBAR_BASE } from '../env.js';
import { challengeFromVerifier, generateCodeVerifier, generateState } from '../oauth/pkce.js';
import { clearTokens, exchangeAuthCode, getValidAccessToken, loadTokens } from '../oauth/tokens.js';
import { hashPassword, verifyPassword } from '../util/password.js';

const SESSION_COOKIE = 'sid';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const STATE_TTL_MS = 10 * 60 * 1000;

const SignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  nickname: z.string().optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

function setSessionCookie(reply: FastifyReply, sid: string): void {
  reply.setCookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
    signed: true,
  });
}

/** Returns the internal app user_id or null. */
export function currentUserId(req: FastifyRequest): number | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const row = db.prepare('SELECT user_id FROM app_sessions WHERE sid = ?').get(unsigned.value) as
    | { user_id: number }
    | undefined;
  return row?.user_id ?? null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireAuth; non-null in every route registered behind it. */
    userId: number | null;
  }
}

/** onRequest hook for the protected /api scope: 401s anonymous requests. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = currentUserId(req);
  if (userId === null) {
    await reply.code(401).send({ error: 'Not authenticated' });
    return;
  }
  req.userId = userId;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // --- Internal Identity Auth ---

  app.post('/auth/signup', async (req, reply) => {
    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid signup data', details: parsed.error.format() };
    }
    const { email, password, nickname } = parsed.data;
    const password_hash = hashPassword(password);

    try {
      const res = db
        .prepare(
          'INSERT INTO users (email, password_hash, nickname, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(email, password_hash, nickname ?? null, Date.now());

      const appUserId = res.lastInsertRowid as number;
      const sid = newSessionId();
      db.prepare('INSERT INTO app_sessions (sid, user_id, created_at) VALUES (?, ?, ?)').run(
        sid,
        appUserId,
        Date.now(),
      );
      setSessionCookie(reply, sid);
      return { ok: true, user_id: appUserId };
    } catch (e: any) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        reply.code(409);
        return { error: 'Email already exists' };
      }
      throw e;
    }
  });

  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid login data' };
    }
    const { email, password } = parsed.data;
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email) as
      | { id: number; password_hash: string }
      | undefined;

    if (!user || !verifyPassword(password, user.password_hash)) {
      reply.code(401);
      return { error: 'Invalid email or password' };
    }

    const sid = newSessionId();
    db.prepare('INSERT INTO app_sessions (sid, user_id, created_at) VALUES (?, ?, ?)').run(
      sid,
      user.id,
      Date.now(),
    );
    setSessionCookie(reply, sid);
    return { ok: true, user_id: user.id };
  });

  // --- Footbar Linking (OAuth) ---

  app.get('/auth/footbar/link', async (req, reply) => {
    const appUserId = currentUserId(req);
    if (!appUserId) {
      reply.code(401);
      return { error: 'Log in to the app before linking Footbar' };
    }

    const verifier = generateCodeVerifier();
    const challenge = challengeFromVerifier(verifier);
    const state = generateState();
    db.prepare('INSERT INTO oauth_state (state, code_verifier, created_at) VALUES (?, ?, ?)').run(
      state,
      verifier,
      Date.now(),
    );

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

      // Check if we have an active app session to link to.
      const appUserId = currentUserId(req);
      if (!appUserId) {
        // Alternative: Auto-create an internal user from Footbar ID (Login with Footbar)
        // For now, require internal login first for simplicity as per design.
        reply
          .code(401)
          .type('text/plain')
          .send('No active app session found. Please log in to Footbar Stats first.');
        return;
      }

      try {
        await exchangeAuthCode({ code, code_verifier: row.code_verifier, appUserId });
        reply.redirect(`${env.FRONTEND_ORIGIN}/profile`);
      } catch (e) {
        req.log.error(e);
        reply.code(500).type('text/plain').send('Token exchange failed');
      }
    },
  );

  app.get('/auth/status', async (req, _reply) => {
    const appUserId = currentUserId(req);
    const user = appUserId
      ? (db.prepare('SELECT email, nickname FROM users WHERE id = ?').get(appUserId) as
          | { email: string; nickname: string | null }
          | undefined)
      : null;

    const footbarLink = appUserId
      ? db.prepare('SELECT footbar_user_id FROM footbar_links WHERE app_user_id = ?').get(appUserId)
      : null;
    const rfafLink = appUserId
      ? db.prepare('SELECT rfaf_player_id FROM rfaf_links WHERE app_user_id = ?').get(appUserId)
      : null;

    return {
      authenticated: appUserId !== null && user !== undefined,
      user: user
        ? {
            id: appUserId,
            email: user.email,
            nickname: user.nickname,
          }
        : null,
      links: {
        footbar: !!footbarLink,
        rfaf: !!rfafLink,
      },
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
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/auth/footbar/unlink', async (req, reply) => {
    const appUserId = currentUserId(req);
    if (appUserId) {
      clearTokens(appUserId);
      db.prepare('DELETE FROM footbar_profiles WHERE app_user_id = ?').run(appUserId);
      db.prepare('DELETE FROM footbar_sessions WHERE app_user_id = ?').run(appUserId);
    }
    return { ok: true };
  });
}
