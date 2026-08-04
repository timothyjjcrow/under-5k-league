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
  optional **soft MMR limit** (e.g. an under-4.5K league) that flags over-limit
  signups for admin review — only the hard 5K+ ceiling refuses anyone.
- **Standins** — sign up to fill in for teams without committing full-time.
- **Live auction draft** — captains take turns nominating players and bidding,
  with a shared countdown clock, budget/roster constraints, and auto-resolution.
- **Round-robin schedule**, standings, weekly results entry.
- **Real Dota match data** — after teams play, fetch the actual games from
  OpenDota (auto-detect from rosters, or paste a match id/URL). Winners and
  series scores are recorded automatically, with full box scores (heroes, KDA)
  on a match detail page.
- **Team & player pages** — rosters, records, and fixtures, a "My Team"
  shortcut in the nav, and profiles that show each player’s **Steam-verified
  Dota identity** and **ranked medal** — a resource for captains at draft time
  (medals appear in the player pool and draft room).
- **Player scouting profiles** — on signup players pick their **preferred
  roles**, list **favorite heroes**, and write what they want from the league +
  a **note to captains**; all of it shows in the player pool and draft room.
- **In-client Dota league** — register the league at dota2.com/league, save the
  **league id**, host matches in private lobbies tagged with it, and one-click
  **sync** pulls every league game automatically (no manual match ids).
- **Match scheduling** — admins set match date/times; players see when they play
  next on their dashboard, team page, and the schedule.
- **Evergreen inhouses** — a season-independent pickup queue with presence,
  exact queue priority, ready checks, captain voting, a snake draft, optional
  Cred betting, OpenDota result recovery, Elo/Cred ladders, and a permanent
  paginated history.
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

### Inhouse ping opt-in (Discord role)

Discord has **no native self-assignable-role toggle** — Community Onboarding is
the only built-in way, and it is a lot of server configuration for one
checkbox. So the site grants the role itself: a player ticks "Ping me for
inhouse games" on `/me` and the site adds the role over the API. It can do this
honestly because `discordId` is OAuth-proven, so it acts on an account the
player demonstrated they own.

1. Create a role in Discord (e.g. `Inhouse Ping`). Leave **Allow anyone to
   @mention this role OFF** — the site pings it through an explicit allowlist
   regardless, and keeping it off stops members spam-pinging everyone.
2. Create an application at https://discord.com/developers/applications → Bot →
   copy the token. Invite it with **Manage Roles only** (not Administrator).
3. **Drag the bot's role ABOVE the ping role** in Server Settings → Roles.
   Discord refuses to let a bot grant a role above its own; this is the single
   most common setup mistake and the site reports it as its own error.
4. Set `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` in the environment, and paste
   the role id into Admin → Discord notifications → **Ping role**.

With all four done, the toggle appears on `/me` for players who have linked
Discord, and the two interrupting inhouse alerts can mention the role. Miss any
one and the feature stays invisible rather than half-working.

**To check it worked**, the admin Discord card shows a live checklist — bot
token, server id, role chosen, bot in server, role found, and whether the bot
can actually grant it — naming the first broken step and its fix. Step 3 above
is the one nothing in Discord warns you about.

Two messages ping that role: the queue filling up, and a match being found.
Nothing else — not results, and never the board, whose edits notify nobody by
design.

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
4. Make a webhook in a SECOND channel (e.g. `#inhouse-chat`) and paste it into
   **Alerts channel**. The queue ping, "match found" and results go there, so
   the board's channel holds nothing but the board — otherwise every alert
   pushes the board out of view, which is the one thing it can't survive.

It shows the queue filling (with names), ready check, captain vote, team
preparation, live play, and the next-game queue, then returns to "queue is
empty" on its own. Nothing is posted while the state is unchanged. The board
_informs_ — the separate "queue is filling" ping at 4/10 is what actually
alerts people.

Because the site is lazy (no cron), the board updates while someone has a page
open or an uptime monitor calls `/api/sync`. If literally nobody touches the
site, the count can freeze. The admin card exposes the live-vs-posted state,
last successful edit, and consecutive failures; configure the uptime monitor
below to put an overnight bound on staleness.

Removing the board webhook or pointing it at a different channel attempts to
delete the old message first. If Discord cannot confirm that deletion, the
admin gets an explicit possible-orphan warning and must remove the old message
by hand before posting another board.

If Discord accepts a board POST but the response is lost or has no usable
message id, the site does **not** retry and risk creating a duplicate. The
admin card immediately shows an interrupted post; check the channel, remove any
untracked board, then explicitly clear that reservation before posting again.

### Inhouse recovery and chronology

Queue priority is total and stable: entries use exact `joinedAt`, then `userId`,
and formation snapshots that position as each lobby player's `queuedAt`. The
live state preserves the same order, a failed ready check restores the exact
original position, and timed auto-picks break equal MMR with
`queuedAt` + `userId`.

Cred recovery uses one shared resolver. A successful cancel or void targets
that action's own lobby before returning; global room/site heartbeats attempt up
to 25 eligible lobbies oldest-first, isolate failures per row, and rotate a
failed row to the back for the next pass. `InhouseLobby.completedAt` is the
immutable result-recency clock. Mutable `updatedAt` is only the settlement retry
cursor and must never drive a result banner or “last game” label.

The site and Discord board choose the newest **formed** completed lobby
(`createdAt`, then `id`) for proof-of-life. They report its played end from the
best played start plus `durationSecs`, falling back to `completedAt` when that
calculation is unavailable — never to `updatedAt`.

Inhouse result and void-correction messages use a durable database outbox. The
exact payload commits with the lobby change, then a leased worker sends outside
the transaction; failures remain pending with backoff and `/api/sync` drains
them even after the room empties. Discord webhooks have no idempotency key, so
a process crash after Discord accepts a message but before the worker records
`SENT` can still produce one duplicate on lease recovery. Queue alerts and the
live board use their separate best-effort/reservation workflows.

### Match data (OpenDota)

Real games are pulled from the free [OpenDota API](https://docs.opendota.com/) —
Dotabuff has no public API, so OpenDota (built on the same Valve data) is used.
Each player's SteamID converts to a Dota `account_id`, so a fetched game's
players are matched to your rosters to decide who played and who won.

From the admin panel, for any match you can:

- **Auto-fetch games** — scans both rosters' recent games and imports any that
  are a match between the two teams. Requires players to enable _Settings →
  Options → Expose Public Match Data_ in Dota.
- **Add game** — paste a match id or an OpenDota/Dotabuff URL to import a
  specific game (bulletproof; works as long as the match itself is public).

Imported games set the series score and (for playoff games) advance the bracket
automatically. Set `OPENDOTA_API_KEY` for higher rate limits (optional).

Players' **ranked medals** come from the same source (OpenDota `rank_tier`). The
Dota account is derived from each player's verified Steam sign-in; players can
refresh their own medal, or an admin can populate everyone's at once with the
**Sync ranks & stats** button before the draft (it also pulls
each player's pub-scouting snapshot — recent-games win rate, most-played
heroes, last played — which the player pool and profiles render).

## Scripts

| Script                        | Description                                                   |
| ----------------------------- | ------------------------------------------------------------- |
| `npm run dev`                 | Start the dev server                                          |
| `npm run build` / `start`     | Production build / serve                                      |
| `npm run build:vercel`        | Canonical validated PostgreSQL/Vercel deployment build        |
| `npm run db:push`             | Apply the Prisma schema to SQLite                             |
| `npm run db:seed`             | **Destructive** — wipe the DB and seed demo data              |
| `npm run db:reset`            | **Destructive** — force-reset the DB and reseed               |
| `npm run db:backup`           | Create a private, checksummed Postgres/SQLite backup          |
| `npm run db:backup:verify`    | Verify a backup against its SHA-256 sidecar                   |
| `npm run db:backup:rehearse`  | **Destructive scratch only** — restore a verified dump locally |
| `npm run db:migrate:validate` | Validate committed migration safety and the Prisma schema     |
| `npm run db:migrate:preflight` | Read-only checks for legacy data that would block migration  |
| `npm run db:migrate:postflight` | Read-only attestation of schema, migration checksums, and native objects |
| `npm run db:migrate:rehearse` | **Destructive scratch only** — rehearse fresh/legacy upgrades |
| `npm run db:migrate:baseline-check` | Read-only compatibility check for a pre-migration database |
| `npm run db:migrate:baseline-resolve` | Record the verified one-time baseline with explicit approval |
| `npm run set-admins`          | Reconcile existing accounts to `ADMIN_STEAM_IDS`              |
| `npm test`                    | Run unit tests (Vitest)                                       |
| `npm run test:integration`    | Run integration tests (isolated `prisma/test.db`)             |
| `npm run test:pg`             | Run the integration suite against guarded scratch Postgres    |
| `npm run test:e2e`            | Run end-to-end tests (Playwright)                             |
| `npm run test:e2e:mid`        | Run the mid-season browser suite                              |
| `npm run test:e2e:postseason` | Run the playoffs/completed-season browser suite              |

> **The local seed/reset scripts refuse to run against a non-local database.**
> `db:seed` deletes every row and `db:reset` drops the schema first, so both
> abort unless `DATABASE_URL` is a local `file:` URL. Never place a production
> connection URL in a command or shell history. To override the seed guard
> deliberately:
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
  auction/inhouse guards exist for. Use the managed localhost database:

  ```bash
  npm run pg:up
  export PG_TEST_URL="postgresql://${USER}@localhost:5432/ld2l_pgtest"
  npm run test:pg
  npm run pg:down
  unset PG_TEST_URL
  ```

  The suite truncates every league table. Its guard accepts only databases
  named exactly `ld2l_test` or `ld2l_pgtest`, and `pg:up`/`pg:down` additionally
  refuse non-local hosts. Never point `PG_TEST_URL` at production or a shared
  database. Always run `pg:down`; it restores the committed SQLite provider.

## Deployment (Vercel + Neon — free)

Local dev stays on SQLite; production runs on Postgres via a build-time provider
swap (`scripts/switch-db-provider.mjs`, wired up in `vercel.json`) — you don't
change any code. The draft uses HTTP polling (no websockets), so it runs fine on
serverless.

The supported runtime is **Node.js 22.x**. Run `nvm use` locally (the repository
includes `.nvmrc`), keep Vercel's Project Settings → Node.js Version on 22.x,
and do not promote a build produced with another Node major. `package.json`
declares the same runtime line used by every CI job.

1. **Create a free Neon Postgres DB** at [neon.tech](https://neon.tech). From the
   connection details, copy **two** strings:
   - the **pooled** one (host contains `-pooler`) → use for `DATABASE_URL`
   - the **direct** one (no `-pooler`) → use for `DIRECT_URL`
2. **Push this repo to GitHub.** Keep connection strings, API keys, and session
   secrets in the deployment platform or a password manager — never in a
   command, commit, issue, screenshot, or chat. `.env` is gitignored as a
   convenience, not a substitute for checking what you commit.
3. **Import the repo at [vercel.com](https://vercel.com)** (New Project → pick the
   repo). It auto-detects Next.js; the build command is already in `vercel.json`.
4. **Set Environment Variables** (Vercel → Project → Settings → Environment
   Variables):

   | Var                                           | Value                                                                |
   | --------------------------------------------- | -------------------------------------------------------------------- |
   | `DATABASE_URL`                                | Neon **pooled** PostgreSQL URL                                       |
   | `DIRECT_URL`                                  | Neon **direct** PostgreSQL URL                                       |
   | `AUTH_SECRET`                                 | unique password-manager-generated secret of at least 32 characters  |
   | `BACKUP_RECEIPT_SECRET`                       | separate random secret of at least 32 characters for backup receipts |
   | `STEAM_API_KEY`                               | your **rotated** Steam Web API key                                   |
   | `APP_URL`                                     | canonical HTTPS origin, e.g. `https://league.example`                |
   | `NEXT_PUBLIC_SITE_URL`                        | the same canonical HTTPS origin as `APP_URL`                         |
   | `ADMIN_STEAM_IDS`                             | one or more valid, unique SteamID64s, comma-separated                |
   | `OPENDOTA_API_KEY`                            | optional                                                             |
   | `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | optional — enables "Link Discord" account verification               |
   | `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID`      | optional — lets players self-assign the inhouse ping role from `/me` |

   Leave `ALLOW_DEV_LOGIN` unset or set it exactly to `false`. Production does
   not support a first-user admin bootstrap: `ADMIN_STEAM_IDS` must already
   contain at least one trusted administrator before the first deployment.

   > **`ADMIN_STEAM_IDS` is authoritative.** Exactly those accounts are admins;
   > authorization is recomputed on every authenticated request, so removing an
   > account revokes its existing admin session on the next request. Stored
   > roles are also reconciled on login. Use canonical individual SteamID64s,
   > not Steam3 IDs, friend codes, vanity names, or profile URLs. Correct the
   > allowlist if access is wrong; do not remove it and expect a production
   > bootstrap.

   > Scope `DATABASE_URL`/`DIRECT_URL` to the **Production** environment. Point
   > Preview at a separate branch database if previews need live data. The
   > migration command is a no-op outside production, but an application
   > preview that shares production credentials could still read or write live
   > league data after it starts.

5. **Deploy.** Vercel and PostgreSQL CI both run the canonical
   `npm run build:vercel` pipeline. Production uses this fail-fast sequence:

   1. validate production environment values;
   2. switch Prisma to PostgreSQL;
   3. reject unsafe committed migration SQL and validate the PostgreSQL schema;
   4. run a read-only data preflight with actionable legacy-data diagnostics;
   5. run `prisma migrate deploy` against the direct database connection;
   6. attest the resulting Prisma schema, exact migration checksums, and
      PostgreSQL-native constraints, partial indexes, functions, and triggers;
   7. generate the Prisma client; then
   8. complete `next build`.

   The preflight is read-only and no-ops on a truly empty database. The same
   invariants run again inside the migration transaction, so a write between
   preflight and deploy still fails atomically instead of bypassing the gate.

   Migrations intentionally run before compilation. Every production migration
   must therefore be additive and compatible with the currently deployed app:
   if generation or compilation fails, Vercel does not promote the new build
   and the old release keeps serving against the expanded schema. Breaking
   changes require an expand/deploy/backfill/contract sequence, with the
   contract migration released only after the old binary can no longer run.

   CI validates the committed migration history, rehearses both an empty
   database and a legacy populated database, proves postflight rejects both
   Prisma-supported and database-native drift, creates and verifies a real
   `pg_dump`, restores and fully attests it in a second scratch database, runs
   PostgreSQL integration tests, and finally exercises the exact production
   migration and build pipeline. The destructive rehearsal targets are
   hard-coded to local databases named `ld2l_pgtest` and
   `ld2l_restore_test`; the scripts refuse remote or similarly named targets.

   Environment validation rejects missing/non-PostgreSQL database URLs,
   different database or schema names, mismatched managed-provider projects,
   recognizable direct URLs used as the runtime pool, recognizable pooler URLs
   used for migrations, placeholder or short auth/backup-receipt secrets,
   missing/invalid/duplicate admin SteamIDs, non-HTTPS or divergent site
   origins, enabled dev login, and configured test-only or obsolete release
   overrides. Runtime and migration URLs may legitimately use different
   passwords and least-privilege database users. Neon and Supabase projects can
   also be matched across their standard pool/direct hosts and ports. Unknown
   providers must use the same normalized hostname and effective port; support
   for a custom pool/direct gateway pair requires an explicit reviewed
   normalization rule.

   `BUILD_DB_DRY_RUN=1` remains an exact test-only seam paired with
   `NODE_ENV=test`. `PRISMA_ACCEPT_DATA_LOSS` is obsolete, and
   `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` would permit unsafe concurrent
   migration commands. Remove all three from Vercel: production validation
   fails if any is configured. There is no production data-loss override and
   no automatic rollback; Prisma's migration advisory lock remains mandatory.

   **One-time baseline for a database created by the old `db push` process:**

   1. create a full backup, verify it, and complete a restore rehearsal;
   2. run `npm run db:migrate:baseline-check` with trusted production
      `DIRECT_URL`/`DATABASE_URL` environment variables;
   3. with production `DIRECT_URL` set (the resolver intentionally has no
      pooled-URL fallback), run
      `npm run db:migrate:baseline-resolve -- --apply` only if that read-only
      fingerprint passes;
   4. deploy normally so `20260804010000_release_readiness` is applied.

   Stop and reconcile the database if the baseline check reports any
   difference. Never mark the baseline applied merely to get past a failed
   deploy. A brand-new empty database does **not** need this procedure;
   `prisma migrate deploy` applies the baseline and later migrations itself.
   The guarded resolver repeats the exact read-only check immediately before
   writing migration metadata, keeps credentials out of process arguments, and
   never changes the committed SQLite schema or generated client. Omitting
   `--apply` fails before any database mutation.
6. **Sign in with an allowlisted Steam account.** Then go to **/admin**, create
   the season, and set the MMR cap. Steam pulls names and avatars automatically.

Update `APP_URL` if you add a custom domain, so Steam login redirects back
correctly.

### Backups

The league's entire history lives in that one database. Back it up on a regular
schedule and before every schema change. Supply `DIRECT_URL` through a trusted
secret manager or a private shell environment, never as a literal command-line
argument; then run:

```bash
npm run db:backup
npm run db:backup:verify -- backups/<backup-file>.sql
```

The backup command uses `DIRECT_URL` in preference to `DATABASE_URL`, parses it,
and gives `pg_dump` dedicated libpq environment fields (`PGHOST`, `PGPORT`,
`PGDATABASE`, `PGUSER`, `PGPASSWORD`, and supported TLS options) instead of a
credential-bearing argv value. It clears conflicting inherited connection
fields first. The command writes to a temporary file, rejects empty output,
creates a SHA-256 sidecar, and then atomically publishes the artifact, checksum,
and credential-free database identity metadata. `backups/` is mode `0700`;
every artifact and sidecar is `0600`; failed runs remove partial output. SQLite
uses its online backup API rather than a byte copy and requires the resulting snapshot to pass
`PRAGMA integrity_check` before publication. That local-development path
requires the `sqlite3` command-line client and fails safely if it is absent.

> **`pg_dump` must be at least as new as the server**, or it aborts with
> `aborting because of server version mismatch` and writes nothing. Check the
> deployed server and client versions before you need a recovery, not during an
> incident:
>
> ```bash
> pg_dump --version                      # must be >= your Neon server major
> # Load PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD from your secret manager.
> psql -X -tAc 'show server_version;'
> npm run db:backup
> ```
>
> If the majors are incompatible, install a matching/newer PostgreSQL client
> with your package manager and ensure that client's `pg_dump` is on `PATH`.

`db:backup:verify` proves that the bytes still match the sidecar; it does **not**
prove that a SQL dump can be restored or that the restored league is coherent.
When `BACKUP_RECEIPT_SECRET` is configured, verifying a new metadata-bearing
backup also prints a signed `ld2l-backup-v1.…` receipt. A production permanent
season deletion requires that receipt: it must identify the current logical
PostgreSQL database, represent a complete database dump, and both the backup
and verification must be less than 24 hours old. Paste it only into the
hard-delete dialog. Treat the receipt as a short-lived destructive capability:
run verification only in a private terminal and never copy the receipt into CI
logs, issues, or chat. CI uses a disposable database and a synthetic signing
secret. A SQLite receipt never authorizes a production delete.

The downloadable season JSON is explicitly an **audit/reference archive**. It
has no importer, cannot restore foreign-key graphs, is not a full database
backup, and does not satisfy the deletion gate.

Receipt verification still does **not** prove restorability. Therefore, run a
guarded local restore rehearsal before a migration release. The command verifies
the dump again, drops and recreates **only** the exact local database
`ld2l_restore_test`, restores in one transaction, and checks completed migrations
plus core league tables:

```bash
export PG_RESTORE_TEST_URL="postgresql://${USER}@localhost:5432/ld2l_restore_test"
npm run db:backup:rehearse -- backups/<backup-file>.sql
unset PG_RESTORE_TEST_URL
```

It requires compatible `psql`, `dropdb`, and `createdb` clients and a local role
that may recreate that scratch database. Remote hosts and similarly named
databases are rejected before a client runs.

Also run a provider-level recovery drill periodically into a new, disposable,
non-production hosted database. Load its connection as separate libpq
environment fields from a secret manager so the credential is not exposed in
argv:

```bash
npm run db:backup:verify -- backups/<backup-file>.sql
psql -X --set ON_ERROR_STOP=on --single-transaction \
  --file backups/<backup-file>.sql
```

The drill is successful only after the restore exits cleanly, expected seasons,
users, teams, matches, and games have plausible counts, and the app can start
against the scratch database and render the current season. Record the drill
date/result, then destroy the scratch database. For SQLite, copy the `.db` to a
disposable path and open/test that copy; never overwrite the live file during a
drill.

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
