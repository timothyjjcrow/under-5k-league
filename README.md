# GGD2L

A cleaner, simpler, fully-functional amateur Dota 2 league site. Players sign in
with Steam, join the current season, get drafted onto teams via a live auction,
and play a weekly round-robin into playoffs until a champion is crowned — then it
all starts again.

The UI is deliberately minimal: a **season state machine** drives everything, so
the site only ever shows what's relevant to the current phase.

```
SIGNUPS  →  DRAFT  →  REGULAR_SEASON  →  PLAYOFFS  →  COMPLETE  →  (next season)
```

## Features

- **Steam sign-in** (OpenID 2.0) with a dev/mock login for local testing. Real
  logins pull the player's **Steam name + avatar** via the Steam Web API; admins
  can bulk "Sync avatars" and players can refresh from their profile.
- **Signups** with live progress toward the minimum needed to start, and an
  optional **MMR cap** (e.g. an under-4.5K league) that blocks over-cap players.
- **Standins** — sign up to fill in for teams without committing full-time.
- **Live auction draft** — captains take turns nominating players and bidding,
  with a shared countdown clock, budget/roster constraints, and auto-resolution.
- **Round-robin schedule**, standings, weekly results entry.
- **Real Dota match data** — after teams play, fetch the actual games from
  OpenDota (auto-detect from rosters, or paste a match id/URL). Winners and
  series scores are recorded automatically, with full box scores (heroes, KDA)
  on a match detail page.
- **Team & player pages** — rosters, records, and fixtures, a "My Team"
  shortcut in the nav, and profiles where players link their **Dota/Dotabuff
  account** to show their **ranked medal** — a resource for captains at draft
  time (medals appear in the player pool and draft room).
- **Player scouting profiles** — on signup players pick their **preferred
  roles**, list **favorite heroes**, and write what they want from the league +
  a **note to captains**; all of it shows in the player pool and draft room.
- **In-client Dota league** — register the league at dota2.com/league, save the
  **league id**, host matches in private lobbies tagged with it, and one-click
  **sync** pulls every league game automatically (no manual match ids).
- **Match scheduling** — admins set match date/times; players see when they play
  next on their dashboard, team page, and the schedule.
- **Admin control panel** to run the whole league (phases, captains, draft,
  schedule, results) — hidden unless you're an admin.
- **Smooth UX** — toast notifications on every action, graceful
  error/not-found/loading states, and confirmations on destructive actions.

## Tech stack

- **Next.js 16** (App Router, React 19, TypeScript) — server components + server
  actions + route handlers.
- **Tailwind CSS v4** for styling.
- **Prisma 5 + SQLite** — zero-config local database (easy to swap to Postgres).
- **jose** for signed session cookies.
- **Vitest** (unit) + **Playwright** (e2e) for tests.

## Getting started

Requires Node ≥ 20.18.

```bash
npm install
cp .env.example .env      # then edit as needed
npm run db:push           # create the SQLite database
npm run db:seed           # seed an admin, a season, and demo players
npm run dev               # http://localhost:3000
```

### Logging in locally

With `ALLOW_DEV_LOGIN=true` (the default in `.env`), the login page shows quick
dev-login buttons. You can also hit the endpoint directly:

```
/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1
```

### Enabling real Steam login

1. Get a Steam Web API key: https://steamcommunity.com/dev/apikey
2. Set `STEAM_API_KEY` and `APP_URL` in `.env`.
3. Set `ADMIN_STEAM_IDS` to the SteamID64s that should be admins.
4. Set `ALLOW_DEV_LOGIN=false` for production.

### Match data (OpenDota)

Real games are pulled from the free [OpenDota API](https://docs.opendota.com/) —
Dotabuff has no public API, so OpenDota (built on the same Valve data) is used.
Each player's SteamID converts to a Dota `account_id`, so a fetched game's
players are matched to your rosters to decide who played and who won.

From the admin panel, for any match you can:
- **Auto-fetch games** — scans both rosters' recent games and imports any that
  are a match between the two teams. Requires players to enable *Settings →
  Options → Expose Public Match Data* in Dota.
- **Add game** — paste a match id or an OpenDota/Dotabuff URL to import a
  specific game (bulletproof; works as long as the match itself is public).

Imported games set the series score and (for playoff games) advance the bracket
automatically. Set `OPENDOTA_API_KEY` for higher rate limits (optional).

Players' **ranked medals** come from the same source (OpenDota `rank_tier`) —
link a Dotabuff/OpenDota URL on your profile, or an admin can populate everyone's
at once with the **Sync ranks** button before the draft.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` / `start` | Production build / serve |
| `npm run db:push` | Apply the Prisma schema to SQLite |
| `npm run db:seed` | Reset + seed demo data |
| `npm run db:reset` | Force-reset the DB and reseed |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:e2e` | Run end-to-end tests (Playwright) |

## Project structure

```
src/
  app/
    page.tsx            # phase-aware dashboard
    login/ me/ players/ draft/ schedule/ admin/
    actions/            # server actions (registration, admin)
    api/
      auth/             # steam, dev, logout, callback
      draft/            # tick (poll), nominate, bid
  components/           # ui kit, site header, draft room
  lib/
    draft.ts            # pure auction rules (tested)
    standings.ts        # pure standings math (tested)
    schedule.ts         # pure round-robin/bracket (tested)
    capacity.ts         # pure signup capacity (tested)
    draft-service.ts    # transactional draft engine (DB)
    auth.ts steam.ts users.ts season.ts queries.ts prisma.ts
prisma/
  schema.prisma  seed.ts
e2e/                    # Playwright tests
```

## Testing

- **Unit** — the pure logic (auction math, standings, scheduling, capacity) is
  covered by Vitest: `npm test`.
- **End-to-end** — Playwright drives a real browser through sign-in, signup, and
  admin flows: `npm run test:e2e` (runs `db:seed` first via global setup).

## Deployment (Vercel + Neon — free)

Local dev stays on SQLite; production runs on Postgres via a build-time provider
swap (`scripts/switch-db-provider.mjs`, wired up in `vercel.json`) — you don't
change any code. The draft uses HTTP polling (no websockets), so it runs fine on
serverless.

1. **Create a free Neon Postgres DB** at [neon.tech](https://neon.tech). From the
   connection details, copy **two** strings:
   - the **pooled** one (host contains `-pooler`) → use for `DATABASE_URL`
   - the **direct** one (no `-pooler`) → use for `DIRECT_URL`
2. **Push this repo to GitHub** (`git init && git add -A && git commit -m init`,
   create a repo, push). `.env` is gitignored so your secrets stay local.
3. **Import the repo at [vercel.com](https://vercel.com)** (New Project → pick the
   repo). It auto-detects Next.js; the build command is already in `vercel.json`.
4. **Set Environment Variables** (Vercel → Project → Settings → Environment
   Variables):

   | Var | Value |
   | --- | --- |
   | `DATABASE_URL` | Neon **pooled** URL |
   | `DIRECT_URL` | Neon **direct** URL |
   | `AUTH_SECRET` | long random string (`openssl rand -hex 32`) |
   | `STEAM_API_KEY` | your **rotated** Steam Web API key |
   | `APP_URL` | `https://<your-project>.vercel.app` |
   | `ADMIN_STEAM_IDS` | your SteamID64 (guarantees you're admin) |
   | `OPENDOTA_API_KEY` | optional |

   Leave `ALLOW_DEV_LOGIN` unset — dev login stays disabled in production.

   > Scope `DATABASE_URL`/`DIRECT_URL` to the **Production** environment (or
   > point Preview at a separate branch database). Builds only run
   > `prisma db push` on production deploys (`scripts/build-db.mjs`), but a
   > preview deploy sharing the prod URL still *runs* against the live data.
5. **Deploy.** The build swaps Prisma to Postgres, runs `prisma db push`
   **on production deploys only** (creates the tables in Neon via
   `DIRECT_URL`; previews just generate the client), and builds the app.
6. **First login = admin.** Open your site → **Sign in through Steam**. The first
   user is auto-granted admin; then go to **/admin**, create your season, and set
   the **MMR cap** (4500). Steam pulls everyone's name + avatar automatically.

Update `APP_URL` if you add a custom domain, so Steam login redirects back
correctly.

### Backups

The league's entire history lives in that one database — back it up before
schema changes and on a habit cadence:

```bash
# Production (paste the Neon DIRECT url; needs pg_dump — brew install postgresql)
DATABASE_URL="postgres://…direct…" npm run db:backup
# Local dev (copies the SQLite file)
npm run db:backup
```

Timestamped dumps land in `backups/` (gitignored). Restore Postgres with
`psql "$URL" < backups/<file>.sql`; for SQLite just copy the `.db` file back.

### Uptime monitor (recommended)

Point a free uptime monitor (UptimeRobot etc., 5-minute interval) at
`GET https://<your-site>/api/sync`. That buys two things at once: you're
alerted if the site goes down, and the automatic result sync gets a heartbeat
even when nobody has a page open (it's lazy by design — a match finishing at
1am with zero visitors would otherwise wait for the morning's first page view).

### Alternatives (keep SQLite, no DB change)
**Fly.io / Railway / a cheap VPS** can run `next start` with a persistent volume
holding the `.db` file. ~$0–5/mo.

## Notes

- SQLite doesn't support Prisma enums, so status/type/role fields are strings
  validated in `src/lib/constants.ts`. This is structured for an easy move to
  Postgres + native enums later.
- The draft is server-authoritative and polled (`/api/draft/tick`), which keeps
  it robust and easy to test without a websocket layer.
