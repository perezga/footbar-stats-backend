import type { FastifyBaseLogger } from 'fastify';
import { invalidateFixtureIndex } from './cache/fixtureLink.js';
import { getProfile } from './cache/profile.js';
import { refreshAll } from './cache/rfaf.js';
import { ensureListFresh, getSessionDetail } from './cache/sessions.js';
import { db, getSyncState, setSyncState } from './db.js';
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

async function syncPlayer(
  log: FastifyBaseLogger,
  player: { id: number; footbar_user_id: number | null },
): Promise<void> {
  if (player.footbar_user_id) {
    try {
      await ensureListFresh(player.id, player.footbar_user_id, true);
      // Prefetch session details
      const missing = db
        .prepare('SELECT id FROM sessions WHERE footbar_user_id = ? AND detail_data IS NULL')
        .all(player.footbar_user_id) as {
        id: number;
      }[];
      for (const { id } of missing) {
        try {
          await getSessionDetail(player.id, id, player.footbar_user_id);
        } catch (e) {
          log.warn(e, `scheduler: player ${player.id} session ${id} detail fetch failed`);
        }
      }
      await getProfile(player.id, player.footbar_user_id, true);
      log.info(`scheduler: Footbar synced for player ${player.id}`);
    } catch (e) {
      log.error(e, `scheduler: Footbar sync failed for player ${player.id}`);
      throw e;
    }
  }

  try {
    // Only sync RFAF if config is present
    const checkRfaf = db
      .prepare('SELECT rfaf_player_id FROM players WHERE id = ?')
      .get(player.id) as { rfaf_player_id: string | null } | undefined;
    if (checkRfaf?.rfaf_player_id) {
      await refreshAll(player.id);
      invalidateFixtureIndex(player.id);
      log.info(`scheduler: RFAF synced for player ${player.id}`);
    }
  } catch (e) {
    log.error(e, `scheduler: RFAF sync failed for player ${player.id}`);
    throw e;
  }
}

export async function runSync(log: FastifyBaseLogger): Promise<void> {
  log.info('scheduler: sync started');
  const players = db.prepare('SELECT id, footbar_user_id FROM players').all() as {
    id: number;
    footbar_user_id: number | null;
  }[];

  let allOk = true;
  for (const player of players) {
    try {
      await syncPlayer(log, player);
    } catch (_e) {
      allOk = false;
    }
  }

  // On failure, backdate the run so it comes due again in ~1h instead of
  // waiting a full cycle (but never sooner — avoids 15-minute retry storms).
  const intervalMs = env.SYNC_INTERVAL_HOURS * 60 * 60 * 1000;
  const stamp = allOk ? Date.now() : Date.now() - Math.max(intervalMs - RETRY_MS, 0);
  setSyncState(LAST_RUN_KEY, stamp.toString());
  setSyncState(LAST_RESULT_KEY, allOk ? 'ok' : 'error');
  log.info(`scheduler: sync finished (${allOk ? 'ok' : 'with errors'})`);
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
