import { db } from '../db.js';
import { env } from '../env.js';
import { fetchRfafHtml } from '../rfaf/client.js';
import { parseFixtures, parseScorers, parseStandings } from '../rfaf/parse.js';
import type { Fixture, RfafResource, Scorer, Standing } from '../rfaf/types.js';

const TTL_MS = 6 * 60 * 60 * 1000; // data only changes after matchdays

const NPCD = '/pnfg/NPcd';

function standingsUrl(): string {
  return `${NPCD}/NFG_VisClasificacion?cod_primaria=${env.RFAF_COD_PRIMARIA_CLASIF}&codcompeticion=${env.RFAF_CODCOMPETICION}&codgrupo=${env.RFAF_CODGRUPO}`;
}
function scorersUrl(): string {
  return `${NPCD}/NFG_CMP_Goleadores?cod_primaria=${env.RFAF_COD_PRIMARIA_CLASIF}&codcompeticion=${env.RFAF_CODCOMPETICION}&codgrupo=${env.RFAF_CODGRUPO}`;
}
function fixturesUrl(): string {
  return `${NPCD}/NFG_VisCompeticiones_Grupo?cod_primaria=${env.RFAF_COD_PRIMARIA_GRUPO}&codequipo=${env.RFAF_CODEQUIPO}&codgrupo=${env.RFAF_CODGRUPO}`;
}

/** Normalize a name for tolerant matching (drop accents/punctuation/case). */
export function norm(s: string): string {
  // NFD splits accents into combining marks; stripping non-alphanumerics drops them.
  return s.normalize('NFD').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function markStandings(rows: Standing[]): Standing[] {
  return rows.map((r) => ({ ...r, own: r.codequipo === env.RFAF_CODEQUIPO }));
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

async function load<T>(
  key: RfafResource,
  url: string,
  parse: (html: string) => T,
  force: boolean,
): Promise<Cached<T>> {
  const row = selectRow.get(key) as { data: string; fetched_at: number } | undefined;
  if (!force && row && Date.now() - row.fetched_at < TTL_MS) {
    return { results: JSON.parse(row.data) as T, fetched_at: row.fetched_at };
  }
  const parsed = parse(await fetchRfafHtml(url));
  const fetched_at = Date.now();
  upsertRow.run({ key, data: JSON.stringify(parsed), fetched_at });
  return { results: parsed, fetched_at };
}

export function getStandings(force = false): Promise<Cached<Standing[]>> {
  return load('standings', standingsUrl(), (h) => markStandings(parseStandings(h)), force);
}

export function getScorers(force = false): Promise<Cached<Scorer[]>> {
  return load('scorers', scorersUrl(), (h) => markScorers(parseScorers(h)), force);
}

export function getFixtures(force = false): Promise<Cached<Fixture[]>> {
  return load('fixtures', fixturesUrl(), parseFixtures, force);
}

export async function refreshAll(): Promise<void> {
  await getStandings(true);
  await getScorers(true);
  await getFixtures(true);
}
