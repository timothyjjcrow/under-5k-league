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
  can bulk "Sync avatars" and players can refresh from My account (`/me`).
- **Signups** with live progress toward the minimum needed to start, and an
  optional **soft MMR limit** (e.g. an under-4.5K league) that flags over-limit
  signups for admin review — only the hard 5K+ ceiling refuses anyone.
- **Standins** — sign up to fill in for teams without committing full-time.
- **Live auction draft** — captains take turns nominating players and bidding,
  with a shared countdown clock, budget/roster constraints, and auto-resolution.
- **Round-robin schedule**, standings, weekly results entry.
- **Steam lobby bot** — captains can create the active in-house Dota lobby
  with Captains Mode, US East, and the in-house ticket, then start after roster
  verification. The bot invites the players in Dota once the lobby is ready,
  and the panel shows who is in it. Uses a dedicated Steam account and a
  small background worker; no Dota download is needed. Season hosting is
  disabled by default. See [setup and operation](docs/DOTA-LOBBY-BOT.md).
- **Real Dota match data** — after teams play, fetch the actual games from
  OpenDota (auto-detect from rosters, or paste a match id/URL). Winners and
  series scores are recorded automatically, with full box scores (heroes, KDA)
  on a match detail page.
- **Team & player pages** — rosters, records, and fixtures (captains can rename
  their team and set its logo), a "My Team" shortcut in the nav, and profiles that show each player’s **Steam-verified
  Dota identity** and **ranked medal** — a resource for captains at draft time
  (medals appear in the player pool and draft room).
- **Player scouting profiles** — on signup players pick their **preferred
  roles**, list **favorite heroes**, and write an optional **About you** note
  for captains; all of it shows in the player pool and draft room.
- **In-client Dota league** — register the league at dota2.com/league, save the
  **league id**, host matches in private lobbies tagged with it, and one-click
  **sync** pulls every league game automatically (no manual match ids).
- **Match scheduling** — admins set match date/times; players see when they play
  next on their dashboard, team page, and the schedule.
- **Evergreen inhouses** — a season-independent pickup queue with presence,
  exact queue priority, ready checks, captain voting, a snake draft, OpenDota
  result recovery, an Elo ladder, and a permanent paginated history.
- **Admin control panel** to run the whole league (phases, captains, draft,
  schedule, results) — hidden unless you're an admin.
- **Smooth UX** — toast notifications on every action, graceful
  error/not-found/loading states, and confirmations on destructive actions.

## Tech stack

- **Next.js 16** (App Router, React 19, TypeScript) — server components + server
  actions + route handlers.
- **Tailwind CSS v4** for styling.
- **Prisma 5** — zero-config SQLite locally and migration-managed PostgreSQL in
  production.
- **jose** for signed session cookies.
- **Vitest** (unit) + **Playwright** (e2e) for tests.

## Getting started

Requires Node.js 22.x (`nvm use` reads `.nvmrc`). Local SQLite backups use
`node:sqlite`, which needs 22.16 or newer.

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
Discord OAuth2. The site always requests `identify`; when the bot and guild are
configured it also requests `guilds.join` so the player can join the league
server. The site stores only the account id + username, does not request email,
and discards the temporary OAuth access token after the callback. Rosters show
a ✓ on verified handles. Typed handles still work as an unverified fallback.

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
   copy the token. Invite it with **Manage Roles**, **Create Invite** and
   **Create Events** (not Administrator). Manage Roles powers the ping toggle;
   Discord requires Create Invite for the automatic `guilds.join` performed
   while linking an account; Create Events lets an inhouse night appear in the
   server's Events (without it the night is still announced, with no event).
3. **Drag the bot's role ABOVE the ping role** in Server Settings → Roles.
   Discord refuses to let a bot grant a role above its own; this is the single
   most common setup mistake and the site reports it as its own error.
4. Set `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` in the environment, and paste
   the role id into Admin → Discord notifications → **Ping role**.

With all four done, the toggle appears on `/me` for players who have linked
Discord, and the two interrupting inhouse alerts can mention the role. Miss any
one and the feature stays invisible rather than half-working.

**To check it worked**, the admin Discord card shows a live checklist — bot
token, server id, role chosen, bot in server, role found, matching OAuth app,
Create Invite, and whether the bot can actually grant the role — naming the
first broken step and its fix. Step 3 above is the one nothing in Discord warns
you about.

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

The authenticated maintenance runner attempts a board repaint every minute
even when nobody has the site open. Inhouse room reads can also advance
interactive room state, but public page traffic is not the production clock.
The admin panel
exposes both the board's live-vs-posted state and the persisted automation
runner health; a stale or failed runner is an operator incident, not something
an uptime monitor should repair by calling a public mutation endpoint.

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

`InhouseLobby.completedAt` is the immutable result-recency clock. Mutable
`updatedAt` changes on any later write to the row and must never drive a result
banner or “last game” label.

The site and Discord board choose the newest **formed** completed lobby
(`createdAt`, then `id`) for proof-of-life. They report its played end from the
best played start plus `durationSecs`, falling back to `completedAt` when that
calculation is unavailable — never to `updatedAt`.

Inhouse result and void-correction messages use a durable database outbox. The
exact payload commits with the lobby change, then a leased worker sends outside
the transaction; failures remain pending with backoff and the authenticated
maintenance runner drains them even after the room empties. Recovery also
reconstructs a missing result outbox row and Elo snapshot from a completed
lobby if a process died between the source-state commit and finalization.

League-channel announcements use a second durable, globally ordered outbox.
Series results, champions, reminders, and weekly honors pair a 90-second marker
lease with a stable dedupe key, so a crash before enqueue is reclaimable and a
crash after enqueue does not create another database event. Both outboxes use
token-fenced 30-second delivery claims and retry backoff. Discord webhooks have
no idempotency key, so a process crash after Discord accepts a message but
before the worker records `SENT` can still produce one duplicate on lease
recovery: delivery is deliberately at-least-once, not exactly-once. Queue
alerts and the live board use their separate best-effort/reservation workflows.

### Match data (OpenDota)

Real games are pulled from the [OpenDota API](https://docs.opendota.com/), which
currently offers free and paid usage tiers. Dotabuff has no public API, so
OpenDota (built on the same Valve data) is used. Each player's SteamID converts
to a Dota `account_id`, so a fetched game's players are matched to your rosters
to decide who played and who won.

From the admin panel, for any match you can:

- **Auto-fetch games** — scans both rosters' recent games and imports any that
  are a match between the two teams. Requires players to enable _Settings →
  Options → Expose Public Match Data_ in Dota.
- **Add game** — paste a match id or an OpenDota/Dotabuff URL to import a
  specific game (bulletproof; works as long as the match itself is public).

Imported games set the series score and (for playoff games) advance the bracket
automatically. Set `OPENDOTA_API_KEY` for higher rate limits (optional).
Turning **Expose Public Match Data** off can stop future automatic discovery;
it does not delete league history already imported here or data OpenDota
already collected.

Players' **ranked medals** come from the same source (OpenDota `rank_tier`). The
Dota account is derived from each player's verified Steam sign-in; players can
refresh their own medal. The automation worker also refreshes a few of the
stalest accounts about once an hour (medal, Steam name and avatar, and each
player's pub-scouting snapshot — recent-games win rate, most-played heroes,
last played — which the player pool and profiles render), and an admin can
refresh every signup at once with **Refresh player data now** before the
draft.

## Scripts

| Script                                                     | Description                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`                                              | Start the dev server                                                           |
| `npm run build` / `start`                                  | Production build / serve                                                       |
| `npm run build:vercel`                                     | The production build the box runs (name kept); its database attestation is read-only |
| `npm run release:both`                                     | Release both leagues on the box ([docs/RELEASING.md](docs/RELEASING.md))      |
| `npm run db:push`                                          | Apply the Prisma schema to SQLite                                              |
| `npm run db:seed`                                          | **Destructive** — wipe the DB and seed demo data                               |
| `npm run db:reset`                                         | **Destructive** — force-reset the DB and reseed                                |
| `npm run db:backup`                                        | Create a private, checksummed Postgres/SQLite backup                           |
| `npm run db:backup:verify`                                 | Verify a backup against its SHA-256 sidecar                                    |
| `npm run db:backup:rehearse`                               | **Destructive scratch only** — restore a verified dump locally                 |
| `npm run db:migrate:validate`                              | Validate committed migration safety and the Prisma schema                      |
| `npm run db:migrate:preflight`                             | Read-only checks for legacy data that would block migration                    |
| `npm run db:migrate:postflight`                            | Read-only attestation of schema, migration checksums, and native objects       |
| `npm run db:migrate:release -- --apply <40-char HEAD SHA>` | Apply a reviewed production migration release from a clean ephemeral checkout  |
| `npm run db:migrate:failed-resolve -- --apply <40-char HEAD SHA> <migration-name>` | Guardedly record one proven fully rolled-back failed migration for retry |
| `npm run db:migrate:rehearse`                              | **Destructive scratch only** — rehearse fresh/legacy upgrades                  |
| `npm run db:migrate:baseline-check`                        | Read-only compatibility check for a pre-migration database                     |
| `npm run db:migrate:baseline-resolve`                      | Record the verified one-time baseline with explicit approval                   |
| `npm run set-admins`                                       | Reconcile existing accounts to `ADMIN_STEAM_IDS`                               |
| `npm test`                                                 | Run unit tests (Vitest)                                                        |
| `npm run test:integration`                                 | Run integration tests (isolated `prisma/test.db`)                              |
| `npm run test:pg`                                          | Run the integration suite against guarded scratch Postgres                     |
| `npm run test:e2e`                                         | Run end-to-end tests (Playwright)                                              |
| `npm run test:e2e:mid`                                     | Run the mid-season browser suite                                               |
| `npm run test:e2e:postseason`                              | Run the playoffs/completed-season browser suite                                |

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
    page.tsx            # dashboard: loads data, picks the phase
    login/ me/ players/ draft/ schedule/ admin/
    matches/[id]/       # match page: load.ts + one file per card
    actions/            # server actions (registration, admin-*.ts by job)
    api/
      auth/             # steam, dev, logout, callback
      draft/            # tick (poll), nominate, bid
      cron/automation/  # authenticated one-minute maintenance entry point
      health/           # dependency-free live and database-ready probes
      sync/             # read-only browser cursor/watch snapshot
  components/           # ui kit, site header, draft room
    home/               # dashboard hero and per-phase views
  lib/
    draft.ts            # pure auction rules (tested)
    standings.ts        # pure standings math (tested)
    schedule.ts         # pure round-robin/bracket (tested)
    capacity.ts         # pure signup capacity (tested)
    draft-service.ts    # transactional draft engine (DB)
    automation-service.ts result-sync-service.ts
    league-announcement-outbox.ts inhouse-announcement-outbox.ts
    auth.ts steam.ts users.ts season.ts queries.ts prisma.ts
prisma/
  schema.prisma  migrations/  seed.ts
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
  database, and never run any test suite, `pg:up` or `db:push` on the
  production box: its localhost Postgres is production. Always run `pg:down`;
  it restores the committed SQLite provider.

## Deployment (self-hosted)

**To release, start at [docs/RELEASING.md](docs/RELEASING.md).** Both leagues
ship the same commit through `npm run release:both`; that page covers the
routine release, what a run checks and how to roll back, and links back here
and to [docs/PRODUCTION-OPERATIONS.md](docs/PRODUCTION-OPERATIONS.md) for the
guarded procedures. This section is the hosting setup and the detailed
migration, rollback, backup and health procedures. The box kit and its
runbook are in `ops/selfhost/` (`ops/selfhost/README.md`). The full docs
index is [docs/README.md](docs/README.md).

> **Status: live.** Both leagues moved from Vercel and Neon to the box on
> 2026-10-17 (US 15:43Z, Europe 16:24Z; [DECISIONS](docs/DECISIONS.md#hosting)).
> The old Vercel origins only redirect. The Vercel and Neon setup this section
> replaced is at `git show 33a1f348:README.md`; it no longer applies.

Both leagues run on one DigitalOcean droplet, `ggd2l-1` (Ubuntu 24.04, 1
vCPU, 2 GB RAM plus 4 GB swap):

```
Browser ─HTTPS─> Cloudflare (us / eu / apex / www: proxied CNAMEs to the tunnel)
                   │ Cloudflare Tunnel (outbound from the box; only SSH listens publicly)
                   ▼
ggd2l-1   cloudflared ─> Caddy 127.0.0.1:8080
                           ├─ us.ggd2l.com  ─> 127.0.0.1:3001 | 3002   (US slots a | b)
                           ├─ eu.ggd2l.com  ─> 127.0.0.1:3011 | 3012   (Europe slots a | b)
                           └─ ggd2l.com, www ─> 302 https://us.ggd2l.com{uri}
          PostgreSQL 18 on 127.0.0.1:5432 (ggd2l_us, ggd2l_eu)
          lobby bot on 127.0.0.1:8090 (since 2026-10-18; the sites call it over loopback,
                                       its relay socket is the rollback path)
Cloudflare Workers: the one-minute schedulers -> https://{us,eu}.ggd2l.com/api/cron/automation
R2 bucket ggd2l-backups: age-encrypted dumps and daily config archives
Vercel: ggd2l.vercel.app, ggd2l-europe.vercel.app redirect to the new origins
```

### Website traffic

Page traffic comes from Cloudflare's zone analytics for `ggd2l.com`
(dashboard → the zone → Analytics), which counts requests at the edge with no
script on the page. The site adds no analytics code of its own on the box.
`@vercel/analytics/next` and the /admin **Website traffic** link render only
on Vercel production (`siteAnalyticsEnabled`, `src/lib/site-analytics.ts`),
so they go quiet at the cutover; Vercel keeps the history it already
recorded, and the old origins' redirects send no page views. Ad blockers don't
affect the edge counts, but polls and asset requests are requests, not page
views.

### Hosting and release setup

Local dev stays on SQLite; production runs on Postgres via a build-time
provider swap (`scripts/switch-db-provider.mjs`, run by
`scripts/vercel-build.mjs`, whose name is kept) — you don't change any code.
The draft uses HTTP polling (no websockets). Unattended league work uses an
authenticated one-minute scheduler: each league's Cloudflare Worker in
`ops/cloudflare-automation-worker` owns the only `* * * * *` trigger and calls
`GET /api/cron/automation` once per minute. Exactly one scheduler must be
authoritative: no systemd timer, in-process cron, Vercel cron or monitor may
call that route, and a five-minute uptime monitor is not a substitute.

The supported runtime is **Node.js 22.x**. Run `nvm use` locally (the repository
includes `.nvmrc`). The box runs Node 22 from NodeSource; never build a
release with another Node major. `package.json` declares the same runtime line
used by every CI job.

1. **Provision the box.** `ops/selfhost/provision-base.sh` prepares a fresh
   Ubuntu 24.04 droplet (security updates with the 09:00 UTC reboot, swap,
   journald capped, ufw allowing SSH only, the `ggd2l` admin user, Node 22,
   PostgreSQL 18, Caddy and age), and `ops/selfhost/harden-ssh.sh` then
   closes root login. Then
   `install-kit.sh <sha>`, run from a verified clone at a commit on `main`,
   installs the kit: the users, directories, Postgres configuration, both
   leagues' roles and databases, the systemd units (disabled), Caddy with
   every site in maintenance, cloudflared and the agent. Kit changes reach the
   box only this way, as a separate recorded operation, never with an app
   release. `ops/selfhost/README.md` (Rebuild from zero) has the steps.

   Each league has two database roles. The **owner**
   (`ggd2l_<lg>_owner`) owns every relation and function and is used only to
   restore and migrate. The **app** role (`ggd2l_<lg>_app`) can only read and
   write rows; it is what the site runs as. Both connect over TCP to
   127.0.0.1 with scram, and `DATABASE_URL` and `DIRECT_URL` are the same URL:

   ```text
   postgresql://ggd2l_us_app:<hex>@127.0.0.1:5432/ggd2l_us?schema=public&sslmode=disable&connection_limit=8&pool_timeout=10&connect_timeout=5
   ```

   A migration release needs a DDL-capable username in both URL variables: it
   must own every existing application relation and function (or immediately
   inherit each owning role's privileges) and have `CREATE` on the application
   schema. Ordinary table DML grants are not enough for `ALTER TABLE`. On the
   box that is the owner role, which the agent gives only to the migration
   process (`/etc/ggd2l/<lg>-migrate.env`, loaded after the league's own env
   file so it replaces only the database URLs). The guarded migration preflight
   checks schema `CREATE` plus immediately usable ownership of existing
   application relations and functions before it inspects migration data. Any
   named ownership gap is a release stop.

2. **Keep secrets out of the repository.** The box clones the public GitHub
   repository over HTTPS with no credential. Connection strings, API keys and
   session secrets live only in root-only files under `/etc/ggd2l/` (0700) or a
   password manager — never in a command, commit, issue, screenshot, or chat.
   Move them file to file (a 0600 file, `scp -p`, `shred -u` the copy). `.env`
   is gitignored as a convenience, not a substitute for checking what you
   commit.
3. **Connect the tunnel.** `cloudflared tunnel login` on the box prints a URL
   that Tim opens to authorize `ggd2l.com`; `cloudflared tunnel create ggd2l`
   writes the tunnel's credentials into `/etc/cloudflared/`, and
   `cloudflared tunnel route dns` creates the proxied CNAMEs for
   `us.ggd2l.com`, `eu.ggd2l.com`, `ggd2l.com` and `www.ggd2l.com`. The zone's
   settings and the header contract are in
   [Edge, tunnel, cache, and abuse-control gate](docs/PRODUCTION-OPERATIONS.md#edge-tunnel-cache-and-abuse-control-gate).
4. **Write each league's environment** into `/etc/ggd2l/us.env` and
   `/etc/ggd2l/eu.env` (0600). The same file feeds the league's builds and
   its slots; systemd reads it, so no value ever appears in argv:

   | Var                                           | Value                                                                |
   | --------------------------------------------- | -------------------------------------------------------------------- |
   | `DATABASE_URL` = `DIRECT_URL`                 | the league's **app** role URL (above), identical in both             |
   | `AUTH_SECRET`                                 | unique random secret of at least 32 characters, generated on the box |
   | `BACKUP_RECEIPT_SECRET`                       | separate random secret of at least 32 characters for backup receipts |
   | `CRON_SECRET`                                 | third, distinct 32–512 character random secret with no whitespace    |
   | `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`          | base64 of 32 random bytes, generated once per league and kept        |
   | `STEAM_API_KEY`                               | your **rotated** Steam Web API key                                   |
   | `APP_URL`                                     | `https://us.ggd2l.com` or `https://eu.ggd2l.com`                     |
   | `NEXT_PUBLIC_SITE_URL`                        | the same canonical HTTPS origin as `APP_URL`                         |
   | `NEXT_PUBLIC_LEAGUE_REGION`                   | `us` or `eu`: the file's own league                                  |
   | `LEAGUE_DEPLOY_ENV`                           | `production` (`staging` for the rehearsal and the staging slot)      |
   | `CLIENT_IP_HEADER`                            | `cf-connecting-ip`                                                   |
   | `ADMIN_STEAM_IDS`                             | one or more valid, unique SteamID64s, comma-separated                |
   | `OPENDOTA_API_KEY`                            | optional                                                             |
   | `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | optional — enables "Link Discord" account verification               |
   | `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID`      | optional — Discord join, inhouse role, inhouse night events; bot needs Manage Roles + Create Invite + Create Events |

   The unit sets `NODE_ENV=production` and `PORT`, and the release sets
   `LEAGUE_RELEASE_SHA`; never put them, `HOSTNAME` or any `VERCEL_*` key in
   the file. The env contract (run by `box_agent envcheck <lg>` and before
   every build and every slot start) refuses the file, naming only the
   offending keys, when `LEAGUE_DEPLOY_ENV` is missing or not exactly
   `production` or `staging`, `NEXT_PUBLIC_LEAGUE_REGION` isn't the file's
   league, `APP_URL` isn't exactly the league's canonical origin
   (`https://<lg>.ggd2l.com`, in production and staging alike) or differs
   from `NEXT_PUBLIC_SITE_URL`, the two database URLs
   differ or point anywhere but the app role on 127.0.0.1, the action key
   isn't 32 bytes, a Vercel or Neon key is present, or a staging file carries
   a Discord or lobby-bot credential.

   The rest of the production rules (the three secrets' length and shape,
   `ADMIN_STEAM_IDS`, `STEAM_API_KEY`, the Discord pairs) are
   `scripts/validate-prod-env.mjs`, which every build runs and `envcheck`
   runs too, from the live release, but a slot's start does not. An edit of
   the file takes effect at the next restart, reboot or rollback with no
   build, so run `box_agent envcheck <lg>` after every edit and restart
   nothing until it answers ok
   ([Secret compromise](docs/PRODUCTION-OPERATIONS.md#secret-compromise)).

   Leave `ALLOW_DEV_LOGIN` unset or set it exactly to `false`. Production does
   not support a first-user admin bootstrap: `ADMIN_STEAM_IDS` must already
   contain at least one trusted administrator before the first release.
   `CRON_SECRET` must be 32–512 characters, contain no whitespace, and be
   distinct from both other secrets. Store the identical value as the league's
   Cloudflare Worker's encrypted `AUTOMATION_SECRET`; the Worker sends it as
   `Authorization: Bearer <CRON_SECRET>`. The non-secret `AUTOMATION_URL` is
   reviewed and pinned in the Worker's `wrangler*.jsonc`; do not override it
   at deploy time. Never put the secret value in a URL, query string, source
   file, command argument, commit, issue, screenshot, log, or chat.

   > **`ADMIN_STEAM_IDS` is authoritative.** Exactly those accounts are admins;
   > authorization is recomputed on every authenticated request, so removing an
   > account revokes its existing admin session on the next request. Stored
   > roles are also reconciled on login. Use canonical individual SteamID64s,
   > not Steam3 IDs, friend codes, vanity names, or profile URLs. Correct the
   > allowlist if access is wrong; do not remove it and expect a production
   > bootstrap.

   > **Discord webhooks are bearer credentials, not arbitrary URLs.** Every
   > configured league/inhouse webhook must be an exact HTTPS
   > `discord.com`/`discordapp.com` webhook path with no port, query, fragment,
   > embedded credentials, whitespace, or redirector host. The production gate
   > rejects anything else, and the Admin save controls apply the same parser.
   > Rotate a URL immediately if it ever appears in logs, screenshots, or chat.

   > A staging environment (the cutover rehearsal, or the on-demand staging
   > slot) runs a scrubbed copy of a league's database with
   > `LEAGUE_DEPLOY_ENV=staging`, which closes every Discord write; the env
   > contract also refuses a staging file that carries the bot token, the
   > OAuth secret, a webhook or the lobby bot's URL or secret. Never point a
   > staging slot or a development build at a production database.

5. **Classify and release only the reviewed commit.** For release
   authorization, run the classifier blob from the commit the league runs live
   against the candidate commit (`npm run release:both` does this). Never
   trust the candidate's copy to classify itself. The live SHA must be
   fetchable and an ancestor of the candidate. With both verified full SHAs in
   private shell variables, run:

   ```bash
   release_classifier_dir="$(mktemp -d)"
   release_classifier_path="$release_classifier_dir/classify-release.mjs"
   trap 'rm -f -- "$release_classifier_path"; rmdir -- "$release_classifier_dir"' EXIT
   if git show \
       "$production_release_sha:scripts/classify-release.mjs" \
       > "$release_classifier_path" 2>/dev/null \
     && node "$release_classifier_path" \
       --base "$production_release_sha" \
       --head "$candidate_release_sha" \
       --format json; then
     :
   else
     printf '%s\n' '{"lane":"strict","needs_postgres":true,"needs_mutation":true,"needs_e2e":true,"needs_db_release":true,"needs_scheduler_pause":true,"reasons":["trusted production classifier unavailable"]}'
   fi
   rm -f -- "$release_classifier_path"
   rmdir -- "$release_classifier_dir"
   trap - EXIT
   ```

   The temporary trusted script parses the exact NUL-delimited Git change
   inventory. If the production commit predates the classifier or extraction
   or the trusted classifier fails, the printed fallback is deliberately strict
   and selects every impact procedure; do not substitute the candidate script
   to recover a fast lane.

   - `ui-only` is a narrow allowlist of presentation-only paths. It may skip
     only the PostgreSQL and mutation jobs; lint, types, ordinary tests/build
     checks, and the focused browser verification still run.
   - `app` is schema-neutral application code. It uses the standard application
     CI and candidate/promotion checks.
   - `strict` covers schema, migrations, server actions, cron/scheduler or build
     plumbing, unexpected statuses, and every unknown path. It receives full CI
     and manual review. Separate `needs_db_release` and
     `needs_scheduler_pause` flags decide whether the recovery or scheduler
     procedures are also required.

   The mutation ratchet has its own flag. `needs_mutation` is false only when
   every changed file is a page or component (outside server actions, API and
   route handlers), a presentation asset, documentation, or a browser/unit
   test the PostgreSQL suite never loads; CI then skips the four mutation
   shards, and `release:both` accepts that skip only when the trusted
   production classification also says false (a classifier without the field
   counts as true), or when an earlier run already covers the candidate (see
   below). CI's test job still checks the claim inventory with
   `node scripts/mutation-guard.mjs --static`, `mutation-nightly.yml`
   re-verifies every protected claim on `main` at 07:00 UTC, and each shard
   runs a claim's recorded killer test file before falling back to the whole
   suite.

   A plain deletion of a regular file is judged like an edit to that path, so
   removing a stale doc or dead component needs no maintenance procedure.
   Deleting anything under `prisma/`, `ops/`, the cron or automation-health
   routes, or the scheduler libraries still selects both flags; renames,
   copies, and file-type or mode changes select both everywhere. Everything
   under `ops/` counts as scheduler plumbing except the independently hosted
   or installed parts: the lobby bot and relay (`ops/dota-lobby-bot/`,
   `ops/dota-lobby-relay/`), the box kit (`ops/selfhost/`) and the redirect
   deployments (`ops/vercel-redirect/`), the `ops/` entries in `.vercelignore`
   that a test ties to the classifier's list. They stay strict for review
   without a scheduler pause. A new `ops/` folder selects scheduler controls
   until it is deliberately added to that exemption list.

   The root tooling (`.claude/launch.json`, `.nvmrc`, `eslint.config.mjs`, the
   Playwright and Vitest configs), the removed Next proxy `src/proxy.ts` (its
   deletion, or a new one) and the artwork exports in `brand/` are strict
   without either impact flag. The
   helpers, seeds and global setups of all three browser suites (`e2e/`,
   `e2e-mid/`, `e2e-postseason/`) are neutral test paths. Any other path the
   classifier does not name, such as a new top-level file or folder, is
   unknown and selects both flags, so name it in the classifier when you add
   it: `src/lib/release-classification.test.ts` fails while any tracked path
   is unknown. Releases are classified by the live commit's copy, so a newly
   named path stops selecting the flags only once that classifier change is
   itself live.

   A UI-only or app release does **not** require a fresh database backup or a
   scheduler pause. Its migration gate contains no writer, and the classifier
   reports neither impact flag. Do not force an unknown change into a faster
   lane.

   GitHub CI likewise extracts the classifier from its trusted event base only
   to decide whether its PostgreSQL and mutation jobs can be reused or skipped.
   That optimization is not production release authorization. If the
   live-production delta is strict, every strict gate must have passed for
   the candidate even when the event-based CI comparison was narrower. A live
   release that can't be identified, or an unfetchable/non-ancestor live SHA,
   blocks the fast release path.

   The mutation shards follow the same rule whenever that delta has
   `needs_mutation: true`. CI can still have skipped them: when production lags
   `main` by an unreleased commit that reaches the ratchet, a later page-only
   push skips the shards on its own delta. `release:both` then accepts the four
   passing shards of the newest CI run (a push or a forced run) or nightly
   verify on an earlier `main` commit, as long as every changed region's
   trusted classifier calls the delta from that commit to the candidate
   mutation-neutral; the report records the run it used. If no earlier run
   covers it, the release stops and says so. To recover, run the **CI**
   workflow on `main` in GitHub Actions with `force_strict` ticked, wait for it
   to finish green, and release again: `release:both` uses the newest passing
   CI run for the commit, which is the forced one.

   CI cancels an older run on `main` when a newer push lands, so a hotfix
   pushed while the previous commit's shards are still running usually finds
   nothing to reuse until the next nightly verify has passed.

   In production, the database-attestation portion of the build
   (`scripts/vercel-build.mjs` with `NODE_ENV=production`, which the agent
   runs on the box) is a read-only, fail-fast sequence:

   1. validate production environment values;
   2. switch Prisma to PostgreSQL and validate the checksum-pinned committed
      migration set;
   3. generate the Prisma client;
   4. run `scripts/production-schema-check.mjs` to attest the target's exact
      migration ledger, Prisma schema, and required PostgreSQL-native objects
      read-only; then
   5. complete `next build` (on the box with Next's own type check skipped,
      `GGD2L_SKIP_BUILD_TYPECHECK=1`, since CI type-checked the exact commit).

   Production compilation stops on a missing, pending, failed, extra, or changed
   migration or schema/native-object drift. Development and local builds
   attest nothing, and no build deploys migrations. The subsequent Next.js
   build still receives the configured runtime environment, so application
   build code must remain side-effect-free; the read-only claim applies to the
   release gate, not arbitrary application code.

   A schema or migration release is a separate, explicit operation. When the
   classifier reports `needs_db_release`, complete strict CI plus the fresh
   backup, drill and applicable scheduler pause/propagation/lease-drain
   prerequisites in `docs/PRODUCTION-OPERATIONS.md`. On the box the agent then
   runs the guarded wrapper from a clean tools clone whose `HEAD` is the
   reviewed commit (`box_agent migrate <lg> <sha>`); it is the script behind:

   ```text
   npm run db:migrate:release -- --apply <reviewed 40-character HEAD SHA>
   ```

   The full lowercase commit SHA is required; an abbreviated SHA is not
   accepted. The wrapper requires `VERCEL_ENV=production` (the agent sets it
   in that one process, and nothing else on the box ever sees it), binds
   approval to that clean checkout, refuses root or `prisma/` `.env` files that
   Prisma could auto-load after validation, and runs production environment
   validation, committed-migration safety, the read-only data preflight,
   `prisma migrate deploy` through the direct connection, and exact postflight
   attestation. Stop on any non-zero step. Never call its internal migration
   command directly to bypass the reviewed-SHA or clean-checkout guards.
   These are technical guards only: the wrapper cannot prove that CI passed or
   that backup, drill, scheduler, and approval evidence exists. The release
   owner must verify and record those operator prerequisites before invoking
   it.

   The role in both URL variables must own every existing application
   relation and function, or immediately inherit each owning role's
   privileges, and have `CREATE` on the application schema. A successful
   scratch restore does not establish this: PostgreSQL dumps made by this
   repository omit owners and grants, so the scratch restore role becomes the
   owner and can mask a production ownership failure. On the box every restore
   runs as the league's owner role, and `box_agent preflight <lg> <sha>` checks
   ownership as that role read-only before a migration.

   If a migration release fails, preserve the first server error and stop; do
   not blindly rerun it. The guarded resolver accepts only one exact unresolved
   target row with the reviewed checksum, zero applied steps, no finished copy,
   a valid prior ledger, and none of that migration's expected catalog objects.
   It also checks that the current role owns or immediately inherits ownership
   of the affected table and can create schema objects, so resolving cannot
   simply lead to the same DDL failure. Only when those checks prove that the
   atomic attempt rolled back completely may the release owner run it, with
   `VERCEL_ENV=production`, the owner role's direct URL, and the same clean
   reviewed checkout ([how, on the box](docs/PRODUCTION-OPERATIONS.md#fully-rolled-back-failed-migration)):

   ```text
   npm run db:migrate:failed-resolve -- --apply <reviewed 40-character HEAD SHA> <migration-name>
   ```

   `<migration-name>` must be the exact reviewed target printed by the command's
   usage message; arbitrary migrations are refused. The command also requires
   the repository-pinned Prisma version and refuses Prisma dotenv files.

   This guarded command records the proven failed attempt as rolled back; it
   does not mark the migration applied and does not apply any migration SQL.
   After it succeeds, take and verify a fresh dump, repeat the drill and the
   owner-role preflight, and run the complete `db:migrate:release` wrapper
   again. If any statement committed, the catalog or data is ambiguous,
   another unresolved row exists, or the guard refuses the ledger state, stop
   for a reviewed forward-recovery plan. Never use `migrate resolve --applied`,
   edit `_prisma_migrations` manually, invoke Prisma's resolver directly, or
   turn a failed ledger row into a blind retry.

   Every production migration remains additive and compatible with the
   currently deployed app because the old release continues serving while the
   explicit migration step runs. Breaking changes require an
   expand/deploy/backfill/contract sequence, with the contract migration
   released only after the old binary can no longer run.

   CI validates and rehearses the explicit release chain against disposable
   PostgreSQL, including empty and populated legacy upgrades, a real `pg_dump`,
   a restore and full attestation, and PostgreSQL integration tests. The
   destructive rehearsal targets remain hard-coded to local databases named
   `ld2l_pgtest` and `ld2l_restore_test`; the scripts refuse remote or similarly
   named targets. Production databases never take those names.

   Environment validation rejects missing/non-PostgreSQL database URLs,
   different database, schema, or PostgreSQL usernames, mismatched
   managed-provider projects, recognizable direct URLs used as the runtime
   pool, recognizable pooler URLs used for migrations, placeholder or short
   auth/backup-receipt secrets, a
   missing/placeholder Steam API key, an unusable cron secret, incomplete
   Discord OAuth or bot/guild pairs, a production `DISCORD_API_BASE` test seam,
   missing/invalid/duplicate admin SteamIDs, non-HTTPS or divergent site
   origins, enabled dev login, and configured test-only or obsolete release
   overrides. On the box both URLs are the same local URL. A separate
   least-privilege runtime role is supported only by keeping both normal
   runtime URLs on that role and replacing both variables with the
   DDL-capable role's URLs inside the trusted migration process, which is
   what the agent does. Unknown providers must use the same normalized
   hostname and effective port; support for a custom pool/direct gateway pair
   requires an explicit reviewed normalization rule.

   `BUILD_DB_DRY_RUN` is retired and must be unset. `PRISMA_ACCEPT_DATA_LOSS` is
   obsolete, and `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` would permit unsafe
   concurrent migration commands; the env contract refuses all three. There is
   no production data-loss override and no automatic rollback; Prisma's
   migration advisory lock remains mandatory.

   **One-time baseline for a database created by the old `db push` process:**

   1. create a full backup, verify it, and complete the guarded legacy restore
      rehearsal with `npm run db:backup:rehearse -- --legacy-baseline
      backups/<backup-file>.sql`;
   2. run `npm run db:migrate:baseline-check` with trusted production
      `DIRECT_URL`/`DATABASE_URL` environment variables;
   3. with production `DIRECT_URL` set (the resolver intentionally has no
      pooled-URL fallback), run
      `npm run db:migrate:baseline-resolve -- --apply` only if that read-only
      fingerprint passes;
   4. from the clean ephemeral checkout at the reviewed full `HEAD` SHA, run
      `npm run db:migrate:release -- --apply <reviewed 40-character HEAD SHA>`
      so `20260804010000_release_readiness`,
      `20260804020000_automation_run_state`, and any later committed migrations
      are applied and attested before building the candidate.

   Stop and reconcile the database if the baseline check reports any
   difference. Never mark the baseline applied merely to get past a failed
   deploy. A brand-new empty database does **not** need baseline adoption; the
   guarded `db:migrate:release` command applies the baseline and later
   migrations through its pinned `prisma migrate deploy` step.
   The guarded resolver repeats the exact read-only check immediately before
   writing migration metadata, keeps credentials out of process arguments, and
   never changes the committed SQLite schema or generated client. Omitting
   `--apply` fails before any database mutation.

6. **Prove health before promotion.** The release starts each candidate in the
   league's idle slot and runs the shared smoke (`ops/selfhost/smoke/smoke.mjs`,
   the same script CI runs on its own build) against it on 127.0.0.1:

   ```bash
   node ops/selfhost/smoke/smoke.mjs --base http://127.0.0.1:<port> \
     --host us.ggd2l.com --origin https://us.ggd2l.com --region us \
     --commit <sha> --expect production --public-dir public
   ```

   It sends the league's `Host` and `X-Forwarded-Proto: https`, and requires:
   `live` and `ready` at 200; `/api/health/release` reporting the commit, the
   region, the origin as `site` and the expected `deployEnv`; `/` and
   `/schedule` loading with their share pictures and a static asset; the
   same-origin guard passing the canonical origin and refusing another; logout
   and the sign-in redirects landing on the canonical origin; image resizing
   working; and the overlay route loading. It **never** requests `/api/sync`
   or `/api/health/automation`: those would cache automation state in the
   candidate.

   `live` returns HTTP 200 without touching the database; `ready` returns 200
   only when PostgreSQL answers. On the live site, `automation` is 200 only
   when the state holds a fresh clean success, and fails closed with 503
   before the first success. An unauthenticated cron request must be 401,
   POST `/api/sync` must be 405, and GET `/api/sync` must return only the
   read-only `updated`, `watch`, and `cursor` snapshot:

   ```bash
   export LEAGUE_SITE_ORIGIN="https://us.ggd2l.com"
   curl -fsS "$LEAGUE_SITE_ORIGIN/api/health/live"
   curl -fsS "$LEAGUE_SITE_ORIGIN/api/health/ready"
   curl -sS "$LEAGUE_SITE_ORIGIN/api/health/automation"
   test "$(curl -sS -o /dev/null -w '%{http_code}' \
     "$LEAGUE_SITE_ORIGIN/api/cron/automation")" = "401"
   test "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
     "$LEAGUE_SITE_ORIGIN/api/sync")" = "405"
   curl -fsS "$LEAGUE_SITE_ORIGIN/api/sync"
   unset LEAGUE_SITE_ORIGIN
   ```

   Exercise an Admin manual run on a fixture server or the cutover rehearsal
   (the on-demand staging slot once it is built), never on a candidate. The
   promoted release is exactly the candidate the smoke checked; nothing is
   rebuilt. The production Cloudflare Worker always targets the canonical
   origin, never a candidate or the staging slot.

7. **Deploy the private Cloudflare scheduler after the league is live.**
   `ops/cloudflare-automation-worker/wrangler.jsonc` (Europe:
   `wrangler.europe.jsonc`) disables `workers.dev`, pins the reviewed
   `AUTOMATION_URL` (`https://us.ggd2l.com/api/cron/automation`, or Europe's),
   requires the encrypted `AUTOMATION_SECRET` binding, and declares the
   league's only `* * * * *` trigger. The sibling `wrangler.paused.jsonc` is
   the reviewed stop control and differs only by setting `crons` to an empty
   array. On a brand-new Cloudflare account the Worker does not exist yet, so
   `wrangler secret put` cannot be the first command. Bootstrap the Worker with
   the paused config and a private, short-lived secrets file; only then deploy
   the active config. Use the pinned Wrangler version:

   ```bash
   npx wrangler@4.118.0 login
   umask 077
   task_secrets_file="$(mktemp)"
   trap 'rm -f -- "$task_secrets_file"' EXIT
   printf 'AUTOMATION_SECRET: ' >&2
   IFS= read -r -s task_scheduler_secret
   printf '\n' >&2
   printf 'AUTOMATION_SECRET=%s\n' "$task_scheduler_secret" > "$task_secrets_file"
   unset task_scheduler_secret
   npx wrangler@4.118.0 deploy \
     --config ops/cloudflare-automation-worker/wrangler.paused.jsonc \
     --secrets-file "$task_secrets_file"
   rm -f -- "$task_secrets_file"
   trap - EXIT
   npx wrangler@4.118.0 secret list --cwd ops/cloudflare-automation-worker
   npm run scheduler:deploy
   npx wrangler@4.118.0 deployments status --cwd ops/cloudflare-automation-worker
   ```

   Supply `AUTOMATION_SECRET` without putting it in shell history, standard
   output, or a command argument; on an existing Worker, pipe it from a 0600
   file into `wrangler secret put` instead. The temporary file must be mode
   0600, must stay outside the repository, and must be removed immediately
   after the paused bootstrap. It is byte-for-byte the same value as the
   league's `CRON_SECRET`. `secret list` must show the binding name, never its
   value. Never copy the production value into `.dev.vars`; that file is for
   non-production local testing only. The committed `AUTOMATION_URL` must
   remain the exact reviewed HTTPS endpoint, with no credentials, port, query,
   or fragment.

   The current Cloudflare Workers Free limits are 100,000 requests/day, five
   Cron Triggers/account, 50 external subrequests/invocation, 10 ms CPU per Cron
   Trigger, and 15 minutes wall time. Each league's Worker uses about 1,440
   invocations a day, one trigger, one HTTPS subrequest per invocation, a
   65-second timeout, and only a bounded 2 KiB response parse. Confirm the
   account has unused capacity and re-check Cloudflare's current
   [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
   before launch; limits are shared and can change.

   Cron Trigger changes may take up to 15 minutes to propagate. Confirm the
   Cloudflare dashboard shows exactly one `* * * * *` trigger per league and
   nothing on the box calls the route, then observe **two consecutive
   one-minute invocations complete with HTTP 200 and `status: "SUCCEEDED"`**
   (the Caddy log through `box_agent logs <lg> <epoch ms>` shows them).
   Require `/api/health/automation` to return HTTP 200. In Admin → Automation,
   verify Last attempt and Last success advance, Source says **Scheduled
   cron**, the lease clears after each pass, and the failure streak remains
   zero. Exercise **Run maintenance now** once while idle and verify it records
   an Admin manual run; if the Worker owns the lease, the control must refuse
   to overlap it. The scheduler Worker posts to the admin Discord channel when
   3 passes in a row fail, and the box's heartbeat when the probe stays stale
   while the site answers. The complete pinned-commit promotion, evidence, pause,
   rollback, recovery, and secret-rotation procedure is in
   [`docs/PRODUCTION-OPERATIONS.md`](docs/PRODUCTION-OPERATIONS.md).

8. **Sign in with an allowlisted Steam account.** Then go to **/admin**, create
   the season, and set the MMR cap. Steam pulls names and avatars automatically.

The origins are `https://us.ggd2l.com` and `https://eu.ggd2l.com`. Changing
one is a deliberate change in several places at once: `APP_URL` and
`NEXT_PUBLIC_SITE_URL` (identical, then a release, since public values are
baked into the build), the database's `deploymentOrigin` marker (the build
refuses a mismatch), the exact Discord OAuth callback, the Steam domain, the
Worker's committed `AUTOMATION_URL` (a code-reviewed scheduler change), the
tunnel's ingress and Caddy's site, and the env contract. Calendar UIDs stay on
`LEAGUE_CONFIG.calendarUidHost`, never the site's host. Repeat Steam and
Discord login smoke tests before moving traffic.

### Application rollback order

Database migrations are forward-only and additive. Rolling the application
back means promoting a previously tested release (`box_agent rollback <lg>`
promotes the previous one and restarts it clean, once: a second one refuses
until the next promote, see [RELEASING](docs/RELEASING.md#rolling-back-a-release-that-finished)),
not running SQL down migrations. A schema-neutral rollback between releases with the same
authenticated automation contract does not require a backup or scheduler pause;
roll back, verify the probes and one database-backed read, and keep watching
the next two scheduled passes. If the rollback crosses a schema or scheduler
boundary, predates the authenticated cron route, or has uncertain
compatibility, use this strict sequence:

1. Run `npm run scheduler:pause` (Europe: `npm run scheduler:europe:pause`).
   It deploys the reviewed paused configuration with `crons: []`; verify
   Cloudflare shows zero Cron Triggers. Do not edit a Wrangler-managed trigger
   only in the dashboard.
2. Wait the full 15-minute propagation bound, then confirm no automation
   request lands across two further expected minute slots
   (`box_agent cron-requests <lg> <epoch ms>` answers 0, and Admin →
   Automation records no new Scheduled cron attempts). Wait at least 90
   seconds after the last possible attempt and confirm no active lease remains
   (`box_agent lease <lg>`). Do not bypass or delete a live lease row. Only
   then promote code that may not expose the authenticated worker route.
3. Promote the previous application release. Leave all committed migrations
   and newly added tables in place; the release migrations are designed so the
   old binary can keep serving against the expanded schema.
4. Verify Steam sign-in, the current schedule, and another known database-backed
   read. Verify `/api/health/live` and `/api/health/ready` only if the rollback
   build exposes them. Do **not** use `/api/sync` as a rollback health check: a
   build predating this release may still mutate state on GET. Keep the
   scheduler paused if that build predates `/api/cron/automation`, and point
   probes at endpoints that actually exist in that release.
5. After the repaired forward release is live, run `npm run scheduler:deploy`
   (Europe: `npm run scheduler:europe:deploy`). Confirm nothing else calls the
   route, allow for Cloudflare propagation, and repeat the
   two-consecutive-success check above.

If an incident is caused by data rather than code, stop here and restore only
through the rehearsed database recovery procedure below; do not improvise a
destructive schema rollback.

### Backups

The league's entire history lives in its one database. On the box each league
is dumped every hour at :17 (`ggd2l-backup@us.timer`, `ggd2l-backup@eu.timer`)
with the commands below, run as the app role so backup receipts match the
database; each dump is verified, gzipped, encrypted with `age` to Tim's
offline public key and copied to the `ggd2l-backups` R2 bucket. Local dumps
are kept 48 hours; R2 keeps hourly copies 7 days, daily copies 35 days and
monthly copies 400 days. The box can't decrypt its own offsite copies. A fresh
dump precedes every migration (`box_agent backup <lg>`). To run the commands
yourself, supply `DIRECT_URL` through a trusted environment file or a private
shell environment, never as a literal command-line argument; then run:

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
uses Node's built-in `node:sqlite` (Node 22.16 or newer), needs no `sqlite3`
program, and fails safely if the running Node lacks it.

> **`pg_dump` must be at least as new as the server**, or it aborts with
> `aborting because of server version mismatch` and writes nothing. The box's
> client and server are both PostgreSQL 18 from the same PGDG packages, and
> upgrades keep the major pinned. On a Mac, use a PostgreSQL 18 client for a
> production dump (Homebrew's `postgresql@18`: prepend
> `/opt/homebrew/opt/postgresql@18/bin` to `PATH`); check with
> `pg_dump --version` before you need a recovery, not during an incident.

`db:backup:verify` proves that the bytes still match the sidecar; it does **not**
prove that a SQL dump can be restored or that the restored league is coherent.
When `BACKUP_RECEIPT_SECRET` is configured, verifying a new metadata-bearing
backup also prints a signed `ld2l-backup-v1.…` receipt. A production permanent
season deletion requires that receipt: it must identify the current logical
PostgreSQL database, represent a complete database dump, and both the backup
and verification must be less than 24 hours old. Paste it only into the
hard-delete dialog. Treat the receipt as a short-lived destructive capability:
mint it only by hand, in a private terminal, when a season delete needs one,
and never copy it into CI logs, issues, or chat. The box's hourly backups
verify without the receipt secret, so no receipt reaches its journal. CI uses
a disposable database and a synthetic signing secret. A SQLite receipt never
authorizes a production delete.

The downloadable season JSON is explicitly an **audit/reference archive**. It
has no importer, cannot restore foreign-key graphs, is not a full database
backup, and does not satisfy the deletion gate.

Receipt verification still does **not** prove restorability. The restore
rehearsal does: it verifies the dump again, drops and recreates **only** the
exact local database `ld2l_restore_test`, restores in one transaction, checks
completed migrations plus core league tables, runs migration preflight,
applies current migrations from an isolated workspace, and requires full
postflight attestation. On the box it runs every week
(`ggd2l-drill@<lg>.timer`, as the scratch-only `ggd2l_rehearsal` role) and
before every migration (`box_agent drill <lg> <sha>`). On a Mac:

```bash
export PG_RESTORE_TEST_URL="postgresql://${USER}@localhost:5432/ld2l_restore_test"
npm run db:backup:rehearse -- backups/<backup-file>.sql
unset PG_RESTORE_TEST_URL
```

It requires compatible `psql`, `dropdb`, and `createdb` clients and a local role
that may recreate that scratch database. Remote hosts and similarly named
databases are rejected before a client runs.

The dump deliberately uses `--no-owner --no-privileges`. That makes it
portable, but it also makes every restored object belong to the restore role
and discards the production role memberships and grants. A passing restore
therefore proves the backup, data, and migration SQL—not that the production
migration username can run DDL. On the box, a restore into a league's own
database runs as that league's owner role, and `box_agent preflight` checks
the owner's ownership and `CREATE` read-only before a migration; treat a
scratch-only pass as insufficient ownership evidence.

An old production database created by `prisma db push` has no
`_prisma_migrations` table, so use the explicit legacy mode for that backup:

```bash
export PG_RESTORE_TEST_URL="postgresql://${USER}@localhost:5432/ld2l_restore_test"
npm run db:backup:rehearse -- --legacy-baseline backups/<backup-file>.sql
unset PG_RESTORE_TEST_URL
```

That mode never infers intent from a missing table. It requires the flag,
discovers exactly one table-bearing application schema, requires the immutable
baseline and no migration history, records the baseline only inside the exact
localhost scratch database, applies the checksum-pinned current migrations,
and runs full postflight. An ambiguous, partial, already-migrated, remote, or
similarly named target fails closed. Complete this rehearsal before recording
the baseline on the actual hosted database.

Every quarter, Tim also decrypts one daily offsite copy on his Mac with his
offline key, checks its SHA-256 and runs the same rehearsal against the Mac's
scratch Postgres: the drill proves the box's dumps restore, and this proves
the offsite copies do. The drill is successful only after the restore exits
cleanly and expected seasons, users, teams, matches, and games have plausible
counts. Record the date and result, then destroy the scratch database. For
SQLite, copy the `.db` to a disposable path and open/test that copy; never
overwrite the live file during a drill.

### Health monitoring and scheduler (required)

Monitor `GET /api/health/live` for process reachability,
`GET /api/health/ready` for application/database readiness, and
`GET /api/health/automation` as the public dead-man signal. Keep those alerts
separate: `live` deliberately does no dependency work, `ready` returns 503 when
PostgreSQL is unavailable, and `automation` returns 503 for never-run, stale,
failed, degraded, expired-lease, or database-unavailable state. It also reads
stale from each wake of a sleeping worker (at least hourly) until the next
scheduled pass finishes, up to a minute plus the pass, so alert only on an
automation 503 that lasts longer than three minutes. The automation
body exposes only a bounded status enum; detailed failure/backlog state remains
in Admin. Also alert on non-2xx `/api/cron/automation` responses.

On the box these alerts go to the admin Discord channel
([Box operations](docs/PRODUCTION-OPERATIONS.md#box-operations)). The
dead-man half runs outside the box: each league's scheduler Worker already
reaches `/api/cron/automation` **through Cloudflare** every minute (so a pass
proves the tunnel, Caddy, the app and the database together) and posts when 3
in a row fail, then when 2 in a row pass. The heartbeat posts what only the
box can see: its disk, memory, swap and failed units, an enabled lobby bot
that is down, and an automation probe that stays stale while `/api/health/ready`
answers (three beats, so a sleeping worker's wake never alerts). Each backup
run, drill and config archive posts its own failure and recovery. The
heartbeat also still pings healthchecks.io's `box` and `automation` checks,
and each backup and drill its own, wherever their URLs are configured. A readiness check costs one `SELECT 1` against a
local database that never sleeps, so its interval is a detection choice, not a
cost; `/api/health/live` does no database work, and `/api/health/automation`
reuses the cached gate while automation is sleeping. See the
[5 September 2026 database efficiency review](docs/archive/DATABASE-EFFICIENCY-2026-09-05.md)
for the Neon-era usage and cost levers.

Do **not** point a monitor at `/api/sync` to run maintenance. It is a public,
read-only cursor/watch snapshot used by visible browser tabs; it never imports
games, advances phases, sends Discord messages, or drains an outbox. The
bearer-authenticated Cloudflare Worker is the only unattended worker trigger.
An administrator can explicitly request the same bounded worker from Admin →
Automation, under the same lease. The Worker treats every response other than
HTTP 200 with `{ ok: true, status: "SUCCEEDED" }` as a failed Cron Event; the next
minute's invocation plus the persisted leases/outboxes provide recovery, while
monitoring must still surface the failed pass. Review Cloudflare's
[Cron Trigger operations](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
and the private Admin automation state together.

## Notes

- SQLite doesn't support Prisma enums, so status/type/role fields are strings
  validated in `src/lib/constants.ts`. This is structured for an easy move to
  Postgres + native enums later.
- The draft is server-authoritative and polled (`/api/draft/tick`), which keeps
  it robust and easy to test without a websocket layer.
