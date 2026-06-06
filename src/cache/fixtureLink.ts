import { env } from '../env.js';
import type { Fixture } from '../rfaf/types.js';
import { getFixtures, norm } from './rfaf.js';

/** A fixture resolved against the tracked team, attached to a session. */
export interface SessionFixture {
  matchday: number;
  home: string;
  away: string;
  /** The side that isn't the tracked team. */
  opponent: string;
  /** True if the tracked team played at home. */
  is_home: boolean;
  date: string | null;
  time: string | null;
  home_goals: number | null;
  away_goals: number | null;
  our_goals: number | null;
  their_goals: number | null;
  result: 'W' | 'D' | 'L' | null;
}

const madridDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** ISO datetime → 'YYYY-MM-DD' in Europe/Madrid (avoids UTC date-roll at night). */
export function madridDateKey(startDate: string): string | null {
  const d = new Date(startDate);
  if (Number.isNaN(d.getTime())) return null;
  return madridDate.format(d); // en-CA yields YYYY-MM-DD
}

function toSessionFixture(f: Fixture): SessionFixture {
  const isHome = norm(f.home).includes(norm(env.RFAF_OWN_TEAM));
  return {
    matchday: f.matchday,
    home: f.home,
    away: f.away,
    opponent: isHome ? f.away : f.home,
    is_home: isHome,
    date: f.date,
    time: f.time,
    home_goals: f.home_goals,
    away_goals: f.away_goals,
    our_goals: isHome ? f.home_goals : f.away_goals,
    their_goals: isHome ? f.away_goals : f.home_goals,
    result: f.result,
  };
}

/** Map of 'YYYY-MM-DD' → fixture for the tracked team. Empty on RFAF failure. */
export async function buildFixtureIndex(): Promise<Map<string, Fixture>> {
  const { results } = await getFixtures();
  const index = new Map<string, Fixture>();
  for (const f of results) {
    if (f.date) index.set(f.date, f);
  }
  return index;
}

/**
 * Attach the matching fixture to a Game session (same calendar day). The fixture
 * is the source of truth for the match result; presentation layers prefer it.
 */
export function enrichSession<T extends { start_date: string; match_type: string }>(
  session: T,
  index: Map<string, Fixture>,
): T & { fixture?: SessionFixture } {
  if (session.match_type !== '11') return session;
  const key = madridDateKey(session.start_date);
  const fixture = key ? index.get(key) : undefined;
  if (!fixture) return session;
  return { ...session, fixture: toSessionFixture(fixture) };
}
