import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { env } from './env.js';
import './db.js';
import { authRoutes, requireAuth } from './routes/auth.js';
import { playerRoutes } from './routes/players.js';
import { profileRoutes } from './routes/profile.js';
import { publicRfafRoutes, rfafRoutes } from './routes/rfaf.js';
import { sessionRoutes } from './routes/sessions.js';
import { statsRoutes } from './routes/stats.js';
import { startScheduler } from './scheduler.js';

const here = dirname(fileURLToPath(import.meta.url));
const certPath = resolve(here, '..', 'certs', 'cert.pem');
const keyPath = resolve(here, '..', 'certs', 'key.pem');
const httpsOpts =
  existsSync(certPath) && existsSync(keyPath)
    ? { key: readFileSync(keyPath), cert: readFileSync(certPath) }
    : null;

if (!httpsOpts && env.REDIRECT_URI.startsWith('https://')) {
  console.error(
    'REDIRECT_URI uses https:// but no TLS cert was found at backend/certs/.\n' +
      'Run:  npm run cert -w backend\n' +
      'Or set REDIRECT_URI to an http:// URL.',
  );
  process.exit(1);
}

const app = Fastify({ logger: true, ...(httpsOpts ? { https: httpsOpts } : {}) });

app.decorateRequest('userId', null);
app.decorateRequest('playerId', null);

await app.register(cors, {
  origin: env.FRONTEND_ORIGIN,
  credentials: true,
});

await app.register(compress);

await app.register(cookie, {
  secret: env.COOKIE_SECRET,
});

await app.register(authRoutes);
await app.register(playerRoutes);
await app.register(publicRfafRoutes);

// Everything under this plugin requires a signed session cookie; auth routes
// and /health stay public above/below.
await app.register(async (api) => {
  api.addHook('onRequest', requireAuth);
  await api.register(profileRoutes);
  await api.register(sessionRoutes);
  await api.register(statsRoutes);
  await api.register(rfafRoutes);
});

app.get('/health', async () => ({ ok: true }));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (e) {
  app.log.error(e);
  process.exit(1);
}

startScheduler(app.log);
