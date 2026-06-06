import type { Fixture, Scorer, Standing } from './types.js';

// --- tiny HTML helpers (the RFAF tables are plain server-rendered HTML) ---

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m] ?? m);
}

/** Strip tags, decode entities, collapse whitespace. */
function text(html: string | undefined): string {
  return decodeEntities((html ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function tables(html: string): string[] {
  return html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
}

function rows(table: string): string[] {
  return table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
}

function cells(row: string): string[] {
  return (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map((c) =>
    c.replace(/^<t[dh][^>]*>/i, '').replace(/<\/t[dh]>$/i, ''),
  );
}

function num(s: string | undefined): number {
  const n = parseInt(text(s).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Map an RFAF result marker (by span title) to W/D/L. */
function marker(html: string | undefined): 'W' | 'D' | 'L' | null {
  const h = html ?? '';
  if (/title=["']?Ganado/i.test(h)) return 'W';
  if (/title=["']?Empatado/i.test(h)) return 'D';
  if (/title=["']?Perdido/i.test(h)) return 'L';
  return null;
}

function formFromCell(html: string | undefined): ('W' | 'D' | 'L')[] {
  const out: ('W' | 'D' | 'L')[] = [];
  for (const m of (html ?? '').matchAll(/title=["']?(Ganado|Empatado|Perdido)/gi)) {
    const t = (m[1] ?? '').toLowerCase();
    out.push(t === 'ganado' ? 'W' : t === 'empatado' ? 'D' : 'L');
  }
  return out;
}

// --- parsers ---

/** Parse the classification table (home/away split + GF/GA + form). */
export function parseStandings(html: string): Standing[] {
  const table =
    tables(html).find((t) => /Casa/i.test(t) && /Fuera/i.test(t)) ?? tables(html)[0];
  if (!table) return [];

  const out: Standing[] = [];
  for (const row of rows(table)) {
    const c = cells(row);
    // A data row has a team link to NFG_VisCompeticiones_Grupo; header rows don't.
    const teamIdx = c.findIndex((cell) => /NFG_VisCompeticiones_Grupo/i.test(cell));
    if (teamIdx < 0) continue;

    const codeMatch = /codequipo=(\d+)/i.exec(c[teamIdx] ?? '');
    const homeJ = num(c[teamIdx + 2]);
    const homeG = num(c[teamIdx + 3]);
    const homeE = num(c[teamIdx + 4]);
    const homeP = num(c[teamIdx + 5]);
    const awayJ = num(c[teamIdx + 6]);
    const awayG = num(c[teamIdx + 7]);
    const awayE = num(c[teamIdx + 8]);
    const awayP = num(c[teamIdx + 9]);

    out.push({
      position: num(c[teamIdx - 1]),
      team: text(c[teamIdx]),
      codequipo: codeMatch ? Number(codeMatch[1]) : null,
      points: num(c[teamIdx + 1]),
      played: homeJ + awayJ,
      won: homeG + awayG,
      drawn: homeE + awayE,
      lost: homeP + awayP,
      goals_for: num(c[teamIdx + 10]),
      goals_against: num(c[teamIdx + 11]),
      form: formFromCell(c[teamIdx + 12] ?? ''),
    });
  }
  return out;
}

/** Parse the top-scorers table. */
export function parseScorers(html: string): Scorer[] {
  const table = tables(html).find((t) => /Jugador/i.test(t)) ?? tables(html)[0];
  if (!table) return [];

  const out: Scorer[] = [];
  for (const row of rows(table)) {
    if (/<th[\s>]/i.test(row)) continue; // header
    const c = cells(row);
    if (c.length < 6) continue;

    const goalsCell = c[4] ?? '';
    const penMatch = /\((\d+)\s*P\)/i.exec(goalsCell);
    out.push({
      rank: out.length + 1,
      player: text(c[0]),
      team: text(c[1]),
      group: text(c[2]),
      played: num(c[3]),
      goals: num(goalsCell.replace(/\([^)]*\)/g, '')), // drop "(N P)" before counting
      penalties: penMatch ? Number(penMatch[1]) : 0,
      goals_per_game: Number(text(c[5]).replace(',', '.')) || 0,
    });
  }
  return out;
}

/** Parse the tracked team's fixtures/results, by matchday. */
export function parseFixtures(html: string): Fixture[] {
  const table =
    tables(html).find((t) => /Resultado/i.test(t) && /Jor/i.test(t)) ?? tables(html)[1];
  if (!table) return [];

  const out: Fixture[] = [];
  for (const row of rows(table)) {
    if (/<th[\s>]/i.test(row)) continue;
    const c = cells(row);
    if (c.length < 3) continue;

    const matchday = num(c[0]);
    if (!matchday) continue;

    // Middle cell: <h5>home</h5> <h5>away</h5> <h5>DD-MM-YYYY  HH:MM</h5>
    const h5 = [...(c[1] ?? '').matchAll(/<h5[^>]*>([\s\S]*?)<\/h5>/gi)].map((m) => text(m[1]));
    const home = h5[0] ?? '';
    const away = h5[1] ?? '';
    const dt = h5[2] ?? '';
    const dm = /(\d{2})-(\d{2})-(\d{4})/.exec(dt);
    const tm = /(\d{2}:\d{2})/.exec(dt);

    // Result cell: <b>2</b> - <b> 6</b> plus a G/E/P marker span.
    const resultCell = c[2] ?? '';
    const score = /<b>\s*(\d+)\s*<\/b>\s*-\s*<b>\s*(\d+)\s*<\/b>/i.exec(resultCell);

    out.push({
      matchday,
      home,
      away,
      date: dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : null,
      time: tm?.[1] ?? null,
      home_goals: score ? Number(score[1]) : null,
      away_goals: score ? Number(score[2]) : null,
      result: marker(resultCell),
    });
  }
  return out;
}
