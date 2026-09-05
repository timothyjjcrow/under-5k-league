# GGD2L Europe setup

Both leagues run the same source code. Europe uses its own Vercel project,
PostgreSQL database, scheduler, Discord server and Dota lobby worker. Players
use Steam to sign in separately on each site; profiles, admins, registrations,
seasons, drafts, matches, records, inhouses and credits are separate.

The planned public origin is `https://ggd2l-europe.vercel.app`. The first season
opens for signups with **match night to be announced**, no draft date and no
first match date. Do not seed demo players or copy US production data.

## Project and configuration

1. Create/link the separate `ggd2l-europe` Vercel project from the same Git repo.
   Check `.vercel/project.json` before every environment change or deploy. The
   US project continues to use its existing link, variables and database.
2. Provision a dedicated PostgreSQL database, preferably in a European region.
   Its pooled `DATABASE_URL` and direct `DIRECT_URL` must target the same logical
   database/schema/user. Preview deployments require a separate disposable
   database; do not give them either league's production database.
3. Configure the Europe project's Production environment from
   [`.env.europe.example`](../.env.europe.example). Generate independent
   `AUTH_SECRET`, `CRON_SECRET`, `BACKUP_RECEIPT_SECRET` and lobby-bot credentials.
   Set `ADMIN_STEAM_IDS` to the trusted Europe admins. A verified Steam login
   creates the account and applies that allowlist; there is no fabricated admin
   account or first-visitor production bootstrap.
4. Keep `NEXT_PUBLIC_MATCH_DAY` and `NEXT_PUBLIC_MATCH_TIME` empty until the
   organizers announce the schedule. `Europe/Berlin` is the initial league
   timezone. Date-specific kickoff times display in the viewer's local time.
5. Set the Steam API configuration for the Europe hostname and, when enabling
   Discord, register the Europe callback URL below. Public `NEXT_PUBLIC_*`
   values are bundled at build time: rebuild after changing them.

The production validator rejects an EU build pointed at the US public origin
or default US Discord invite. An empty EU invite disables the invite links;
it never falls back to the US server. Fresh database identity markers also
prevent an EU build using an unmarked or differently identified database.
These checks do not infer ownership of arbitrary bot tokens or webhooks:
provision those in the Europe server and verify the actual channel destinations.

## Initialize the fresh database

Use the existing reviewed release process from
[PRODUCTION-OPERATIONS.md](PRODUCTION-OPERATIONS.md). Migration releases run in
a clean checkout at the reviewed commit, with no root `.env` or `prisma/.env`
file. Supply credentials through the trusted process environment and set
`VERCEL_ENV=production`; standalone scripts do not auto-load `.env.local`.

```bash
npm run db:migrate:release -- --apply <40-character-current-HEAD-sha>
npm run db:bootstrap:europe -- --apply https://ggd2l-europe.vercel.app
```

The migration command recognizes an empty schema and applies the baseline and
all subsequent migrations. **Do not run baseline-resolve, `db:push`, `db:seed`
or `db:reset` against the fresh production database.** Baseline resolution is
only for a verified legacy database that already has the baseline schema.

Bootstrap validates the production environment and migrated schema, locks all
application tables, then refuses to proceed if any application row exists.
It inserts only:

- `Setting.deploymentRegion = eu` and `Setting.deploymentOrigin = APP_URL`;
- one active `GGD2L Europe Season 1` in `SIGNUPS`, with the existing 4.5K soft
  review threshold, five-player teams and match night to be announced;
- no players, rosters, fixtures, news, credits or Discord settings.

Repeating bootstrap fails without modifying existing data. If a command's
completion was uncertain, inspect the database before taking further action.
The production build attests the region/origin markers after its normal schema
checks. Migrations themselves do not require the markers, so migration precedes
bootstrap. When changing the Europe domain later, update the database's
`deploymentOrigin` deliberately along with app URLs, callback URLs and scheduler
target before rebuilding; the mismatch guard otherwise blocks the build.

## Discord

Create the Europe server and configure its own:

- OAuth application and bot, with redirect
  `https://ggd2l-europe.vercel.app/api/auth/discord/callback`;
- league announcements webhook, inhouse queue board webhook, optional separate
  inhouse alerts webhook, and opt-in inhouse role;
- invite URL in `NEXT_PUBLIC_DISCORD_INVITE_URL`.

`DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` and `DISCORD_BOT_TOKEN` /
`DISCORD_GUILD_ID` are paired settings. The OAuth app and bot should refer to the
same Discord application. Leave both values of each optional pair empty until
ready. Verify joining/linking and role assignment with a real Europe account.

## Unattended season maintenance

The EU worker configs target a separate Cloudflare worker named
`ggd2l-europe-automation-scheduler`. Its only target is the Europe automation
endpoint. The existing US worker configs are unchanged.

```bash
npm run scheduler:europe:check:paused
npm run scheduler:europe:check
```

Store the Europe app's `CRON_SECRET` as this worker's encrypted
`AUTOMATION_SECRET`, using the Europe configuration explicitly:

```bash
npx --yes wrangler@4.118.0 secret put AUTOMATION_SECRET --config ops/cloudflare-automation-worker/wrangler.europe.paused.jsonc
npm run scheduler:europe:pause
```

Follow the paused-worker bootstrap procedure in PRODUCTION-OPERATIONS if the
worker does not exist yet. Deploy paused until database initialization, login
and integration checks are complete. Then enable the one-minute trigger:

```bash
npm run scheduler:europe:deploy
```

Verify a successful Europe automation run in Admin and Cloudflare invocation
logs. To pause only Europe, run `npm run scheduler:europe:pause`. Do not use the
unqualified US `scheduler:deploy` or `scheduler:pause` commands for Europe.

## Dota lobby automation

Run a separate relay and persistent worker with a separate Steam account and
login state. The worker uses `DOTA_GAME_SERVER_REGION=3` (Europe), its own
`DOTA_BOT_STATE_DIR`, separate port and matching Europe relay credentials.
The web app's `DOTA_LOBBY_BOT_URL` and `DOTA_LOBBY_BOT_SECRET` point only to that
relay. Do not copy the US worker's Steam session or point both regions at one
active Dota account.

From `ops/dota-lobby-relay`, provision only the Europe relay:

```bash
npm ci
npm test
npm run check:europe
npx wrangler secret put DOTA_LOBBY_BOT_SECRET --config wrangler.europe.jsonc
npx wrangler secret put DOTA_RELAY_WORKER_SECRET --config wrangler.europe.jsonc
npm run deploy:europe
```

The Worker is named `ggd2l-europe-dota-lobby-relay`, with its own Durable Object
namespace. Generate two independent Europe secrets; the lobby secret is shared
only with the Europe website and bot, while the relay-worker secret belongs
only to this relay and bot. Use the HTTPS origin reported by this deployment
for both the Europe website's `DOTA_LOBBY_BOT_URL` and the Europe worker's
`DOTA_LOBBY_RELAY_URL`. Do not use the relay's unqualified `deploy` command,
which targets the US Worker. For first-deploy private-secret-file handling,
see [relay deployment](../ops/dota-lobby-relay/README.md#independent-europe-relay).

For the macOS worker, use `ops/dota-lobby-bot/.env.eu`,
`DOTA_BOT_STATE_DIR=./state/eu`, and `PORT=8091`. From the worker directory:

```bash
cp -n .env.europe.example .env.eu
chmod 600 .env.eu
```

Fill the empty Europe relay origin and both secrets in this private file before
starting. The template already selects Europe West (`3`) and separate local
state/port. It contains no Steam session or credentials. If the US worker has
customized its port or state path, choose unused values; the service helper
checks the peer configurations. Then sign in and install the EU service:

```bash
node --env-file=.env.eu login.mjs
node macos-service.mjs install --instance eu --keep-awake
node macos-service.mjs status --instance eu
```

The EU service label is `com.ggd2l.dota-lobby-bot.eu`. League-ticket configuration
must use the Europe inhouse ticket and each Europe season's own ticket, where
required. Set `NEXT_PUBLIC_INHOUSE_LEAGUE_NAME` to the ticket's human-readable
name only after that ticket is available; until then the site shows a neutral
Europe ticket placeholder. Keep `DOTA_SEASON_LOBBY_BOT_ENABLED=false` until the bot flow is verified.
See [DOTA-LOBBY-BOT.md](DOTA-LOBBY-BOT.md) and
[DOTA-BOT-HOSTING.md](DOTA-BOT-HOSTING.md) for the full worker/relay procedure.

## Verification before announcing

Run `npm run test:provisioning` for deployment/empty-bootstrap safeguards. With
an existing local disposable Postgres database, supply a validated local
`PG_TEST_URL` to also exercise transaction behavior in an isolated temporary
schema; it does not reset the shared test database.

Reuse the existing season tests for signup → draft → regular season → playoffs
→ champion, plus the Europe timezone/DST tests. In the deployed Europe site,
verify Steam login/admin access, empty signup season, no announced match date,
Discord link/channel delivery, scheduler execution, Europe game-host region,
and result import. Verify US signup/season, Discord and automation still point
to their original services. Run the full lifecycle rehearsal on disposable
data rather than populating the new production season with fixture players.

Both projects can track the same reviewed code releases; environment values
choose their regional identity. Keep per-project backups, restore receipts and
scheduler recovery procedures independent.
