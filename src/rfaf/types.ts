export type RfafResource = 'standings' | 'scorers' | 'fixtures';

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
