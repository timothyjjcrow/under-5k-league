# Admin panel, performance and operations

How GGD2L is run and kept fast: admin actions and the panel's safety rails,
caching and streaming, the live rooms' connection handling, and the release
rules a code change must respect. Main files: `src/app/admin/page.tsx`,
`src/app/actions/admin-*.ts`, `src/components/danger-submit.tsx`,
`src/components/admin-match-tools.tsx`, `src/lib/admin-log.ts`,
`src/lib/admin-next-step.ts`, `src/lib/cached-queries.ts`, `room-clock.tsx`.

## Admin actions

- **Import each admin action from its own file.** They are split by job:
  `src/app/actions/admin-season.ts`, `admin-captains-draft.ts`,
  `admin-roster.ts`, `admin-schedule-results.ts`, `admin-discord.ts`. There is
  no `admin.ts`.
- **Keep `admin-shared.ts` free of `"use server"`:** every export of a server
  module is a callable endpoint. It holds `adminOrError`, `refresh`,
  `refreshGames` and the typed errors thrown inside transactions (one shared
  class keeps `instanceof` true whichever module threw).
- **Open every admin action with
  `const admin = await adminOrError(); if ("error" in admin) return admin;`.**
  `test/integration/admin-auth.itest.ts` calls each one signed out and as a
  player. It finds every `"use server"` file under `src/` that calls
  `adminOrError` or `requireAdmin` (or is named `admin-*.ts`) and fails until
  that file is in its `MODULES`, so a new admin-only module is covered wherever
  it lives. Seven older admin-only modules (`automation.ts`,
  `game-participants.ts`, `import-progress.ts`, `inhouse-admin.ts`, `news.ts`,
  `roster-history.ts`, `tiebreakers.ts`) still open with
  `try { await requireAdmin() } catch { return { error: "Not authorized" } }`:
  the same check and the same refusal, and they are in `MODULES` too. Not
  covered there: an admin-only branch inside a module captains also use, which
  checks `role === "ADMIN"` inline (scrims' `removeScrimGame`, the admin paths
  in team rename, standins and reschedule). Test those in their own files; the
  scrim service re-checks the role itself.
- **Assume the guard you need is missing.** The engines are hardened; the thin
  actions calling them are where untested defects hid. Re-assert preconditions
  at the write (`docs/features/concurrency-and-testing.md`).
- **Log with `logAdminAction`** (`admin-log.ts`): after the commit,
  best-effort (a failed log never fails the mutation), actor from the session
  (`actor` only for a break-glass action that revokes its own cookie), and a
  summary that carries the destructive numbers, since the row is the whole
  record. Pass the `seasonId` of season work (a service returns it when the
  action doesn't know it, as the standin services do), or /admin/activity
  files it as season-independent. **Consequential corrections write their
  audit INSIDE the transaction** (`removeGame`, `import-progress.ts`,
  `recordHistoryAction`, game identity corrections) so a failed audit rolls
  the correction back.
- **`AdminAction` has no foreign key to `Season` and denormalizes
  `actorName`:** a deletion's record must outlive what it deleted, and a Steam
  rename must not rewrite history.

- **The signup steps of the next-step banner count captains** when the
  panel passes `teamSize` and `captainVolunteers` (`adminNextStep`): "Enough
  for 6 teams of 5. Teams are captains: 0 designated, 3 more offered (“wants
  C”). Start draft needs only two captains, so the league can draft below the
  team goal." Home's admin strip repeats only the title, which those inputs
  never change, so it needs no extra query.
- **Needs attention calls a series overdue only past its expected finish**
  (`matchAttention`): the league's series estimate (`seriesEstimateMinutes`,
  bestOf × 60 + 30 minutes), doubled once a game is in, the window that keeps
  "Live now" up (`matchWatchWindow`). A flat two hours flagged Bo2s and Bo3s
  still being played while Tonight showed them as Live. The Home admin strip
  feeds it the same `bestOf`.
- **Once the auction is complete, Schedule & results leads the panel**
  (`setupFirst` is signups, or the draft phase before the auction ends): the
  captains card, which lists every signup, used to sit between the admin and
  Generate schedule on draft night.
- **Generate schedule refuses a week 1 in the past** (server check plus the
  box's `min`): kickoffs that already happened get no check-in window, an
  instant "result due" and pick'em locked from the start.
- **Toasts say what changed:** an admin game import says the series it
  leaves ("Game imported — series final 2–0", the captain report's words),
  draft settings name the team goal, and a shuffle lists the new draft order.
- **Reinstate shows only where it works:** a removed player signup reads
  "reinstate after the auction" while the auction is live or paused, since
  `reinstateSignup` refuses it then.

## Destructive controls

- **Put no-undo actions behind `<DangerSubmit>`, everything else behind
  `<SubmitButton confirm>`.** A `window.confirm` is one Enter away and looks the
  same for every action; DangerSubmit arms only when the season or team name is
  typed exactly. The must-have set is `UNRECOVERABLE` in
  `danger-submit.test.ts` (delete season, abort draft, reset/reseed playoffs,
  regenerate schedule, remove captain once a fixture exists); find the rest
  with `grep -rn "<DangerSubmit" src`. Never use it on a reversible action: the
  fatigue it would rebuild is what it exists to break (so remove captain with
  no fixtures, which deletes only the team, is a plain confirm, and
  `changeCaptain` keeps the team).
- **Make the token a real name, never "DELETE".** The unit test pins the exact
  match, one submit button, Enter blocked, the focus trap and a cleared token;
  `e2e-mid/danger.spec.ts` proves it in a browser. The name is submitted as
  `confirmationName` and `deleteSeason` re-checks it server-side; the
  `evidence` prop demands the backup receipt on /seasons.
- **Make confirms state what dies, from the database.** `loadSeasonAdminData`
  returns `collateral` (check-ins, pick'em picks, standin bookings, open
  proposals) for the regenerate and remove-captain dialogs.
- **Keep a destructive control apart from its harmless twin.** "Start
  playoffs"/"Reset playoffs" and "Generate schedule"/"Regenerate schedule" are
  separate controls; one button whose meaning flips with state sends muscle
  memory to the wrong one.

## Honest copy and the panel's roadmap

- **Name only controls that exist.** `src/app/admin/admin-copy-guard.test.ts`
  ties each quoted control name to a rendering file (`REFERENCED_CONTROLS`),
  and bans known wrong names plus copy saying the draft can't be undone
  (`abortDraft` undoes it) or that the soft MMR limit refuses signups.
- **`adminNextStep` (`admin-next-step.ts`, pure, tested) gives one "what next?"
  line per phase** under the panel title, because several transitions fail
  quietly: the auction ending does not advance the phase, a schedule without
  kickoff times turns off auto-sync, reminders and pick'em locks, and nothing
  else prompts "start the playoffs" or "record the final". With
  `hasLeagueTicket: false` it adds a separate `ticketWarning` from Signups
  through the Playoffs (Valve wants ticket applications about 15 days ahead),
  linking to `#adm-league`; the draft preflight shows the same "League
  ticket: not set" row. Nothing renders once a ticket is set.
- **Every in-page `#adm-` link needs both an `AdminAnchor` and a jump-bar
  entry** (checked by `admin-copy-guard.test.ts`), so a link never lands
  nowhere and the jump bar can open a folded target.
- **Every admin date/time box reads on the league's clock:**
  `<LocalDatetimeField timeZone={LEAGUE_CONFIG.timeZone}>` names the zone and
  shows the viewer's own time beside it ("= 11:00 your time", hidden when the
  browser zone can't be formatted). `admin-time-zone-guard.test.ts` fails on
  an admin box without the prop. Keep the label beside the field, not around
  it, or the hint joins the box's accessible name. Captain boxes stay on the
  viewer's clock and say "your time".
- **The Match stream card is league-wide** (`#adm-stream`, first of the
  evergreen sections): `setLeagueStreamUrl` (`admin-season.ts`) stores one
  Twitch, YouTube or Kick link in `LEAGUE_STREAM_URL`, checked by
  `normalizeStreamUrl` (`broadcast.ts`: https, exact host names, no
  credentials or port). It works with no active season and survives the
  handoff; a blank save (Remove stream link) clears it, and the toast repeats
  what was stored. The next season's date on the Season handoff card
  (`setNextSeasonDate`, `clearNextSeasonDate`) is the season-bound one: refused
  outside Season complete and from a stale page, and it lapses at the handoff
  because it names its season (`next-season.ts`).
- **The Inhouse night card is league-wide** (`#adm-inhouse-night`, just before
  Discord notifications): `setInhouseNight` plans, moves or re-notes one night
  and `cancelInhouseNight` takes it down (`admin-inhouse-night.ts`; rules in
  `inhouse.md`). Its start box is on the league's clock (suggesting the coming
  Friday at 8 PM) and the form names the night it showed, so a save from a
  stale page is refused. The toast says what happened on Discord: posted or
  not, and the server event created, updated, or blocked because the bot lacks
  Create Events (the bot checklist under Discord notifications has that line).
- **Render per-match controls only from `admin-match-tools.tsx`.**
  `MatchResultRow` (kickoff, score or ruling, reopen, games, Auto-fetch games,
  Add game) and `StandinMatchBlock` (any-team cover) render on /admin AND in
  the match page's folded "Admin tools" card (`AdminMatchTools`, admins on the
  active season, `#match-admin`, opened by `AutoOpenDetails`), so actions,
  confirms and gates cannot drift. Both read `matchCorrectionContext`
  (`league-lifecycle.ts`) and `adminStandinPoolWhere`. Don't re-inline them;
  `src/app/matches/[id]/match-page-guards.test.ts` pins it.
- **Link into /admin by row id:** each result row has `adminMatchRowId`
  (`match-anchors.ts`) and `RevealHashTarget` opens its folded week.
- **Show one import form per viewer.** A captain-admin already has Auto-fetch
  games and Add game in Captain tools, so Admin tools points there
  (`captainImportOnPage`). Once a game is imported `StandinMatchBlock` shows
  "Locked: series already started" (`removeStandinGuarded` refuses).

## League health (`/admin/health`)

- **Its own route, not a card on /admin.** /admin is the match-night console
  for the active season; health compares seasons, so it takes `?season=` and
  sits beside `/admin/data-quality`, linked from Needs attention ("League
  health", next to "Check imported-game quality"). The guard is the
  data-quality page's: signed out goes to `/login?next=`, a non-admin gets the
  same 404 as a missing page, the parameter goes through `singleSearchParam`
  (a repeated key is a 404), then `resolveSeasonScope` (an unknown id is a
  404; none means the active season, else the latest). The `SeasonSwitcher`
  lists every season; with no season at all the page says so.
- **Counts only.** `loadLeagueHealth` (`league-health-service.ts`) reads the
  season list, then every count, groupBy and id/timestamp select in one
  `Promise.all`; `buildLeagueHealth` (`league-health.ts`, pure, tested) does
  the arithmetic. No player names, contact details, message bodies, client
  payload, Discord or OpenDota call, or cached-queries tags:
  `league-health.test.ts` pins the page's and the service's imports and
  selects.
- **Unknown is its own answer.** Never drafted (active player signups never on
  a team: not a captain, not bought, not signed later) is counted only after
  a COMPLETE auction and only while roster history covers the season. A
  `LEGACY_CAPTURE` tenure or a roster seat with no tenure makes it unknown, and
  so does a season past its draft with no finished auction (the e2e
  fixtures). Its void tenure endings are `profile-seasons.ts`'s, kept equal by
  a parity test. A booking on a match with no kickoff has an unknown lead
  time, and a rate with nothing to divide reads "None yet".
- **The page states its caveats:**
  - Withdrawals and removals have no date, so they are counted as they
    stand now.
  - Check-ins count only kicked-off series, forfeits left out, at the current
    `scheduleRevision`: a new kickoff deletes them. Seats are full sides plus
    booked standins, capped per series.
  - A removed standin booking is deleted, so it isn't counted, and lead time
    runs to the current kickoff.
  - Discord posts (`LeagueAnnouncement` rows marked SENT) carry no season.
    A season owns those sent from its `createdAt` until the next season's
    (or now), and kinds come from the dedupe key's first segment (pinned to
    `announcementDedupeKey` and the two expiry groups). News copies, webhook
    tests and inhouse posts aren't counted.
  - New accounts are counted in Monday weeks on `LEAGUE_CONFIG.timeZone`; the
    latest `MAX_WEEKS_SHOWN` weeks show and the rest fold into one line.

## Archives and recovery

- **The season export is an audit archive, not a backup.**
  `GET /api/admin/season-export` (JSON with box scores, which OpenDota ages
  out) is `restorable: false` and never satisfies the deletion gate.
- **Production `deleteSeason` needs a backup receipt:**
  `productionDeleteBackupError` (`src/lib/backup-receipt.mjs`) wants a signed
  full-dump receipt for the same Postgres database, backup and verification
  each under 24 hours old.
- **Merge pre-delete archives, never replace them.** `removePostseason`
  (`playoff-service.ts`) unions removed games' `dotaMatchId`s into
  `playoffGamesArchive:<seasonId>` by id, so reset, re-import, reset loses
  nothing.
- **`reactivateSeason` (`season.ts`) is the undo for archiving.** /seasons
  offers "↩ Resume season" or "↩ Reactivate for corrections" only while no
  season is active; it never archives the current one (that would bypass the
  cancel workflow). Tested in `season-reactivate.itest.ts`.

## Performance

- **Never await Discord in /admin's blocking render** (the "DiscordSection
  rule"). `DiscordSection` alone calls Discord (`getPingHealth`'s 4s-timeout
  calls, `getInhouseBoardStatus`'s full-history Elo scan) and streams behind
  `<Suspense>`; inline it held up Pause draft and Record result, worst when
  Discord was down.
- **Stream slow cards** in `<Suspense fallback={<CardSkeleton/>}>` (fixed
  height, no layout shift), as the dashboard (`src/app/page.tsx` +
  `src/components/home/`) and `src/app/matches/[id]/page.tsx` do. The root
  `loading.tsx` covers navigation.
- **Route all-games roll-ups through `cached-queries.ts`,** never an inline
  `prisma.game.findMany`: attribution lives in `Game.players` JSON, so every
  board scans the whole table. They share `createPublicSnapshot`
  (`public-cache.ts`): `unstable_cache`, 60s, tag `"games"`, keyed by the
  `publicGameRevision` that `stampResultChange` bumps on every result write.
  Exception: the scouting report's `fetchGamesForScouting`
  (`game-participants.ts`) stays a direct query, because a cached wrapper hung
  the match preview's nested Suspense stream.
- **Cache what an all-history page shows, never the rows.** The raw
  all-history snapshot passes Next's 2 MiB entry at about 160 games (about
  12 KB a game in Next's envelope, where the box-score JSON is escaped twice)
  and then caches only an `oversize` marker, so each of its readers re-reads
  and re-decodes every Game on every view. The record book, record watch, the
  Hall of Fame and /players' last-season token read small derived entries
  under the same revision key, "games" tag and 60s TTL instead
  (`getRecordBookView`, `getRecordWatchBook`, `getCareerFacts`), each built
  from the uncached `fetch*` reads (a nested `unstable_cache` skips its own
  cache and still writes its entry). `history-cache-size.test.ts` keeps each
  under a twentieth of the budget on a 500-game synthetic history (the raw
  rows: 5.9 MB) and checks a later view reads no Game. Keep out of an entry
  anything a write can change without stamping the revision (series results,
  champions): read it fresh and fold it in (`careersFromFacts`). Still raw:
  `/players/compare` (`getAllGameScores`) and the season snapshots, which one
  season of 110-160 games can also push past the budget.
- **The participant read pays for its guard on every Game row.**
  `fetchGamesForPlayers` (the profile, its link picture, the scouting report,
  Home's match-night card) keeps the exact-source comparison
  ([HISTORICAL-PARTICIPATION](../HISTORICAL-PARTICIPATION.md)), which on
  Postgres detoasts both copies of a row's box score. Postgres evaluates the
  covered arm's terms in order, so the index test goes first and another
  player's covered game skips the comparison (half the buffers on a 600-game
  local measurement); the uncovered arm still compares every row, about 15 ms
  a call there, growing with history. Never run it where its result can't
  render (the match-night card checks `matchNightWindowOpen` first), and load
  whole games with `select: GAME_VIEW_COLUMNS`, never `include`, so the copy
  stays in the database.
- **Bust `"games"` from request scope, never from lib.** Server Actions call
  `refreshGames()` (`updateTag`; `admin-shared.ts`, copies in `teams.ts` and
  `match-report.ts`) for read-your-own-writes. Never swap it for
  `revalidateTag("games", "max")`: that serves the first reader stale data and
  refreshes in the background, so the admin or captain who just imported
  doesn't see their game. Route handlers (the automation worker, the test
  cache route) use `revalidateTag("games", { expire: 0 })`. `revalidatePath`
  alone does not clear the tag. Team renames bust it too (record matchups
  embed team names). The TTL only backstops outside writes.
- **Tick countdowns in a leaf** (`useSecondsLeft`/`useElapsedMs`,
  `room-clock.tsx`) so only the clock text re-renders every 250ms; never a
  room-level `forceTick`.
- **Index hot filters:** add an `@@index` (with its migration) when a new query
  filters a non-indexed column, unless an `@@unique` already has it leftmost.
- **Select only display fields for client payloads** (`id/name/avatar/rankTier`,
  as `getSeasonSnapshot` does), never `include: { user: true }`; the derived
  `SeasonSnapshot` type makes tsc enforce it.
- **Don't prefetch links that come in lists.** Every page is dynamic (the
  layout reads cookies), so a default `<Link>` in view sends a metadata-only
  prefetch that runs the target's `generateMetadata`: about eleven queries
  for a player profile, four for a match. On a production build, scrolling
  `/players` ran 408 statements against the page's own 37. `PlayerLink`
  defaults to `prefetch={false}` (pass `prefetch` to opt back in), and the
  schedule's, bracket's and season grid's match links set it. (Since
  2026-10-12 no link prefetches at all: `@/components/app-link`.)
- **Draw medals from the 72px copies** (`public/ranks/72`, behind a
  year-long immutable cache header in `next.config.ts`): `RankMedal` at its
  24px default used the 256px masters, 374KB on `/players`. The share
  pictures (`og-assets.ts`) keep the masters, which browsers keep a day
  ([pages-and-ui](pages-and-ui.md#static-files-and-icons)).

## Live rooms: connection health and fetch deadlines

Shared by the draft room and the inhouse room (room-specific rules are in
`docs/features/draft.md` and `docs/features/inhouse.md`).

- **Go disconnected only on CONSECUTIVE failures.** `usePollHealth` flips
  `disconnected` at `ROOM_POLL_FAIL_THRESHOLD` failures in a row and any
  success clears it (pure `pollHealthAfter`, `poll-health.ts`), so a flaky
  connection never locks the room.
- **A 429 on a room poll is back-pressure, not a failure, in BOTH rooms.** Ease
  off (`rateLimitedMs` in `roomPollCadence`) and never count it toward
  `disconnected`: tripping it would disable every bid or accept control over a
  rate limit, the moment a player most needs to act. (The inhouse room's
  cold-page exception is in `docs/features/inhouse.md`.)
- **While disconnected, disable every action and say so** (aria-live strip;
  each room folds `disconnected` into `pending`). Never swallow poll failures:
  that is how a frozen auction sold a captain's player. A 404 from
  `/api/draft/tick` is terminal ("no active season"), not a retry loop.
- **Give every client fetch an `AbortSignal.timeout`.** A request that connects
  and never answers holds `inFlight`/`pending` forever with `disconnected`
  still false. Polls use `ROOM_POLL_TIMEOUT_MS`. `room-source-guards.test.ts`
  fails on any `fetch(` in a `"use client"` file without `signal:`;
  `e2e/zz3-room-poll-resilience.spec.ts` hangs the poll and expects a retry.
- **Size action deadlines per action:** `ROOM_ACTION_TIMEOUT_MS` for DB work,
  `INHOUSE_SCAN_ACTION_TIMEOUT_MS` for `INHOUSE_SCAN_ACTIONS` (OpenDota). One
  slow-path ceiling would leave ACCEPT disabled through the ready check. The
  budgets are explained beside them in `constants.ts`.
- **Treat a lost action response as unknown, never as failed.** It may have
  committed. On a timeout, 5xx, network error or bad payload, toast that you
  are checking, hold actions (`actionReconciling`) and let the next poll
  answer.

## Release, migrations and backups

Procedures live in `README.md` (Deployment, Backups), `docs/RELEASING.md` and
`docs/PRODUCTION-OPERATIONS.md`; they win over this list.

- **Keep build code side-effect-free.** `npm run build:vercel`
  (`scripts/vercel-build.mjs`, which the box's agent runs per league with
  `NODE_ENV=production`) runs env validation, the read-only
  `production-schema-check.mjs`, then `next build` with runtime config and the
  real database's URL.
- **Ship schema changes as committed migrations, additive and compatible with
  the binary still serving** (it keeps serving while they run). Breaking
  changes go expand, deploy, backfill, contract. `scripts/migration-safety.mjs`
  refuses destructive SQL and pins each migration's hash in `MIGRATION_SHA256`:
  add yours there, never edit an applied one. Two more lists name every
  migration in order: `src/lib/migration-safety.test.ts` and both lists in
  `scripts/migration-rehearsal.mjs` (CI's `db:migrate:rehearse`, which only
  the Postgres job runs). Add a new migration to all three.
- **Never `db push` production.** Only `npm run db:migrate:release` applies
  migrations there; `npm run db:push` refuses non-local databases.
- **Migrations run on the box through the agent, as the owner role**
  (`docs/RELEASING.md` Appendix B): a fresh dump and a drill first, then the
  guarded wrapper, then the app role's grants check. A new table the app role
  can't write fails that check, so a migration never needs a hand-written
  `GRANT`. The Preview step is retired: the box has no Previews.
- **Add each new required production env var to
  `scripts/validate-prod-env.mjs`** (it reports names, never values), to
  `/etc/ggd2l/<lg>.env` on the box before the release that needs it, and to the
  env contract (`ops/selfhost/agent/env-contract.mjs`) only when a slot must
  not serve at all without it and a working box always passes it. Never point
  a staging slot or a development build at a production database.
- **The production validation runs before a restart, never at a slot's
  start.** Every build runs `validate-prod-env.mjs`; `box_agent envcheck <lg>`
  runs the live release's copy against the file as it stands (as the league
  user, names only), and every runbook that edits an env file runs it before
  the restart and stops on a problem. The slot's `ExecStartPre` is the env
  contract alone: a start it refused would turn a broken sign-in into a league
  that is down, and after a reboot both. Keep `validate-prod-env.mjs`'s
  messages naming keys (`envcheck` reports the `UPPER_SNAKE` names in them).
- **Release strictness comes from `scripts/classify-release.mjs` taken from
  the live commit**, never the candidate. A path it does not name is unknown
  and selects the database release and the scheduler pause, so name a new
  top-level file or folder there when you add it
  (`release-classification.test.ts` fails until you do). The new rule spares
  only the releases after the classifier change is live.
- **A verified checksum is not a restorable backup.** `db:backup:verify`
  proves bytes; only a restore (`db:backup:rehearse`, which the box's weekly
  drill runs) proves the league comes back.
- **A rollback runs once.** `box_agent rollback <lg>` records the release it
  left (`rolledBackFrom` in `live.json`) and a second one refuses until the
  next promote, so a retry can't put the bad release back; going back to it
  is `promote <lg> <id>`.
- **Never put a credential in argv, a commit, a log, an issue, a screenshot or
  chat** (`backup-db.mjs` passes libpq env fields for this reason).

## The box

Production is one self-hosted box for both leagues
([PRODUCTION-OPERATIONS](../PRODUCTION-OPERATIONS.md#box-operations); status:
live since the cutover on 2026-10-17). What a code change must respect there:

- **One process per league, two during a release.** Caddy sends a league's
  traffic to one slot at a time; a promote keeps the old slot running at
  least 90 seconds for its in-flight requests. Per-process state (the inhouse
  room snapshot, the rate limiter's buckets, Next's cache tags) is therefore
  league-wide most of the time but not always: keep the per-instance rules
  ([concurrency-and-testing](concurrency-and-testing.md#per-instance-caches-the-inhouse-room-snapshot)).
- **Every slot starts clean.** A start deletes `.next/cache/fetch-cache`,
  since Next keeps tag state only in memory and a leftover entry could serve
  an old automation-gate snapshot. Never rely on the fetch cache surviving a
  release or a restart.
- **A slot writes only `RELEASE_WRITABLE_DIRS`** (`ops/selfhost/agent/layout.mjs`):
  `.next/cache` (the fetch and image caches) and `.next/server/route-cache`,
  where Next 16 keeps its response cache for prerendered routes (a copy of
  each build seed, and every re-render after a `revalidatePath`). The rest of
  the release is read-only, so a write elsewhere fails, usually with only a
  warning (`Failed to update prerender cache`, cutover day). The build creates
  the folders, the units name them, and CI's boot step fails a build that
  writes anywhere else. The route cache is kept across restarts: it holds
  only `/manifest.webmanifest`, `/robots.txt` and the global error page, all
  fixed per build. A prerendered route that reads data would need it wiped at
  start like the fetch cache.
- **One Prisma client per process.** `src/lib/prisma.ts` keeps it on
  `globalThis` in every environment: Next loads the module once per server
  bundle, and a client held in the module opened a pool per bundle (two per
  process on the box, `prisma.test.ts`). `connection_limit=8` is therefore per
  process; four processes in a release overlap use 32 of the 47 usable
  connections.
- **Never call `/api/sync` or `/api/health/automation` against a
  candidate.** They cache automation state in the candidate's own process;
  the agent's `check` refuses a candidate whose fetch cache holds those tags.
  A candidate is checked only by `ops/selfhost/smoke/smoke.mjs`; add a check
  there, not a probe elsewhere.
- **Build redirects and origin checks on `publicOrigin(req)`.** Behind the
  tunnel Next builds `req.url` from the local bind address
  (`https://localhost:<port>`), never the public hostname;
  `src/app/route-redirect-origin.test.ts` fails on a redirect built from
  `req.url` or `request.url`. The Steam `return_to` and `realm` and the
  Discord `redirect_uri` stay on `providerReturnBase(req)`: the canonical
  origin when declared, else `APP_URL` or the request's origin, so a Vercel
  or local request on another host still hands the provider its registered
  callback. Never swap it for `publicOrigin`.
- **Keep `after()` work short.** A stopping slot gets 60 seconds
  (`TimeoutStopSec`), which covers the cron's 45-second budget and the
  `after()` drain; route `maxDuration` exports do nothing on the box. Held
  `/inhouse` requests don't add to it: on SIGTERM every hold answers at
  once (`inhouse-room-wait.ts`), so a slot Caddy no longer routes to stops
  after one ordinary poll, not a 25s hold. A restart of the live slot still
  serves new requests on Caddy's open connections until it exits, answered
  unheld so tabs fall back to their ladder.
- **Exactly one clock.** No systemd timer, in-process cron or monitor calls
  `/api/cron/automation`; a new deadline gets a wake-up in
  `src/lib/automation-gate.ts`, never a timer of its own.
- **Builds share the box with both live sites.** A build runs as
  `ggd2l-build` at low priority with a 3 GB Node heap, held by its unit's
  limits near 1.1 GiB with the rest in swap; the 2026-10-15 trial build
  peaked at 1.54 GB outside them, so never cap its memory below that. Each
  build's real peak is its unit's cgroup `memory.peak` (`peakRssMb`, read as
  the unit stops), never systemd-run's own `Memory peak:` line, which systemd
  255 can repeat from the unit's first second. Count a new dependency's
  install and build cost on one vCPU, and a new background request's
  database work.
- **Root never works through a link a service user could have left.** The
  build user runs third-party install scripts and `ggd2l-ops` runs the
  build user's tools clone, so either can leave a link wherever it writes,
  and GNU `install -d`, `chown` and `chmod` change a link's target (until
  2026-10-19 that let a build re-own the agent's own code). In
  `ops/selfhost/`:
  - Root changes only folders in a parent no service user can write.
  - A folder the build user fills is made by `makeBuildDir`: root's
    `mkdir`, then the mode, then `chown -h`.
  - A tree comes back through `takeBackTree` before root reads, chmods or
    writes through it.
  - Such trees are deleted with `removeTree` (GNU `rm`). Node 22's
    `rmSync` follows a folder swapped for a link mid-walk.
  - Records go through `writeFileAtomic`.
  - A folder inside a service user's own folder is that user's to make
    (`buildUserEnv`'s npm cache, `ensure_user_dir`).

  `install-kit.test.mjs` fails an `ensure_dir` whose parent a service user
  can write.
- **`ggd2l-ops` runs only the kit's own code.** It holds the R2 key and the
  backups. Code the build user wrote, including whatever a dependency's
  install script changed in the tools clone, runs only as users without
  them. The hourly backup runs the kit's copies of `scripts/backup-db.mjs`,
  `scripts/verify-backup.mjs` and their imports
  (`/usr/local/lib/ggd2l/app/`). A change to those files therefore reaches
  the box with `install-kit.sh`, not with an app release, and they must
  stay free of packages: `install-kit.test.mjs` keeps `BACKUP_APP_FILES`
  equal to their imports. The restore drill needs the tools clone, so it
  runs as `ggd2l-drill`, from a private copy of the one dump each backup
  hands it (`drill/`). `backup-scripts.test.mjs` fails a `ggd2l-ops` unit or
  agent call that reaches for a tools clone.
- **Never run a test suite, `pg:up` or `db:push` on the box.** Its localhost
  Postgres is production (`ggd2l_us`, `ggd2l_eu`), and the destructive
  scripts accept only the test names, which production never takes.
- **Treat the box's logs as personal data.** Caddy's access logs hold player
  IP addresses (size-bounded, kept on the box); never copy them into an issue
  or a report.
- **Caddy's admin API is a socket only caddy and root can open**
  (`/run/caddy/admin.sock`, 0600, in the drop-in's 0700 `RuntimeDirectory=`).
  It can replace both leagues' routing with no authentication, so never put it
  back on TCP (it was `localhost:2019`, open to every local user, until
  2026-10-19) and never call it from the agent or a script: change Caddy by
  writing a file and `systemctl reload caddy`, whose `caddy reload` reads the
  socket from the Caddyfile (`caddy.test.mjs`). A change of the admin
  address needs one Caddy restart, which `install-kit.sh` does only while
  nothing is live and otherwise asks for (`caddy_reload`).
- **Expect PostgreSQL and the slots to restart at 08:00-08:15 UTC.**
  Unattended upgrades install then (`provision-base.sh` moves
  `apt-daily-upgrade.timer` next to the 09:00 reboot): a PostgreSQL update
  restarts the cluster, and needrestart may restart a live slot or the bot.
  Code that holds a connection or a lease must survive that, as it survives
  the reboot.
- **The lobby bot's state is in the daily config archive**
  (`config-archive.sh`), less its locks, `logs/`, `steam-login.png` and
  `*.tmp` files, so a rebuild brings its Steam session and `lobbies.json`
  back. A bot change that adds a state file to keep needs nothing; one that
  adds a temporary file must name it `*.tmp`, and tar's "file changed as we
  read it" makes the archive run again rather than keep a torn copy.
