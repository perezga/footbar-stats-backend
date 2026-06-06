import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  // RFAF league/competition identifiers (defaults track ATLÉTICO ESTACIÓN "A").
  RFAF_COD_PRIMARIA_CLASIF: z.string().default('1000120'),
  RFAF_COD_PRIMARIA_GRUPO: z.string().default('1000123'),
  RFAF_CODCOMPETICION: z.string().default('44788581'),
  RFAF_CODGRUPO: z.string().default('46734797'),
  RFAF_CODEQUIPO: z.coerce.number().int().positive().default(817922),
  /** Substring used to flag the tracked player in the scorers table. */
  RFAF_OWN_PLAYER: z.string().default('PEREZ GARCIA, ERIK'),
  /** Team name used to decide which side of a fixture is ours. */
  RFAF_OWN_TEAM: z.string().default('ATLETICO ESTACION'),
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
