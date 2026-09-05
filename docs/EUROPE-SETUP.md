# GGD2L Europe setup

Both leagues run the same source code. Europe uses its own Vercel project,
PostgreSQL database, scheduler and Discord server. Players
use Steam to sign in separately on each site; profiles, admins, registrations,
seasons, drafts, matches, records, inhouses and credits are separate.

The live site is [GGD2L Europe](https://ggd2l-europe.vercel.app). Season 1 is open
for signups with **match night to be announced**, no draft date and no first
match date. The approved lobby-hosting plan shares the existing US Dota worker,
Steam account and relay, with explicit US/EU region support; see the activation
sequence below. Do not install a second Steam session for this shared setup.

## Deployment status — 5 September 2026

The initial Europe deployment uses commit `ea310cc`. The following was checked
at 09:24–09:27 UTC; shared-bot changes were still being prepared at that point.

| Component | Current setup |
| --- | --- |
| Website | Vercel project `ggd2l-europe`, region `fra1`, public origin `https://ggd2l-europe.vercel.app` |
| Database | Dedicated Neon project `ggd2l-europe-db`, Frankfurt (`eu-central-1`), PostgreSQL 18; reviewed migrations and empty-instance bootstrap completed |
| Season | `GGD2L Europe Season 1`, active `SIGNUPS`, zero registrations and matches; match night and draft date unset |
| Identity | Database markers are `deploymentRegion=eu` and the Europe site origin; timezone is `Europe/Berlin` |
| Discord | Guild `1545717985342267435`; [Europe invite](https://discord.gg/tJH7eKJxFE); app `1545719497472741466`; bot installation/permissions and announcement-channel setup remain to complete |
| Scheduler | Independent `ggd2l-europe-automation-scheduler`, every minute; deployed version `5212a585-4860-41b6-b6aa-3631d6c7a0f8` |
| Dota | Shared existing US worker/account/relay approved; shared-region code, rollout and Europe ticket verification remain to complete. The separately deployed EU relay is unused by this plan |

Read-only checks returned HTTP 200 with `cache-control: no-store` from
[`/api/health/live`](https://ggd2l-europe.vercel.app/api/health/live),
[`/api/health/ready`](https://ggd2l-europe.vercel.app/api/health/ready) and
[`/api/health/automation`](https://ggd2l-europe.vercel.app/api/health/automation),
reporting `live`, `ready` and `healthy`. The home, schedule, teams, players,
seasons, features, inhouse, news and login pages loaded successfully with no
links to the US site origin or US Discord invite. The manifest names Europe,
and the calendar contains no fixtures.

The database recorded a successful `CRON` maintenance pass at
`2026-09-05T09:17:28.915Z`, with zero consecutive failures. An independent live
tail then observed successful scheduled invocations at **09:25:47 UTC** and
**09:26:47 UTC**. An idle signup season can return successful `NOT_DUE` responses
without advancing the database's `lastSuccessAt`: the idle gate has a maximum
60-minute hard wake. Use the public automation probe and scheduler invocation
outcomes together when checking an otherwise quiet league.

Remaining launch work is the Discord installation, role/channel/webhook checks,
the safe shared-bot rollout and Europe ticket test, and verification of the
independent Europe backup/restore receipts. Organizers can announce the match
night and draft later; neither has been invented for this setup.

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
   `AUTH_SECRET`, `CRON_SECRET` and `BACKUP_RECEIPT_SECRET` values. The approved
   shared lobby bot uses the existing relay's app credential as described below.
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

This initialization has already completed for the live Europe database. The
commands below document how to provision a replacement empty instance; do not
repeat bootstrap against the live season.

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

The Europe server and application now exist. Complete installation and
permissions for that bot in guild `1545717985342267435`, then configure:

- OAuth application and bot, with redirect
  `https://ggd2l-europe.vercel.app/api/auth/discord/callback`;
- league announcements webhook, inhouse queue board webhook, optional separate
  inhouse alerts webhook, and opt-in inhouse role;
- invite URL in `NEXT_PUBLIC_DISCORD_INVITE_URL`.

The invite is already `https://discord.gg/tJH7eKJxFE`. At the verification above,
the private configuration referenced the correct Europe guild/application,
while incoming webhooks and database webhook overrides were unset. The bot's
Discord installation approval was still pending; do not treat the presence of
OAuth credentials as proof that guild joining, role assignment or delivery works.

`DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` and `DISCORD_BOT_TOKEN` /
`DISCORD_GUILD_ID` are paired settings. The OAuth app and bot should refer to the
same Discord application. Leave both values of each optional pair empty until
ready. Verify joining/linking and role assignment with a real Europe account.

## Unattended season maintenance

The EU worker configs target a separate Cloudflare worker named
`ggd2l-europe-automation-scheduler`. Its only target is the Europe automation
endpoint. The existing US worker configs are unchanged.

The one-minute Europe trigger is already active. The commands below are the
reviewed validation, rebuild and pause controls, rather than outstanding setup.

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

The user approved sharing the existing US relay, persistent Dota worker and
Steam account. Both sites will use that relay's origin and the same app-to-bot
secret; database/session/Discord/scheduler secrets remain separate. There is
**one shared active lobby**: a request from either league receives `BUSY` while
the other owns the worker. This does not merge any league data or seasons.

Shared operation requires the updated relay protocol, worker and app code:

1. Deploy the updated existing relay protocol before enabling shared requests.
2. Finish/release any active lobby before restarting the existing worker.
3. Set `DOTA_GAME_SERVER_REGIONS="2,3"` for that worker. This explicit allowlist
   takes precedence over the singular `DOTA_GAME_SERVER_REGION`; it permits
   US East (`2`) and Europe West (`3`) on the same process/account/state.
4. Point the Europe project's `DOTA_LOBBY_BOT_URL` and
   `DOTA_LOBBY_BOT_SECRET` at the approved existing relay. Keep all US lobby
   identifiers unchanged. Europe requests use an `eu:` identifier prefix;
   the shared worker rejects that namespace on US East and rejects unprefixed
   requests on Europe West.
5. Verify the Europe game-server region and ticket in an actual hosted lobby,
   then check that US hosting and cross-region `BUSY` behavior still work.

Do not start `.env.eu`, install a second macOS service or sign the shared Steam
account into a second worker. The separate `ggd2l-europe-dota-lobby-relay` Worker
already exists but is unused by this shared plan. Independent relay/service
templates remain available for a future decision to provision a second account;
see [relay deployment](../ops/dota-lobby-relay/README.md#independent-europe-relay).

Europe still needs its inhouse ticket and each season's ticket configured where
required. Sharing a Steam account does not grant that account permission to a
new ticket. Set `NEXT_PUBLIC_INHOUSE_LEAGUE_NAME` to the ticket's actual name
only after it is available; until then the site shows a neutral Europe ticket
placeholder. Keep `DOTA_SEASON_LOBBY_BOT_ENABLED=false` until the flow is verified.
See [DOTA-LOBBY-BOT.md](DOTA-LOBBY-BOT.md) and
[DOTA-BOT-HOSTING.md](DOTA-BOT-HOSTING.md) for the full worker/relay procedure.

## Europe recovery configuration

Private Europe configuration is retained outside the repository under
`~/.config/ggd2l-europe`. Do not print, commit or copy these secrets into the US
project. Supply the Europe database URLs and receipt key explicitly when using
the existing backup/verification commands, with a separate Europe backup folder.

The Neon database runs PostgreSQL 18. On this Mac, prepend
`/opt/homebrew/opt/postgresql@18/bin` to the command's `PATH` so `pg_dump` and
`pg_restore` use the compatible client; an older Homebrew client can reject the
server version. Record a verified backup and restore-rehearsal receipt using
[PRODUCTION-OPERATIONS.md](PRODUCTION-OPERATIONS.md) before considering recovery
complete. No backup or restore was performed by the read-only checks above.

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
