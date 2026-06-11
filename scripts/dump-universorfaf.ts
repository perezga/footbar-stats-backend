// One-off discovery: dump JSON from every Universo RFAF endpoint we use, so
// the mappers in src/rfaf/map.ts can be written against real response shapes.
// Run inside the container: npx tsx scripts/dump-universorfaf.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { env } from '../src/env.js';
import * as client from '../src/rfaf/client.js';

const OUT = 'tmp-dump';
mkdirSync(OUT, { recursive: true });

const dumps: Record<string, () => Promise<unknown>> = {
  user: () => client.fetchUser(),
  classification: () => client.fetchClassification(env.RFAF_CODGRUPO),
  scorers: () => client.fetchScorers(env.RFAF_CODCOMPETICION, env.RFAF_CODGRUPO),
  'calendar-team': () =>
    client.fetchCalendarTeam(env.RFAF_CODCOMPETICION, env.RFAF_CODGRUPO, String(env.RFAF_CODEQUIPO)),
  'player-detail': () => client.fetchPlayerDetail(env.RFAF_CODPLAYER),
  'player-general-stats': () => client.fetchPlayerGeneralStats(env.RFAF_CODPLAYER, env.RFAF_SEASON),
  'player-matchs': () => client.fetchPlayerMatchs(env.RFAF_CODPLAYER, env.RFAF_SEASON),
  'player-matchs-minutes': () =>
    client.fetchPlayerMatchsMinutes(env.RFAF_CODPLAYER, env.RFAF_SEASON),
};

for (const [name, fn] of Object.entries(dumps)) {
  try {
    const data = await fn();
    writeFileSync(`${OUT}/${name}.json`, JSON.stringify(data, null, 2));
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
}
