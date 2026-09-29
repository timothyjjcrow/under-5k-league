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
  player. It globs only `src/app/actions/admin*.ts`, and fails until a new
  `"use server"` file matching that glob is in its `MODULES`; so put new admin
  actions in an `admin-*.ts` file. Seven older admin-only modules sit outside
  the glob, use `try { await requireAdmin() } catch`, and have NO refusal
  coverage there: `automation.ts`, `game-participants.ts`,
  `import-progress.ts`, `inhouse-admin.ts`, `news.ts`, `roster-history.ts`,
  `tiebreakers.ts`.
- **Assume the guard you need is missing.** The engines are hardened; the thin
  actions calling them are where untested defects hid. Re-assert preconditions
  at the write (`docs/features/concurrency-and-testing.md`).
- **Log with `logAdminAction`** (`admin-log.ts`): after the commit,
  best-effort (a failed log never fails the mutation), actor from the session
  (`actor` only for a break-glass action that revokes its own cookie), and a
  summary that carries the destructive numbers, since the row is the whole
  record. **Consequential corrections write their audit INSIDE the
  transaction** (`removeGame`, `import-progress.ts`, `recordHistoryAction`,
  game identity corrections) so a failed audit rolls the correction back.
- **`AdminAction` has no foreign key to `Season` and denormalizes
  `actorName`:** a deletion's record must outlive what it deleted, and a Steam
  rename must not rewrite history.

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
  (`scripts/vercel-build.mjs`) runs env validation, the read-only
  `production-schema-check.mjs`, then `next build` with runtime config.
- **Ship schema changes as committed migrations, additive and compatible with
  the binary still serving** (it keeps serving while they run). Breaking
  changes go expand, deploy, backfill, contract. `scripts/migration-safety.mjs`
  refuses destructive SQL and pins each migration's hash in `MIGRATION_SHA256`:
  add yours there, never edit an applied one.
- **Never `db push` production.** Only `npm run db:migrate:release` applies
  migrations there; `npm run db:push` refuses non-local databases.
- **Add each new required production env var to
  `scripts/validate-prod-env.mjs`** (it reports names, never values). Never
  point a Preview or development build at the production database.
- **Release strictness comes from `scripts/classify-release.mjs` taken from
  the live commit**, never the candidate.
- **A verified checksum is not a restorable backup.** `db:backup:verify`
  proves bytes; only a restore (`db:backup:rehearse`, or a disposable provider
  restore) proves the league comes back.
- **Never put a credential in argv, a commit, a log, an issue, a screenshot or
  chat** (`backup-db.mjs` passes libpq env fields for this reason).
