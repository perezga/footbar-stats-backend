import { db } from '../db.js';
import { env } from '../env.js';
import {
  fetchCalendarTeam,
  fetchClassification,
  fetchPlayerGeneralStats,
  fetchPlayerMatchs,
  fetchScorers,
} from '../rfaf/client.js';
import {
  mapFixtures,
  mapPlayerMatches,
  mapPlayerStats,
  mapScorers,
  mapSeasons,
  mapStandings,
  pickSeasonContext,
} from '../rfaf/map.js';
import type {
  Fixture,
  PlayerMatch,
  PlayerStats,
  Scorer,
  Season,
  SeasonContext,
  Standing,
} from '../rfaf/types.js';
import { tryParse } from '../util/json.js';

const TTL_MS = 6 * 60 * 60 * 1000; // data only changes after matchdays

/** Normalize a name for tolerant matching (drop accents/punctuation/case). */
export function norm(s: string): string {
  // NFD splits accents into combining marks; stripping non-alphanumerics drops them.
  return s.normalize('NFD').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function markStandings(rows: Standing[], ownTeamId: number | null): Standing[] {
  return rows.map((r) => ({ ...r, own: r.codequipo !== null && r.codequipo === ownTeamId }));
}

function markScorers(rows: Scorer[]): Scorer[] {
  const me = norm(env.RFAF_OWN_PLAYER);
  return rows.map((r) => ({ ...r, own: norm(r.player) === me }));
}

const selectRow = db.prepare('SELECT data, fetched_at FROM rfaf_cache WHERE key = ?');
const upsertRow = db.prepare(
  `INSERT INTO rfaf_cache (key, data, fetched_at) VALUES (@key, @data, @fetched_at)
   ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
);

interface Cached<T> {
  results: T;
  fetched_at: number;
}

async function load<T>(key: string, fetch: () => Promise<T>, force: boolean): Promise<Cached<T>> {
  const row = selectRow.get(key) as { data: string; fetched_at: number } | undefined;
  if (!force && row && Date.now() - row.fetched_at < TTL_MS) {
    // A corrupt cached payload counts as a miss and is re-fetched below.
    const cached = tryParse<T>(row.data);
    if (cached !== null) return { results: cached, fetched_at: row.fetched_at };
  }
  const results = await fetch();
  const fetched_at = Date.now();
  upsertRow.run({ key, data: JSON.stringify(results), fetched_at });
  return { results, fetched_at };
}

/**
 * Cached general-stats response for the tracked player. One fetch per season
 * feeds the player-stats view, the seasons list, and the season's
 * competition/group/team ids for the league views.
 */
function loadGeneral(seasonId: string, force = false): Promise<Cached<unknown>> {
  return load(`general:${seasonId}`, () => fetchPlayerGeneralStats(env.RFAF_CODPLAYER, seasonId), force);
}

async function seasonContext(seasonId: string): Promise<SeasonContext | null> {
  return pickSeasonContext((await loadGeneral(seasonId)).results);
}

export async function getSeasons(): Promise<Cached<Season[]> & { current: string }> {
  const g = await loadGeneral(env.RFAF_SEASON);
  return { results: mapSeasons(g.results), fetched_at: g.fetched_at, current: env.RFAF_SEASON };
}

export async function getStandings(
  force = false,
  seasonId = env.RFAF_SEASON,
): Promise<Cached<Standing[]>> {
  const ctx = await seasonContext(seasonId);
  return load(
    `standings:${seasonId}`,
    async () =>
      ctx ? markStandings(mapStandings(await fetchClassification(ctx.group)), Number(ctx.team)) : [],
    force,
  );
}

export async function getScorers(
  force = false,
  seasonId = env.RFAF_SEASON,
): Promise<Cached<Scorer[]>> {
  const ctx = await seasonContext(seasonId);
  return load(
    `scorers:${seasonId}`,
    async () => (ctx ? markScorers(mapScorers(await fetchScorers(ctx.competition, ctx.group))) : []),
    force,
  );
}

export async function getFixtures(
  force = false,
  seasonId = env.RFAF_SEASON,
): Promise<Cached<Fixture[]>> {
  const ctx = await seasonContext(seasonId);
  return load(
    `fixtures:${seasonId}`,
    async () =>
      ctx ? mapFixtures(await fetchCalendarTeam(ctx.competition, ctx.group, ctx.team), ctx.team) : [],
    force,
  );
}

export async function getPlayerStats(
  force = false,
  playerId = env.RFAF_CODPLAYER,
  seasonId = env.RFAF_SEASON,
): Promise<Cached<PlayerStats>> {
  if (playerId !== env.RFAF_CODPLAYER) {
    // Only the tracked player is cached; explicit overrides go live.
    return {
      results: mapPlayerStats(await fetchPlayerGeneralStats(playerId, seasonId)),
      fetched_at: Date.now(),
    };
  }
  const g = await loadGeneral(seasonId, force);
  return { results: mapPlayerStats(g.results), fetched_at: g.fetched_at };
}

/**
 * The played-matches endpoint wants the season label ('2025-2026'), not the
 * id; resolve it from the seasons list in the cached general stats.
 */
async function seasonName(seasonId: string): Promise<string | null> {
  const seasons = mapSeasons((await loadGeneral(env.RFAF_SEASON)).results);
  return seasons.find((s) => s.id === seasonId)?.name ?? null;
}

/** The tracked player's played matches with his personal events. */
export async function getPlayerMatches(
  force = false,
  seasonId = env.RFAF_SEASON,
): Promise<Cached<PlayerMatch[]>> {
  return load(
    `player-matches:${seasonId}`,
    async () => {
      const name = await seasonName(seasonId);
      return name ? mapPlayerMatches(await fetchPlayerMatchs(env.RFAF_CODPLAYER, name)) : [];
    },
    force,
  );
}

export async function refreshAll(seasonId = env.RFAF_SEASON): Promise<void> {
  await loadGeneral(seasonId, true);
  await getStandings(true, seasonId);
  await getScorers(true, seasonId);
  await getFixtures(true, seasonId);
  await getPlayerMatches(true, seasonId);
}
