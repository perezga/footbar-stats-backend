import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const dotenvPath = resolve(here, '..', '.env');
if (existsSync(dotenvPath)) {
  loadDotenv({ path: dotenvPath });
}

const Env = z.object({
  FOOTBAR_CLIENT_ID: z.string().min(1, 'FOOTBAR_CLIENT_ID is required'),
  FOOTBAR_CLIENT_SECRET: z.string().min(1, 'FOOTBAR_CLIENT_SECRET is required'),
  REDIRECT_URI: z.string().url().default('https://localhost:4000/auth/callback'),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:5173'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('127.0.0.1'),
  COOKIE_SECRET: z.string().min(16, 'COOKIE_SECRET must be at least 16 chars'),

  // Footbar account for the background sync: lets the scheduler log in
  // headlessly (OAuth password grant) when no browser-login tokens exist.
  FOOTBAR_USERNAME: z.string().default(''),
  FOOTBAR_PASSWORD: z.string().default(''),
  /** Background sync cadence in hours; 0 disables the scheduler. */
  SYNC_INTERVAL_HOURS: z.coerce.number().min(0).default(24),

  // Universo RFAF (www.universorfaf.es) account used to fetch league data.
  RFAF_USERNAME: z.string().min(1, 'RFAF_USERNAME is required'),
  RFAF_PASSWORD: z.string().min(1, 'RFAF_PASSWORD is required'),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(
    `Missing or invalid environment variables:\n${issues}\n\n` +
      'Set them in your shell, for example:\n' +
      '  export FOOTBAR_CLIENT_ID=…\n' +
      '  export FOOTBAR_CLIENT_SECRET=…\n' +
      '  export COOKIE_SECRET=$(openssl rand -hex 32)\n',
  );
  process.exit(1);
}

export const env = parsed.data;
export const FOOTBAR_BASE = 'https://api.footbar.com';
