import { defineConfig } from 'vitest/config';

// Importing almost any module pulls in env.ts (which exits on missing vars)
// and db.ts (which opens the SQLite file), so give tests dummies for the
// required env vars and a throwaway database.
export default defineConfig({
  test: {
    env: {
      FOOTBAR_CLIENT_ID: 'test-client-id',
      FOOTBAR_CLIENT_SECRET: 'test-client-secret',
      COOKIE_SECRET: 'test-cookie-secret-0123456789',
      RFAF_USERNAME: 'test-user',
      RFAF_PASSWORD: 'test-password',
      DB_PATH: '/tmp/footbar-test.db',
    },
  },
});
