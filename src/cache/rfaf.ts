import { db } from '../db.js';
import { invalidateFixtureIndex } from './fixtureLink.js';
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
  return s
    .normalize('NFD')
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase();
}

function markStandings(rows: Standing[], ownTeamId: number | null): Standing[] {
  return rows.map((r) => ({ ...r, own: r.codequipo !== null && r.codequipo === ownTeamId }));
}

function markScorers(rows: Scorer[], ownPlayerName: string | null): Scorer[] {
  if (!ownPlayerName) return rows.map((r) => ({ ...r, own: false }));
  const me = norm(ownPlayerName);
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

interface PlayerRfafConfig {
  rfaf_player_id: string;
  rfaf_season: string;
  rfaf_own_player: string;
  rfaf_own_team: string;
}

function getPlayerRfafConfig(playerId: number): PlayerRfafConfig {
  const row = db
    .prepare(
      'SELECT rfaf_player_id, rfaf_season, rfaf_own_player, rfaf_own_team FROM players WHERE id = ?',
    )
    .get(playerId) as PlayerRfafConfig | undefined;
  if (!row?.rfaf_player_id) throw new Error(`Player ${playerId} has no RFAF integration`);
  return row;
}

/**
 * Cached general-stats response for the tracked player. One fetch per season
 * feeds the player-stats view, the seasons list, and the season's
 * competition/group/team ids for the league views.
 */
function loadGeneral(playerId: number, seasonId: string, force = false): Promise<Cached<unknown>> {
  const config = getPlayerRfafConfig(playerId);
  return load(
    `player:${playerId}:general:${seasonId}`,
    () => fetchPlayerGeneralStats(config.rfaf_player_id, seasonId),
    force,
  );
}

async function seasonContext(playerId: number, seasonId: string): Promise<SeasonContext | null> {
  return pickSeasonContext((await loadGeneral(playerId, seasonId)).results);
}

export async function getSeasons(
  playerId: number,
): Promise<Cached<Season[]> & { current: string }> {
  const config = getPlayerRfafConfig(playerId);
  const g = await loadGeneral(playerId, config.rfaf_season);
  return { results: mapSeasons(g.results), fetched_at: g.fetched_at, current: config.rfaf_season };
}

export async function getStandings(
  playerId: number,
  force = false,
  seasonId?: string,
): Promise<Cached<Standing[]>> {
  const config = getPlayerRfafConfig(playerId);
  const sId = seasonId ?? config.rfaf_season;
  const ctx = await seasonContext(playerId, sId);
  return load(
    `player:${playerId}:standings:${sId}`,
    async () =>
      ctx
        ? markStandings(mapStandings(await fetchClassification(ctx.group)), Number(ctx.team))
        : [],
    force,
  );
}

export async function getScorers(
  playerId: number,
  force = false,
  seasonId?: string,
): Promise<Cached<Scorer[]>> {
  const config = getPlayerRfafConfig(playerId);
  const sId = seasonId ?? config.rfaf_season;
  const ctx = await seasonContext(playerId, sId);
  return load(
    `player:${playerId}:scorers:${sId}`,
    async () =>
      ctx
        ? markScorers(
            mapScorers(await fetchScorers(ctx.competition, ctx.group)),
            config.rfaf_own_player,
          )
        : [],
    force,
  );
}

export async function getFixtures(
  playerId: number,
  force = false,
  seasonId?: string,
): Promise<Cached<Fixture[]>> {
  const config = getPlayerRfafConfig(playerId);
  const sId = seasonId ?? config.rfaf_season;
  const ctx = await seasonContext(playerId, sId);
  return load(
    `player:${playerId}:fixtures:${sId}`,
    async () =>
      ctx
        ? mapFixtures(await fetchCalendarTeam(ctx.competition, ctx.group, ctx.team), ctx.team)
        : [],
    force,
  );
}

export async function getPlayerStats(
  playerId: number,
  force = false,
  rfafPlayerId?: string,
  seasonId?: string,
): Promise<Cached<PlayerStats>> {
  const config = getPlayerRfafConfig(playerId);
  const targetId = rfafPlayerId ?? config.rfaf_player_id;
  const sId = seasonId ?? config.rfaf_season;

  if (targetId !== config.rfaf_player_id) {
    // Only the tracked player is cached; explicit overrides go live.
    return {
      results: mapPlayerStats(await fetchPlayerGeneralStats(targetId, sId)),
      fetched_at: Date.now(),
    };
  }
  const g = await loadGeneral(playerId, sId, force);
  return { results: mapPlayerStats(g.results), fetched_at: g.fetched_at };
}

/**
 * The played-matches endpoint wants the season label ('2026-2027'), not the
 * id; resolve it from the seasons list in the cached general stats.
 */
async function seasonName(playerId: number, seasonId: string): Promise<string | null> {
  const config = getPlayerRfafConfig(playerId);
  const seasons = mapSeasons((await loadGeneral(playerId, config.rfaf_season)).results);
  return seasons.find((s) => s.id === seasonId)?.name ?? null;
}

/** The tracked player's played matches with his personal events. */
export async function getPlayerMatches(
  playerId: number,
  force = false,
  seasonId?: string,
): Promise<Cached<PlayerMatch[]>> {
  const config = getPlayerRfafConfig(playerId);
  const sId = seasonId ?? config.rfaf_season;
  return load(
    `player:${playerId}:player-matches:${sId}`,
    async () => {
      const name = await seasonName(playerId, sId);
      return name ? mapPlayerMatches(await fetchPlayerMatchs(config.rfaf_player_id, name)) : [];
    },
    force,
  );
}

export async function refreshAll(playerId: number, seasonId?: string): Promise<void> {
  const config = getPlayerRfafConfig(playerId);
  const sId = seasonId ?? config.rfaf_season;
  await loadGeneral(playerId, sId, true);
  await getStandings(playerId, true, sId);
  await getScorers(playerId, true, sId);
  await getFixtures(playerId, true, sId);
  await getPlayerMatches(playerId, true, sId);
}

/**
 * Fetch a player's RFAF stats to automatically fill in their current season,
 * team name, and competition IDs. Essential for initial onboarding.
 */
export async function syncPlayerConfig(playerId: number): Promise<void> {
  const config = getPlayerRfafConfig(playerId);
  // Fetch with empty season to get the latest active one.
  const g = await loadGeneral(playerId, '', true);
  const json = g.results as any;

  const currentSeason = json.codigo_temporada || json.listado_temporadas?.[0]?.codigo_temporada;
  const currentTeamName = json.equipo || '';
  const ctx = pickSeasonContext(json);

  if (currentSeason) {
    db.prepare(
      `UPDATE players SET
        rfaf_season = ?,
        rfaf_own_team = ?,
        rfaf_competition_id = ?,
        rfaf_group_id = ?,
        rfaf_team_id = ?
      WHERE id = ?`,
    ).run(
      currentSeason,
      currentTeamName,
      ctx?.competition ?? null,
      ctx?.group ?? null,
      ctx?.team ? Number(ctx.team) : null,
      playerId,
    );

    // Pre-populate all caches for this season now that we have the context.
    await refreshAll(playerId, currentSeason);
    invalidateFixtureIndex(playerId);
  }
}
