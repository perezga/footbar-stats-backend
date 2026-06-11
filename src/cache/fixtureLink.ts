import { env } from '../env.js';
import type { Position } from '../footbar/types.js';
import type { Fixture, PlayerMatchEvent } from '../rfaf/types.js';
import { getFixtures, getPlayerMatches, norm } from './rfaf.js';

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
  /** The tracked player's events in this match (goals, cards). */
  events: PlayerMatchEvent[];
  /** Titular (true) / suplente (false); undefined when there's no player-match row. */
  started?: boolean;
  captain?: boolean;
}

/** A day's fixture plus the tracked player's involvement in it. */
export interface DayFixture {
  fixture: Fixture;
  events: PlayerMatchEvent[];
  started?: boolean;
  captain?: boolean;
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

function toSessionFixture(
  f: Fixture,
  day: Pick<DayFixture, 'events' | 'started' | 'captain'>,
): SessionFixture {
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
    events: day.events,
    started: day.started,
    captain: day.captain,
  };
}

// The index is rebuilt from the SQLite-cached RFAF payloads on every session
// request otherwise; a short memo skips the re-parse. Refresh paths call
// invalidateFixtureIndex() so a manual RFAF refresh shows up immediately.
const INDEX_TTL_MS = 5 * 60 * 1000;
let indexMemo: { builtAt: number; index: Map<string, DayFixture> } | null = null;

export function invalidateFixtureIndex(): void {
  indexMemo = null;
}

/** Map of 'YYYY-MM-DD' → fixture + player events. Empty on RFAF failure. */
export async function buildFixtureIndex(): Promise<Map<string, DayFixture>> {
  if (indexMemo && Date.now() - indexMemo.builtAt < INDEX_TTL_MS) return indexMemo.index;
  const { results } = await getFixtures();
  const index = new Map<string, DayFixture>();
  for (const f of results) {
    if (f.date) index.set(f.date, { fixture: f, events: [] });
  }
  try {
    for (const m of (await getPlayerMatches()).results) {
      const day = m.date ? index.get(m.date) : undefined;
      if (day) {
        day.events = m.events;
        day.started = m.started;
        day.captain = m.captain;
      }
    }
  } catch {
    // Events are an optional layer; fixtures alone still enrich sessions.
  }
  indexMemo = { builtAt: Date.now(), index };
  return index;
}

/** Display name for a matched fixture, e.g. `HOME vs AWAY`. */
function fixtureName(f: Fixture): string {
  return `${f.home} vs ${f.away}`;
}

/** A fixture with no Footbar session, shaped like a session list row (id null). */
export interface FixtureOnlySession {
  id: null;
  start_date: string;
  stop_date: string;
  title: string;
  match_type: '11';
  fixture: SessionFixture;
}

/** Pseudo session-list row for a fixture the tracker didn't record. */
export function fixtureOnlySession(date: string, day: DayFixture): FixtureOnlySession {
  const f = day.fixture;
  const start = `${date}T${f.time ?? '00:00'}:00`;
  return {
    id: null,
    start_date: start,
    stop_date: start,
    title: fixtureName(f),
    match_type: '11',
    fixture: toSessionFixture(f, day),
  };
}

/** The opposite league leg vs the same opponent, carried by the merged row. */
export interface LegRef {
  /** Footbar session id of that leg, or null if the tracker didn't record it. */
  session_id: number | null;
  fixture: SessionFixture;
  position?: Position;
  score_stars?: number;
}

/** A leg counts as played once it has an official result or a recorded session. */
function legPlayed(row: { id: number | null; fixture?: SessionFixture }): boolean {
  return row.id !== null || row.fixture?.result != null;
}

/**
 * Merge the two league legs against the same opponent into one row: the most
 * recent played leg survives (the ida when neither is played yet) and carries
 * the other leg as `other_leg`, so the list shows one line per opponent with
 * the pending or finished return leg inline. Only clean ida/vuelta pairs merge.
 */
export function combineLegRows<
  T extends {
    id: number | null;
    start_date: string;
    fixture?: SessionFixture;
    position?: Position;
    score_stars?: number;
  },
>(rows: T[]): (T & { leg?: 1 | 2; other_leg?: LegRef })[] {
  const byOpponent = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.fixture) continue;
    const key = norm(r.fixture.opponent);
    const group = byOpponent.get(key);
    if (group) group.push(r);
    else byOpponent.set(key, [r]);
  }
  const dropped = new Set<T>();
  const merged = new Map<T, T & { leg: 1 | 2; other_leg: LegRef }>();
  for (const legs of byOpponent.values()) {
    if (legs.length !== 2) continue;
    legs.sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
    const [ida, vuelta] = legs as [T, T];
    const primary = legPlayed(vuelta) ? vuelta : ida;
    const other = primary === vuelta ? ida : vuelta;
    dropped.add(other);
    merged.set(primary, {
      ...primary,
      leg: primary === vuelta ? 2 : 1,
      other_leg: {
        session_id: other.id,
        fixture: other.fixture!,
        position: other.position,
        score_stars: other.score_stars,
      },
    });
  }
  return rows.filter((r) => !dropped.has(r)).map((r) => merged.get(r) ?? r);
}

/**
 * Attach the matching fixture to a Game session (same calendar day). The fixture
 * is the source of truth for the match: its result is attached and its name
 * overwrites the session title.
 */
export function enrichSession<T extends { start_date: string; match_type: string; title: string }>(
  session: T,
  index: Map<string, DayFixture>,
): T & { fixture?: SessionFixture } {
  if (session.match_type !== '11') return session;
  const key = madridDateKey(session.start_date);
  const day = key ? index.get(key) : undefined;
  if (!day) return session;
  return {
    ...session,
    title: fixtureName(day.fixture),
    fixture: toSessionFixture(day.fixture, day),
  };
}
