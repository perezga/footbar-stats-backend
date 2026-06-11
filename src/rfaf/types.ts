export type RfafResource = 'standings' | 'scorers' | 'fixtures' | 'player_stats';

/** One selectable season ('21' = 2025-2026). */
export interface Season {
  id: string;
  name: string;
}

/** The ids needed to query league data for one season. */
export interface SeasonContext {
  competition: string;
  group: string;
  team: string;
}

/** One team's row in the league table (clasificación). */
export interface Standing {
  position: number;
  team: string;
  /** RFAF team id, parsed from the row's link (used to flag the tracked team). */
  codequipo: number | null;
  points: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goals_for: number;
  goals_against: number;
  /** Last results, most-recent-first: 'W' | 'D' | 'L'. */
  form: ('W' | 'D' | 'L')[];
  /** True for the tracked team (set by the cache layer from config). */
  own?: boolean;
}

/** One player's row in the top-scorers table (goleadores). */
export interface Scorer {
  rank: number;
  player: string;
  team: string;
  group: string;
  played: number;
  goals: number;
  penalties: number;
  goals_per_game: number;
  /** True for the tracked player (set by the cache layer from config). */
  own?: boolean;
}

/** One named counter in the player stats ("Convocados", "Total Goles", …). */
export interface PlayerStatLine {
  name: string;
  value: number;
}

/** A player's season statistics from Universo RFAF. */
export interface PlayerStats {
  player_id: string;
  player: string;
  team: string;
  team_id: number | null;
  dorsal: number | null;
  age: number | null;
  category: string;
  /** Universo RFAF season id (e.g. '21'). */
  season_id: string;
  /** Season label (e.g. '2025-2026'). */
  season: string;
  /** Null when the competition doesn't publish minutes. */
  minutes_played: number | null;
  minutes_per_game: number | null;
  /** Match counters: Convocados, Titular, Suplente, Jugados, Total Goles, … */
  stats: PlayerStatLine[];
  /** Card counters: Amarillas, Rojas, Doble Amarilla. */
  cards: PlayerStatLine[];
  photo_url: string | null;
}

/** One of the tracked player's in-match events (goals, cards). */
export interface PlayerMatchEvent {
  /** Friendly class derived from the raw type. */
  kind: 'goal' | 'yellow' | 'red' | 'second_yellow' | 'other';
  /** Raw Universo RFAF event type (e.g. 'gol_100'). */
  type: string;
  minute: number | null;
}

/** One played match from the tracked player's "partidos jugados" view. */
export interface PlayerMatch {
  matchday: number;
  /** ISO date 'YYYY-MM-DD' from the kickoff schedule. */
  date: string | null;
  home: string;
  away: string;
  home_goals: number | null;
  away_goals: number | null;
  /** True when the player started (titular). */
  started: boolean;
  captain: boolean;
  dorsal: number | null;
  events: PlayerMatchEvent[];
}

/** One fixture/result in the team's schedule, by jornada (matchday). */
export interface Fixture {
  matchday: number;
  home: string;
  away: string;
  /** ISO date 'YYYY-MM-DD', or null if not yet scheduled. */
  date: string | null;
  /** 'HH:MM' kickoff, or null. */
  time: string | null;
  home_goals: number | null;
  away_goals: number | null;
  /** Result from the tracked team's perspective: 'W' | 'D' | 'L' | null (unplayed). */
  result: 'W' | 'D' | 'L' | null;
}
