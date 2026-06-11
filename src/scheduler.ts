import type { FastifyBaseLogger } from 'fastify';
import { invalidateFixtureIndex } from './cache/fixtureLink.js';
import { getProfile } from './cache/profile.js';
import { refreshAll } from './cache/rfaf.js';
import { ensureListFresh, getSessionDetail } from './cache/sessions.js';
import { db, getSyncState, setSyncState } from './db.js';
import { env } from './env.js';
import { loadTokens } from './oauth/tokens.js';

// Background daily sync: pulls Footbar and Universo RFAF data into SQLite so
// the app serves fresh data without any user-triggered fetch. The last run is
// persisted in sync_state, so restarts neither skip nor duplicate a run.

const LAST_RUN_KEY = 'scheduler_last_run';
const LAST_RESULT_KEY = 'scheduler_last_result';
/** How often to check whether a sync is due (also caps startup catch-up lag). */
const CHECK_EVERY_MS = 15 * 60 * 1000;
/** How soon a failed run becomes due again. */
const RETRY_MS = 60 * 60 * 1000;

async function syncFootbar(log: FastifyBaseLogger): Promise<void> {
  await ensureListFresh(true);
  // The app fetches session details lazily; prefetch whatever is missing so
  // records/trends cover every session without anyone opening it first.
  const missing = db.prepare('SELECT id FROM sessions WHERE detail_data IS NULL').all() as {
    id: number;
  }[];
  for (const { id } of missing) {
    try {
      await getSessionDetail(id);
    } catch (e) {
      log.warn(e, `scheduler: session ${id} detail fetch failed`);
    }
  }
  const userId = loadTokens()?.user_id;
  if (userId) {
    await getProfile(userId, true);
  } else {
    // Password-grant logins don't reveal the user id; it appears after the
    // first browser login and is kept from then on.
    log.warn('scheduler: Footbar user id unknown, skipping profile sync');
  }
}

export async function runSync(log: FastifyBaseLogger): Promise<void> {
  log.info('scheduler: sync started');
  let ok = true;
  try {
    await syncFootbar(log);
    log.info('scheduler: Footbar synced');
  } catch (e) {
    ok = false;
    log.error(e, 'scheduler: Footbar sync failed');
  }
  try {
    await refreshAll();
    invalidateFixtureIndex();
    log.info('scheduler: RFAF synced');
  } catch (e) {
    ok = false;
    log.error(e, 'scheduler: RFAF sync failed');
  }
  // On failure, backdate the run so it comes due again in ~1h instead of
  // waiting a full cycle (but never sooner — avoids 15-minute retry storms).
  const intervalMs = env.SYNC_INTERVAL_HOURS * 60 * 60 * 1000;
  const stamp = ok ? Date.now() : Date.now() - Math.max(intervalMs - RETRY_MS, 0);
  setSyncState(LAST_RUN_KEY, stamp.toString());
  setSyncState(LAST_RESULT_KEY, ok ? 'ok' : 'error');
  log.info(`scheduler: sync finished (${ok ? 'ok' : 'with errors'})`);
}

let running = false;

export function startScheduler(log: FastifyBaseLogger): void {
  if (env.SYNC_INTERVAL_HOURS <= 0) {
    log.info('scheduler: disabled (SYNC_INTERVAL_HOURS=0)');
    return;
  }
  const intervalMs = env.SYNC_INTERVAL_HOURS * 60 * 60 * 1000;
  const tick = async (): Promise<void> => {
    if (running) return;
    const last = Number(getSyncState(LAST_RUN_KEY) ?? 0);
    if (Date.now() - last < intervalMs) return;
    running = true;
    try {
      await runSync(log);
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), Math.min(CHECK_EVERY_MS, intervalMs)).unref();
  void tick();
  log.info(`scheduler: enabled, syncing every ${env.SYNC_INTERVAL_HOURS}h`);
}
