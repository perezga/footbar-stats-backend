import type { FastifyBaseLogger } from 'fastify';
import { invalidateFixtureIndex } from './cache/fixtureLink.js';
import { getProfile } from './cache/profile.js';
import { refreshAll } from './cache/rfaf.js';
import { ensureListFresh, getSessionDetail } from './cache/sessions.js';
import { db, getRfafPlayerId, getSyncState, setSyncState } from './db.js';
import { env } from './env.js';

// Background daily sync: pulls Footbar and Universo RFAF data into SQLite so
// the app serves fresh data without any user-triggered fetch. The last run is
// persisted in sync_state, so restarts neither skip nor duplicate a run.

const LAST_RUN_KEY = 'scheduler_last_run';
const LAST_RESULT_KEY = 'scheduler_last_result';
/** How often to check whether a sync is due (also caps startup catch-up lag). */
const CHECK_EVERY_MS = 15 * 60 * 1000;
/** How soon a failed run becomes due again. */
const RETRY_MS = 60 * 60 * 1000;

async function syncFootbarForUser(appUserId: number, log: FastifyBaseLogger): Promise<void> {
  log.info(`scheduler: syncing Footbar for user ${appUserId}`);
  await ensureListFresh(appUserId, true);
  // The app fetches session details lazily; prefetch whatever is missing so
  // records/trends cover every session without anyone opening it first.
  const missing = db
    .prepare('SELECT id FROM footbar_sessions WHERE app_user_id = ? AND detail_data IS NULL')
    .all(appUserId) as {
    id: number;
  }[];
  for (const { id } of missing) {
    try {
      await getSessionDetail(id, appUserId);
    } catch (e) {
      log.warn(e, `scheduler: session ${id} detail fetch failed for user ${appUserId}`);
    }
  }
  await getProfile(appUserId, true);
}

export async function runSync(log: FastifyBaseLogger): Promise<void> {
  log.info('scheduler: sync started');
  let ok = true;

  const users = db.prepare('SELECT app_user_id FROM footbar_links').all() as {
    app_user_id: number;
  }[];
  const seenPlayers = new Set<string>();

  for (const { app_user_id } of users) {
    try {
      await syncFootbarForUser(app_user_id, log);
      const playerId = getRfafPlayerId(app_user_id);
      if (playerId) {
        await refreshAll(env.RFAF_SEASON, playerId);
        seenPlayers.add(playerId);
      }
    } catch (e) {
      ok = false;
      log.error(e, `scheduler: sync failed for user ${app_user_id}`);
    }
  }

  try {
    // Ensure the default player is also synced if not already covered.
    if (!seenPlayers.has(env.RFAF_CODPLAYER)) {
      await refreshAll(env.RFAF_SEASON, env.RFAF_CODPLAYER);
    }
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
  setSyncState(LAST_RUN_KEY, stamp.toString(), 0); // Global sync state
  setSyncState(LAST_RESULT_KEY, ok ? 'ok' : 'error', 0);
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
