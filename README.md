# Footbar Stats — Backend

API server for [Footbar Stats](https://github.com/perezga/footbar-stats-frontend), a personal web app for viewing your stats from the [Footbar API](https://developers.footbar.com/docs/reference/).

The backend holds the OAuth client secret, runs the Footbar OAuth flow, caches Footbar responses in SQLite to stay under the rate limit, and exposes a clean JSON API to the frontend.

**Stack:** Node · [Fastify](https://fastify.dev/) · TypeScript · [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) · [Zod](https://zod.dev/)

---

## Prerequisites

- Node 22+
- `openssl` (for the local TLS cert)
- A Footbar developer app (see below)

## Setup

### 1. Register your app with Footbar

1. Go to <https://developers.footbar.com/apps/create/>.
2. Fill in the form:
   - **Redirect URI**: `https://localhost:4000/auth/callback` *(Footbar requires `https://`)*
   - **Scope**: `read`
3. Save the `client_id` and `client_secret` — the secret is shown only once.

### 2. Generate a local TLS cert

The redirect URI must be HTTPS, so the server runs over TLS in dev with a self-signed cert. Generate it once:

```bash
npm install
npm run cert
```

This writes `certs/cert.pem` and `certs/key.pem` (both gitignored). The first time you open `https://localhost:4000/` in a browser, accept the certificate warning once.

### 3. Configure environment

The three secrets are read from your shell environment. Export them (e.g. in
your `.bashrc`/`.profile` or via direnv):

```bash
export FOOTBAR_CLIENT_ID="your-client-id"
export FOOTBAR_CLIENT_SECRET="your-client-secret"
export COOKIE_SECRET="$(openssl rand -hex 32)"
```

For native dev (`npm run dev`) a `.env` file is also picked up if you prefer one
(`cp .env.example .env`). The Docker setup, however, reads **only** from the
exported environment variables — see [Run with Docker](#run-with-docker).

| Variable | Required | Default | Notes |
|---|:---:|---|---|
| `FOOTBAR_CLIENT_ID` | ✅ | — | From your Footbar app |
| `FOOTBAR_CLIENT_SECRET` | ✅ | — | From your Footbar app |
| `COOKIE_SECRET` | ✅ | — | ≥16 chars; `openssl rand -hex 32` |
| `REDIRECT_URI` | | `https://localhost:4000/auth/callback` | Must match Footbar app |
| `FRONTEND_ORIGIN` | | `http://localhost:5173` | CORS allow-origin |
| `PORT` | | `4000` | |
| `HOST` | | `127.0.0.1` | Set to `0.0.0.0` in containers |

### 4. Run

```bash
npm run dev      # tsx watch — reloads on change
```

The server listens on <https://localhost:4000>. Health check: `GET /health` → `{ "ok": true }`.

## Run with Docker

The frontend and backend each have their own compose file and talk over a shared external network. Compose reads the three secrets from your **exported** shell environment (`${FOOTBAR_CLIENT_ID}`, `${FOOTBAR_CLIENT_SECRET}`, `${COOKIE_SECRET}`) — if any is unset, `docker compose up` fails fast with a clear message:

```bash
docker network create footbar-net   # once, shared with the frontend
export FOOTBAR_CLIENT_ID="…" FOOTBAR_CLIENT_SECRET="…" COOKIE_SECRET="…"
npm run cert                         # if certs/ don't exist yet
docker compose up --build
```

`HOST` is overridden to `0.0.0.0` in the container so the published port is reachable, and the frontend reaches this service by the network alias `backend` (`https://backend:4000`). Source is bind-mounted, so `tsx watch` still hot-reloads.

## API

All `/api/*` routes require an authenticated session cookie (set by the OAuth flow).

### Auth
| Method | Path | Description |
|---|---|---|
| `GET` | `/auth/login` | Start the OAuth flow (redirects to Footbar) |
| `GET` | `/auth/callback` | OAuth redirect target; exchanges code, sets session cookie |
| `GET` | `/auth/status` | Whether the current session is authenticated |
| `POST` | `/auth/logout` | Clear the session |

### Data
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/profile` | Cached profile (24h TTL) |
| `GET` | `/api/sessions` | Cached session list (1h TTL) |
| `POST` | `/api/sessions/refresh` | Force-refresh the session list from Footbar |
| `GET` | `/api/sessions/:id` | Session detail (cached forever once fetched) |
| `GET` | `/api/stats/records` | Personal records, computed in SQL |
| `GET` | `/api/stats/trends` | Trends over time, computed in SQL |

### Rate limits & caching

The Footbar free tier allows **100 requests/week**, so the backend caches aggressively:

- **Profile** — 24h TTL
- **Sessions list** — 1h TTL (manual refresh from the UI)
- **Session details** — cached forever (sessions are immutable)
- **Records + trends** — computed in SQL from cached sessions, zero upstream calls

A normal browsing session costs ~3 upstream calls (profile + list + N new session details).

## Project structure

```
src/
  server.ts          Fastify bootstrap (TLS, CORS, cookies, route registration)
  env.ts             Zod-validated environment config
  db.ts              SQLite schema + connection (data/footbar.db)
  oauth/             PKCE helpers + token storage/refresh
  footbar/           Typed Footbar API client
  cache/             Profile / sessions caching + derived stats
  routes/            auth, profile, sessions, stats
scripts/gen-cert.sh  Self-signed dev cert generator
```

The SQLite database lives at `data/footbar.db` (gitignored — it holds your OAuth tokens).

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run with `tsx watch` (hot reload) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build (`node dist/server.js`) |
| `npm run typecheck` | Type-check without emitting |
| `npm run cert` | Generate the self-signed dev cert |
