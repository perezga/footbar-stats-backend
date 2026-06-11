import { describe, expect, it } from 'vitest';
import type { Fixture } from '../rfaf/types.js';
import {
  combineLegRows,
  type DayFixture,
  enrichSession,
  madridDateKey,
  type SessionFixture,
} from './fixtureLink.js';

describe('madridDateKey', () => {
  it('keeps the calendar day for an afternoon kickoff (CET)', () => {
    expect(madridDateKey('2026-01-10T16:00:00Z')).toBe('2026-01-10');
  });

  it('rolls a late-UTC instant into the next Madrid day', () => {
    // 23:30 UTC in winter is 00:30 next day in Madrid (UTC+1).
    expect(madridDateKey('2026-01-10T23:30:00Z')).toBe('2026-01-11');
  });

  it('rolls at 22:30 UTC in summer (UTC+2)', () => {
    expect(madridDateKey('2026-06-10T22:30:00Z')).toBe('2026-06-11');
  });

  it('returns null for an unparsable date', () => {
    expect(madridDateKey('not-a-date')).toBeNull();
  });
});

function fixture(opponent: string, date: string, result: 'W' | 'D' | 'L' | null): SessionFixture {
  return {
    matchday: 1,
    home: 'ATLETICO ESTACION "A"',
    away: opponent,
    opponent,
    is_home: true,
    date,
    time: '12:00',
    home_goals: result ? 1 : null,
    away_goals: result ? 1 : null,
    our_goals: result ? 1 : null,
    their_goals: result ? 1 : null,
    result,
    events: [],
  };
}

interface Row {
  id: number | null;
  start_date: string;
  fixture?: SessionFixture;
}

describe('combineLegRows', () => {
  it('merges a played ida/vuelta pair into the vuelta row', () => {
    const ida: Row = { id: 1, start_date: '2025-10-05T12:00:00', fixture: fixture('CF RIVAL', '2025-10-05', 'W') };
    const vuelta: Row = { id: 2, start_date: '2026-02-08T12:00:00', fixture: fixture('CF Rival', '2026-02-08', 'L') };
    const out = combineLegRows([vuelta, ida]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(2);
    expect(out[0]?.leg).toBe(2);
    expect(out[0]?.other_leg?.session_id).toBe(1);
  });

  it('keeps the ida row while the vuelta is unplayed', () => {
    const ida: Row = { id: 1, start_date: '2025-10-05T12:00:00', fixture: fixture('CF RIVAL', '2025-10-05', 'W') };
    const vuelta: Row = { id: null, start_date: '2026-02-08T12:00:00', fixture: fixture('CF RIVAL', '2026-02-08', null) };
    const out = combineLegRows([vuelta, ida]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(1);
    expect(out[0]?.leg).toBe(1);
    expect(out[0]?.other_leg?.session_id).toBeNull();
  });

  it('leaves rows alone when an opponent has only one leg', () => {
    const rows: Row[] = [
      { id: 1, start_date: '2025-10-05T12:00:00', fixture: fixture('CF UNO', '2025-10-05', 'W') },
      { id: 2, start_date: '2025-10-12T12:00:00', fixture: fixture('CF DOS', '2025-10-12', 'D') },
      { id: 3, start_date: '2025-10-19T12:00:00' },
    ];
    const out = combineLegRows(rows);
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.other_leg === undefined)).toBe(true);
  });
});

describe('enrichSession', () => {
  const day: DayFixture = {
    fixture: {
      matchday: 3,
      home: 'ATLETICO ESTACION "A"',
      away: 'CF RIVAL',
      date: '2026-01-10',
      time: '17:00',
      home_goals: 2,
      away_goals: 0,
      result: 'W',
    } satisfies Fixture,
    events: [],
    started: true,
  };
  const index = new Map([['2026-01-10', day]]);

  it('attaches the same-day fixture to a match and overwrites the title', () => {
    const out = enrichSession(
      { start_date: '2026-01-10T16:00:00Z', match_type: '11', title: 'Sesión' },
      index,
    );
    expect(out.title).toBe('ATLETICO ESTACION "A" vs CF RIVAL');
    expect(out.fixture?.opponent).toBe('CF RIVAL');
    expect(out.fixture?.is_home).toBe(true);
    expect(out.fixture?.our_goals).toBe(2);
    expect(out.fixture?.started).toBe(true);
  });

  it('leaves non-match sessions untouched', () => {
    const session = { start_date: '2026-01-10T16:00:00Z', match_type: 'tr', title: 'Training' };
    expect(enrichSession(session, index)).toEqual(session);
  });

  it('leaves matches with no same-day fixture untouched', () => {
    const session = { start_date: '2026-03-01T16:00:00Z', match_type: '11', title: 'Sesión' };
    expect(enrichSession(session, index)).toEqual(session);
  });
});
