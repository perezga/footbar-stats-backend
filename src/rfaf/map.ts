import type {
  Fixture,
  PlayerMatch,
  PlayerMatchEvent,
  PlayerStats,
  Scorer,
  Season,
  SeasonContext,
  Standing,
} from './types.js';

// Mappers from Universo RFAF API responses (all-string JSON) to our types.
// Response shapes were captured with scripts/dump-universorfaf.ts.

function num(s: unknown): number {
  return Number(s) || 0;
}

function numOrNull(s: unknown): number | null {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 'DD-MM-YYYY' → 'YYYY-MM-DD', or null. */
function isoDate(s: unknown): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(typeof s === 'string' ? s : '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Spanish result letters: G(anado)/E(mpatado)/P(erdido) → W/D/L. */
const RESULT_LETTER: Record<string, 'W' | 'D' | 'L'> = { G: 'W', E: 'D', P: 'L' };

interface ApiClassificationRow {
  posicion: string;
  nombre: string;
  codequipo: string;
  puntos: string;
  jugados: string;
  ganados: string;
  empatados: string;
  perdidos: string;
  goles_a_favor: string;
  goles_en_contra: string;
  racha_partidos: { tipo: string; color: string }[];
}

export function mapStandings(json: unknown): Standing[] {
  const rows = (json as { clasificacion?: ApiClassificationRow[] }).clasificacion ?? [];
  return rows.map((r) => ({
    position: num(r.posicion),
    team: r.nombre,
    codequipo: numOrNull(r.codequipo),
    points: num(r.puntos),
    played: num(r.jugados),
    won: num(r.ganados),
    drawn: num(r.empatados),
    lost: num(r.perdidos),
    goals_for: num(r.goles_a_favor),
    goals_against: num(r.goles_en_contra),
    form: (r.racha_partidos ?? [])
      .map((p) => RESULT_LETTER[p.tipo])
      .filter((x): x is 'W' | 'D' | 'L' => x !== undefined),
  }));
}

interface ApiScorerRow {
  jugador: string;
  nombre_equipo: string;
  partidos_jugados: string;
  goles: string;
  goles_penalti: string;
  goles_por_partidos: string;
}

export function mapScorers(json: unknown): Scorer[] {
  const body = json as { grupo?: string; goles?: ApiScorerRow[] };
  return (body.goles ?? []).map((r, i) => ({
    rank: i + 1,
    player: r.jugador,
    team: r.nombre_equipo,
    group: body.grupo ?? '',
    played: num(r.partidos_jugados),
    goals: num(r.goles),
    penalties: num(r.goles_penalti),
    goals_per_game: num(r.goles_por_partidos),
  }));
}

interface ApiCalendarMatch {
  equipo_local: string;
  equipo_visitante: string;
  codigo_equipo_local: string;
  codigo_equipo_visitante: string;
  goles_casa: string;
  goles_visitante: string;
  fecha: string;
  hora: string;
  round: string;
}

export function mapFixtures(json: unknown, ownTeamId: string): Fixture[] {
  // calendario groups matches by state ('finalizado', upcoming states…) and
  // then by matchday; flatten everything and sort by matchday.
  const calendario =
    (json as { calendario?: Record<string, Record<string, ApiCalendarMatch[]>> }).calendario ?? {};
  const fixtures: Fixture[] = [];
  for (const byRound of Object.values(calendario)) {
    for (const matches of Object.values(byRound ?? {})) {
      for (const m of matches) {
        const home_goals = numOrNull(m.goles_casa);
        const away_goals = numOrNull(m.goles_visitante);
        fixtures.push({
          matchday: num(m.round),
          home: m.equipo_local,
          away: m.equipo_visitante,
          date: isoDate(m.fecha),
          time: m.hora?.trim() || null,
          home_goals,
          away_goals,
          result: resultFor(m, home_goals, away_goals, ownTeamId),
        });
      }
    }
  }
  return fixtures.sort((a, b) => a.matchday - b.matchday);
}

function resultFor(
  m: ApiCalendarMatch,
  home_goals: number | null,
  away_goals: number | null,
  own: string,
): 'W' | 'D' | 'L' | null {
  if (home_goals === null || away_goals === null) return null;
  let ours: number;
  let theirs: number;
  if (m.codigo_equipo_local === own) [ours, theirs] = [home_goals, away_goals];
  else if (m.codigo_equipo_visitante === own) [ours, theirs] = [away_goals, home_goals];
  else return null;
  return ours > theirs ? 'W' : ours < theirs ? 'L' : 'D';
}

interface ApiCompetitionEntry {
  nombre_competicion?: string;
  codigo_competicion?: string;
  codgrupo?: string;
  codequipo?: string;
}

interface ApiPlayerGeneralStats {
  codigo_jugador?: string;
  listado_temporadas?: { nombre_temporada: string; codigo_temporada: string }[];
  competiciones_participa?: ApiCompetitionEntry[];
  nombre_jugador?: string;
  equipo?: string;
  codigo_equipo?: string;
  dorsal_jugador?: string;
  edad?: string;
  categoria_equipo?: string;
  codigo_temporada?: string;
  nombre_temporada?: string;
  minutos_totales_jugados?: string;
  media_minutos_totales_jugados?: string;
  partidos?: { nombre: string; valor: string }[];
  tarjetas?: { nombre: string; valor: string }[];
  image?: string;
}

/** Seasons the portal knows about, newest first. */
export function mapSeasons(json: unknown): Season[] {
  const g = json as ApiPlayerGeneralStats;
  return (g.listado_temporadas ?? []).map((t) => ({
    id: t.codigo_temporada,
    name: t.nombre_temporada,
  }));
}

/**
 * Pick the competition whose standings/fixtures we show for a season: the
 * tracked player's league (first non-cup entry he participated in), or null
 * when he wasn't registered that season.
 */
export function pickSeasonContext(json: unknown): SeasonContext | null {
  const entries = (json as ApiPlayerGeneralStats).competiciones_participa ?? [];
  const pick = entries.find((e) => !/copa/i.test(e.nombre_competicion ?? '')) ?? entries[0];
  if (!pick?.codigo_competicion || !pick.codgrupo || !pick.codequipo) return null;
  return {
    competition: pick.codigo_competicion,
    group: pick.codgrupo,
    team: pick.codequipo,
  };
}

interface ApiPlayerMatch {
  schedule?: string | null;
  round?: number;
  r1?: number | null;
  r2?: number | null;
  home_team_name?: string;
  away_team_name?: string;
  titular?: boolean;
  capitan?: boolean;
  dorsal?: number | null;
  events?: { type?: string; minute?: number | null }[];
}

/** 'gol_*' are goals; tarjeta suffixes match the card codes in `tarjetas`. */
function eventKind(type: string): PlayerMatchEvent['kind'] {
  if (type.startsWith('gol')) return 'goal';
  if (type === 'tarjeta_100') return 'yellow';
  if (type === 'tarjeta_101') return 'red';
  if (type === 'tarjeta_102') return 'second_yellow';
  return 'other';
}

/**
 * internal-data/player/matchs: the player's played matches with his personal
 * events. Unlike the novanet endpoints, this API returns real JSON numbers.
 */
export function mapPlayerMatches(json: unknown): PlayerMatch[] {
  const rows = (json as { info?: ApiPlayerMatch[] }).info ?? [];
  return rows.map((m) => ({
    matchday: m.round ?? 0,
    date: typeof m.schedule === 'string' ? m.schedule.slice(0, 10) : null,
    home: m.home_team_name ?? '',
    away: m.away_team_name ?? '',
    home_goals: m.r1 ?? null,
    away_goals: m.r2 ?? null,
    started: m.titular === true,
    captain: m.capitan === true,
    dorsal: m.dorsal ?? null,
    events: (m.events ?? [])
      .map((e) => ({
        kind: eventKind(e.type ?? ''),
        type: e.type ?? '',
        minute: typeof e.minute === 'number' ? e.minute : null,
      }))
      .sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999)),
  }));
}

export function mapPlayerStats(json: unknown): PlayerStats {
  const g = json as ApiPlayerGeneralStats;
  return {
    player_id: g.codigo_jugador ?? '',
    player: g.nombre_jugador ?? '',
    team: g.equipo ?? '',
    team_id: numOrNull(g.codigo_equipo),
    dorsal: numOrNull(g.dorsal_jugador),
    age: numOrNull(g.edad),
    category: g.categoria_equipo ?? '',
    season_id: g.codigo_temporada ?? '',
    season: g.nombre_temporada ?? '',
    minutes_played: numOrNull(g.minutos_totales_jugados),
    minutes_per_game: numOrNull(g.media_minutos_totales_jugados),
    stats: (g.partidos ?? []).map((p) => ({ name: p.nombre, value: num(p.valor) })),
    cards: (g.tarjetas ?? []).map((c) => ({ name: c.nombre, value: num(c.valor) })),
    photo_url: g.image || null,
  };
}
