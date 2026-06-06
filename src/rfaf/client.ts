const RFAF_ORIGIN = 'https://www.rfaf.es';
/** Visiting this path with a fresh JSESSIONID activates it server-side. */
const ACTIVATE_PATH = '/pnfg/NLogin';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export class RfafError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Cached JSESSIONID value (Path=/pnfg). Minted lazily, re-minted on expiry. */
let sessionCookie: string | null = null;

function extractJsessionId(res: Response): string | null {
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const c of cookies) {
    const m = /JSESSIONID=([^;]+)/.exec(c);
    if (m) return m[1] ?? null;
  }
  return null;
}

function rawGet(path: string, withCookie: boolean): Promise<Response> {
  const headers: Record<string, string> = { 'User-Agent': UA };
  if (withCookie && sessionCookie) headers.Cookie = `JSESSIONID=${sessionCookie}`;
  return fetch(`${RFAF_ORIGIN}${path}`, { headers, redirect: 'manual' });
}

/**
 * Establish a usable session. RFAF mints a JSESSIONID on the first hit to any
 * NPcd page (which 302s to NLogin), but the cookie only becomes valid for data
 * pages after one visit to NLogin carrying it. `seedPath` is used to mint.
 */
async function mintSession(seedPath: string): Promise<void> {
  const seed = await rawGet(seedPath, false);
  const sid = extractJsessionId(seed);
  if (!sid) throw new RfafError(seed.status, 'RFAF: could not mint session (no JSESSIONID)');
  sessionCookie = sid;
  await rawGet(ACTIVATE_PATH, true); // activate the cookie
}

/**
 * Fetch an RFAF page and return its HTML decoded from ISO-8859-15.
 * Handles the session handshake and a single re-mint on session expiry.
 */
export async function fetchRfafHtml(path: string): Promise<string> {
  if (!sessionCookie) await mintSession(path);

  let res = await rawGet(path, true);
  if (res.status >= 300 && res.status < 400) {
    // Session lapsed (redirect to NLogin); re-mint once and retry.
    await mintSession(path);
    res = await rawGet(path, true);
  }

  if (!res.ok) {
    throw new RfafError(res.status, `RFAF ${res.status} for ${path}`);
  }

  const buf = await res.arrayBuffer();
  return new TextDecoder('iso-8859-15').decode(buf);
}
