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

### Enabling Discord account linking

Players can prove they own their Discord account ("Link Discord" on `/me`) via
Discord OAuth2 with the minimal `identify` scope — the site stores only the
account id + username (no tokens, no email), and rosters show a ✓ on verified
handles. Typed handles still work as an unverified fallback.

1. Create an application at https://discord.com/developers/applications
2. OAuth2 → add `<APP_URL>/api/auth/discord/callback` as a **Redirect**.
3. Set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` in `.env`.

### Live inhouse queue board (Discord)

A single pinned Discord message that shows how many players are in the inhouse
queue and **rewrites itself in place** as people come and go — a live count
with no new messages, ever. Editing a message doesn't notify anyone, mark the
channel unread, or bump it, so the channel stays quiet.

1. In Discord, make a webhook **in your inhouse channel** (Server Settings →
   Integrations → Webhooks → New Webhook) and paste it into Admin → Discord
   notifications → **Inhouse channel**. A webhook only ever posts to the
   channel it was created in, so this is what keeps the board — plus "match
   found", the queue ping and inhouse results — out of your league-
   announcement channel. Leave it blank and everything shares one channel.
2. Hit **Post queue board**.
3. In Discord, right-click the message → **Pin Message**. Do not skip this: an
   edited message never moves, so in a chatty channel it scrolls away.

It shows the queue filling (with names), the ready check, drafting, and a live
game, and returns to "queue is empty" on its own. Nothing is posted while the
state is unchanged. The board *informs* — the separate "queue is almost full"
ping is what actually alerts people, and it still fires as before.

Because the site is lazy (no cron), the board updates whenever someone has a
page open. If literally nobody is on the site the count freezes — the message
carries a live "updated 12 minutes ago" stamp so staleness is visible rather
than hidden, and the uptime monitor below is what keeps it honest overnight.

Removing the webhook or pointing it at a different channel removes the board
first, so it can't be left stranded showing a frozen number.

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
| `npm run db:seed` | **Destructive** — wipe the DB and seed demo data |
| `npm run db:reset` | **Destructive** — force-reset the DB and reseed |
| `npm run db:backup` | Back up the DB (pg_dump for Postgres, file copy for SQLite) |
| `npm run set-admins` | Reconcile existing accounts to `ADMIN_STEAM_IDS` |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:integration` | Run integration tests (isolated `prisma/test.db`) |
| `npm run test:pg` | Run the integration suite against **Postgres** (see below) |
| `npm run test:e2e` | Run end-to-end tests (Playwright) |
| `npm run test:e2e:mid` | Run the mid-season browser suite |

> **The two destructive scripts refuse to run against a non-local database.**
> `db:seed` deletes every row and `db:reset` drops the schema first, so both
> abort unless `DATABASE_URL` is a local `file:` url. That matters because the
> backup recipe below has you put the *production* url on a command line — one
> shell-history recall from wiping the live league. To override deliberately:
> `I_UNDERSTAND_THIS_WIPES_THE_DATABASE=1 npm run db:seed`.

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
- **Against Postgres** — production runs Postgres while everything local runs
  SQLite, which serializes writers and therefore hides the write races the
  auction/inhouse guards exist for. To run the whole integration suite on the
  real engine:

  ```bash
  # any throwaway Postgres (a local cluster or a scratch Neon branch)
  export PG="postgresql://user@127.0.0.1:5432/ld2l_scratch"
  node scripts/switch-db-provider.mjs postgresql
  DATABASE_URL="$PG" DIRECT_URL="$PG" npx prisma db push --accept-data-loss
  DATABASE_URL="$PG" DIRECT_URL="$PG" npx prisma generate
  PG_TEST_URL="$PG" npm run test:pg
  # then put the local provider back
  node scripts/switch-db-provider.mjs sqlite && npx prisma generate
  ```

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
   | `ADMIN_STEAM_IDS` | your **SteamID64** — 17 digits starting `7656119` (see the warning below) |
   | `OPENDOTA_API_KEY` | optional |
   | `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | optional — enables "Link Discord" account verification |

   Leave `ALLOW_DEV_LOGIN` unset — dev login stays disabled in production.

   > ⚠️ **`ADMIN_STEAM_IDS` is an allowlist, not a grant — get it right or you
   > lock yourself out.** When it is set it is *authoritative*: exactly those
   > SteamID64s are admins and every other account is demoted on login,
   > including the first one. So if you paste anything other than your
   > SteamID64 — the Steam3 form `[U:1:52079950]`, a friend code, a vanity
   > name — nobody is an admin and `/admin` just redirects you away with no
   > message. **Removing the variable does not fix it**: the
   > first-user-becomes-admin bootstrap only fires when the users table is
   > empty, and by then your account exists. The fix is to *correct* the value
   > to your real SteamID64 and sign in again (or run `npm run set-admins`
   > against the production `DATABASE_URL`). Find your SteamID64 with
   > steamid.io or steamdb.info — it is 17 digits and starts `7656119`.
   > Easiest safe path: leave `ADMIN_STEAM_IDS` empty for the very first login
   > so you are bootstrapped as admin, then set it afterwards.

   > Scope `DATABASE_URL`/`DIRECT_URL` to the **Production** environment (or
   > point Preview at a separate branch database). Builds only run
   > `prisma db push` on production deploys (`scripts/build-db.mjs`), but a
   > preview deploy sharing the prod URL still *runs* against the live data.
5. **Deploy.** The build swaps Prisma to Postgres, runs `prisma db push`
   **on production deploys only** (creates the tables in Neon via
   `DIRECT_URL`; previews just generate the client), and builds the app.
6. **First login = admin.** Open your site → **Sign in through Steam**. With
   `ADMIN_STEAM_IDS` empty the first user is auto-granted admin (with it set,
   you are admin only if your SteamID64 is in it — see the warning above). Then
   go to **/admin**, create your season, and set the **MMR cap** (4500). Steam
   pulls everyone's name + avatar automatically.

Update `APP_URL` if you add a custom domain, so Steam login redirects back
correctly.

### Backups

The league's entire history lives in that one database — back it up before
schema changes and on a habit cadence:

```bash
# Production (paste the Neon DIRECT url; needs pg_dump — see the version note)
DATABASE_URL="postgres://…direct…" npm run db:backup
# Local dev (copies the SQLite file)
npm run db:backup
```

> **`pg_dump` must be at least as new as the server**, or it aborts with
> `aborting because of server version mismatch` and writes nothing. Neon runs
> Postgres 16/17, so an older client (e.g. `postgresql@14`) will refuse. Check
> and fix before you need it — not during an incident:
>
> ```bash
> pg_dump --version                      # must be >= your Neon server major
> psql "$DIRECT_URL" -tAc 'show server_version;'
> brew install postgresql@17             # then use its bin, e.g.
> PATH="$(brew --prefix postgresql@17)/bin:$PATH" DATABASE_URL="…" npm run db:backup
> ```
>
> Do a restore drill once into a scratch database — an untested backup is a
> guess: `psql "$SCRATCH_URL" < backups/<file>.sql`.

Timestamped dumps land in `backups/` (gitignored). Restore Postgres with
`psql "$URL" < backups/<file>.sql`; for SQLite just copy the `.db` file back.

### Uptime monitor (recommended)

Point a free uptime monitor (UptimeRobot etc., 5-minute interval) at
`GET https://<your-site>/api/sync`. That buys two things at once: you're
alerted if the site goes down, and the automatic result sync gets a heartbeat
even when nobody has a page open (it's lazy by design — a match finishing at
1am with zero visitors would otherwise wait for the morning's first page view).

If you use the **live inhouse queue board**, treat this as required rather than
recommended: the board can only repaint when some request runs, so without a
heartbeat a queue that empties out overnight leaves a stale count in Discord.

### Alternatives (keep SQLite, no DB change)
**Fly.io / Railway / a cheap VPS** can run `next start` with a persistent volume
holding the `.db` file. ~$0–5/mo.

## Notes

- SQLite doesn't support Prisma enums, so status/type/role fields are strings
  validated in `src/lib/constants.ts`. This is structured for an easy move to
  Postgres + native enums later.
- The draft is server-authoritative and polled (`/api/draft/tick`), which keeps
  it robust and easy to test without a websocket layer.
