# Results, OpenDota imports and automatic sync

How a played Dota game becomes a GGD2L result: the OpenDota client, the one
import funnel every path uses, the Valve league feed, the scheduled worker that
imports results unattended, and the player data (medals, private-data flag,
report cards) that rides the same API. Main files: `src/lib/dota.ts`,
`match-import.ts`, `import-candidates.ts`, `result-sync-service.ts` (pure timing
in `result-sync.ts`), `automation-service.ts`, `automation-gate.ts`,
`player-data-refresh.ts`, `benchmarks.ts`.

## OpenDota client (`src/lib/dota.ts`)

- **What lives there.** SteamID64 to `account_id` conversion, match, league and
  account id/URL parsing (`parseMatchId`, `parseLeagueId`, `parseAccountId`)
  and every OpenDota fetch. `OPENDOTA_API_KEY` is optional; it only raises the
  rate limit.
- **Never fetch hero names.** `heroById` (`src/lib/heroes.ts`) is a static
  table, so no hero label depends on OpenDota being up.
- **Keep "unreachable" distinct from "nothing there".** `fetchRankTier` and
  `fetchPubStats` return `ok: false` on a 429, 5xx or timeout;
  `fetchRecentMatchIds` and `fetchLeagueMatchIds` return `null`, never `[]`.
  Never overwrite stored data with a failed fetch, and never report a scan that
  couldn't reach OpenDota as "found nothing" (admin, captain and automatic
  paths all say it "proves nothing"). `fetchPlayerRankTier` collapses both into
  `null`: use it only where a null can't overwrite a medal (the signup fetch).
  Unattended callers also pass a deadline (`OpenDotaFetchOptions`).
- **Write `BigInt("…")`, never a `123n` literal.** `tsconfig` targets ES2017.

## The import funnel (`src/lib/match-import.ts`)

Captain report, admin import, league feed and roster scan all end in
`importGameForMatch`. Tests: `test/integration/match-import.itest.ts`,
`import-lineups.itest.ts`, `result-sync.itest.ts`.

- **Classify strictly by roster.** Pure `classifyGame` accepts a game only when
  at least `minPerSide` known accounts per team (3, capped by team size) sit on
  opposite sides, and fails closed if one account is linked on both rosters.
  `gatherTeamAccounts` counts standins booked on the match for their team; a
  released but registered player is mapped for attribution only (`teamId` null).
- **A COMPLETED match takes no more games, on any path.** A late import must not
  rewrite a decided series or an admin's manual/forfeit ruling; amending is
  admin work (Reopen a manual score, remove an imported game). A series never
  exceeds `bestOf` games. Imports also refuse archived seasons and fixtures
  whose results are locked in the current phase (`matchResultsOpen`).
- **Re-check everything in the write.** No transaction spans OpenDota IO. After
  the fetch, one Serializable transaction re-asserts not-COMPLETED, `bestOf`,
  the lifecycle, the fixture window, captaincy and (for scans) admin
  exclusions, and re-classifies against current rosters. Failures throw `ImportRaceError`,
  caught outside.
- **Let the unique indexes dedupe.** `Game.dotaMatchId @unique` is the real
  arbiter against a concurrent import. `DotaMatchClaim` (one row per Dota id,
  `LEAGUE` or `SCRIM`) stops one game counting in both the league and scrims,
  whose results stay in a separate table so scrim stats never leak into league
  roll-ups.
- **The Match row is a projection of its games.** The Game, the derived score
  (`deriveSeriesProjection`) and the result cursor commit together, so a crash
  can't leave a Game on a 0-0 SCHEDULED match that every scanner then skips.
  `recomputeSeries` is a retried compare-and-swap: a stale caller must never
  revert a completed 2-0 to a live 1-0 (seam
  `match-import.recomputeSeries.beforeSwap`).
- **Run external effects after commit.** A decided series announces once
  (`announceSeriesResultOnce`, see `discord.md`), advances the bracket
  (`advancePlayoffBracket`) and closes out week honors, whichever path finished
  it. A failed effect never undoes the result; the worker re-runs bracket
  reconciliation and retries failed announcement markers.
- **A game belongs to the meeting it is closest to.** Teams meet more than once
  and an unimported fixture stays a candidate forever, so a game must be inside
  the fixture's window (`isWithinLeagueResultWindow`) and strictly closer to it
  than to any other eligible meeting of the same teams, scrims included
  (`claimsGame`; ties refuse).
- **Import only the real series.** `pickSeriesGames` splits candidates into
  sessions on `SERIES_SESSION_GAP_MS` (longer for a two-lobby Bo2), keeps the
  largest session and stops at the clinch, so a bonus game after a 2-0 never
  records 2-1. The roster scan (`autoDetectGamesForMatch`, capped by
  `SCAN_BUDGET_MS`) and the league feed both use it.

## Manual import controls

- **One control, two callers.** `MatchImportControls`
  (`src/components/match-import-controls.tsx`) takes its server actions as
  props: the admin's `importGameAction`/`autoDetectAction`
  (`src/app/actions/admin-schedule-results.ts`, via `admin-match-tools.tsx`) or
  the captains' `captainImportGame`/`captainAutoDetect`
  (`src/app/actions/match-report.ts`, via `src/app/matches/[id]/report-result.tsx`).
  It is one `<ActionForm>` with a `detect`/`import` intent, so results toast.
  `admin-copy-guard.test.ts` and `match-import-controls.test.ts` pin the button
  names ("Auto-fetch games", "Add game") and the wiring.
- **Captains import; only admins type a score.** Guards live in
  `src/lib/match-report-service.ts` (`test/integration/match-report.itest.ts`):
  active season, results open for the phase, match not COMPLETED, viewer
  captains a side. The write re-asserts captaincy (`expectedCaptainId`), a
  pasted id is held to the fixture window (`enforceFixtureWindow`), and
  Auto-fetch takes a per-captain, per-match cooldown (`claimProviderCooldown`).
  Manual score entry (`recordResult`) stays admin-only.
- **Admin controls are the override.** Admin Add game skips the fixture-window
  check, and admin Auto-fetch passes `ignoreSkips`, so a game removed by
  mistake is one click from coming back. Automatic sync, the automatic league
  feed and a captain's Auto-fetch honor removals (`respectImportSkips`). Two
  more paths do NOT, and no test pins either: the admin's manual "Sync league
  games" (`respectImportSkips: !!opts.auto`) re-imports every removed game still
  in the feed, and a captain's pasted id (`reportImportGame`) can bring one back.
- **Bust the caches after an import.** Both action files call `refreshGames()`,
  which expires `"games"` and `AUTOMATION_GATE_TAG` and revalidates the layout.

## Valve league feed (`syncLeagueGames`)

- **What it is.** A season with `Season.dotaLeagueId` (admin `setLeagueId` in
  `admin-season.ts`) reads `/leagues/{id}/matchIds`, so no public match data is
  needed. The league is registered at dota2.com/league; games are tagged by
  hosting private lobbies with the id. "Sync league games" runs
  `syncLeagueAction` (`admin-schedule-results.ts`). A `null` id list is an
  unreachable feed: say so, not "imported 0 of 0".
- **Buffer per fixture, then import in play order.** The feed lists newest
  first. Classify against every fixture the rosters fit, attribute by closest
  kickoff, run `pickSeriesGames`, then import oldest first; a failed earlier
  game stops later ones leapfrogging it. COMPLETED fixtures and full `bestOf`
  fixtures never take a game; a scrim that used the ticket is left to the scrim
  importer.
- **Bound automatic runs and remember their work.** `auto: true` fetches at most
  `AUTO_SYNC.LEAGUE_MAX_FETCHES_PER_RUN` unknown ids per run (a typo'd league
  id can list thousands). Fetched payloads persist as `ImportCandidate` rows
  (bounded evidence, `IMPORT_CANDIDATE_TTL_MS`, revision-fenced writes) and are
  reclassified every pass, because a roster, standin or fixture repair can make
  a skipped game importable. Provider failures retry, then become
  `NEEDS_REVIEW` after `IMPORT_CANDIDATE_MAX_ATTEMPTS` for an admin to retry or
  ignore with a reason (`src/app/actions/import-progress.ts`). A retryable
  failure never becomes a permanent exclusion. Manual sync skips the fetch cap,
  the legacy skip list and admin removals (it refetches a suppressed id).
- **Admin removals exclude a game from automatic import.** `removeGame` writes
  an `ImportSuppression` row, deletes the game and releases its
  `DotaMatchClaim` in one transaction; automatic scans re-check suppressions
  in their write, and the toast promises only "Automatic sync won't re-import
  it". Without it auto-sync re-imported a removed game within minutes. The
  manual paths that ignore it are listed under "Admin controls are the
  override" above. The legacy `importSkip:<season>` and
  `leagueSyncSkip:<season>` Settings are still read, never written; a corrupt
  legacy `importSkip` fails closed.

## Automatic result sync

- **The scheduler is the only clock.** `GET /api/cron/automation` checks
  `Authorization: Bearer <CRON_SECRET>` first, then `runAutomation`
  (`automation-service.ts`) takes the single global lease and runs
  `runResultSync` within `AUTOMATION_WORK_BUDGET_MS`. Page traffic never runs
  maintenance. The admin run-now action (`src/app/actions/automation.ts`) uses
  the same worker.
- **Keep the automation gate honest.** Before leasing, the route asks
  `getAutomationGateDecision` (cached under `AUTOMATION_GATE_TAG`) and answers
  `NOT_DUE` when nothing is due. A mutation that creates or moves due work
  (kickoff, import, queue join, reschedule) must expire that tag (`updateTag`
  in an action, `invalidateAutomationGateBestEffort()` elsewhere) or the worker
  may sleep until `AUTOMATION_GATE_HARD_HORIZON_MS`. Give a new automated step
  its own wake in the gate, and bump `AUTOMATION_GATE_VERSION` and its key when
  the snapshot shape or deadline rules change (`automation-gate-constants.ts`,
  currently 9). Version, cache key, tag and the tests that pin them move
  together. When two branches each bumped it, the merge takes a number above
  both, so neither build's cached decision is trusted.
- **Isolate steps and name failures.** Each `runResultSync` step checks its
  budget first (`canStartWork`) and fails alone, adding a stable issue or
  skipped code. Add new codes to `SAFE_WORKER_CODES` (`automation-service.ts`)
  or the run summary drops their names.
- **`/api/sync` is a read-only status snapshot.** Its GET returns
  `{watch, cursor}`; there is no POST handler (`route.test.ts` pins it). Never
  use it as a scheduler or health signal. `<ResultSyncPing>` (root layout,
  renders nothing) polls it every `WATCH_POLL_SECONDS` while `watch`, else
  `IDLE_POLL_SECONDS`, never while hidden, and calls `router.refresh()` when
  the cursor advances (pure `syncPingStep`). Its baseline is the server
  render's cursor (`initialCursor`), not the first ping, so a result landing in
  between still refreshes.
- **Bump the result cursor inside the write.** `stampResultChange(tx)`
  (`settings.ts`) sets `resultChangedAt` and a fresh `publicGameRevision`. Call
  it in the transaction of every write that changes results, games, box-score
  attribution or names shown on them; grep `stampResultChange` for callers.
- **Probe health elsewhere.** `/api/health/live`, `/api/health/ready` and
  `/api/health/automation` (worker freshness; see the README).

### Which matches get scanned

- **Only fixtures in their window.** Only REGULAR_SEASON and PLAYOFFS run. A
  match is due from `AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF` after `scheduledAt`
  until `WINDOW_HOURS` later while not COMPLETED; a LIVE series keeps scanning
  for games 2 and 3; a match with no kickoff is never auto-scanned.
- **League feed first, roster scan as fallback.** With a league id, one
  `syncLeagueGames({ auto: true })` runs per `LEAGUE_INTERVAL_SECONDS` behind
  the `leagueAutoSyncAt` claim. A fixture still missing after
  `LEAGUE_FALLBACK_MINUTES_AFTER_KICKOFF` (a LIVE series at once) falls back to
  the roster scan, for lobbies hosted with an old or wrong ticket. If the feed
  was unreachable, pending or out of time, delete the throttle claim (scoped to
  this run's exact stamp) so the next run retries.
- **One roster scan per run, claimed.** A scan costs about a dozen OpenDota
  calls. Take the stalest `Match.autoSyncedAt`, win the global
  `rosterAutoSyncAt` claim (`SCAN_GAP_SECONDS`) so concurrent workers can't fan
  out, then claim the match with an `updateMany` that re-asserts
  `status: { not: COMPLETED }`: if an admin ruling or rival import decides the
  series in between, OpenDota must not be called (seam
  `resultSync.syncDueMatches.beforeMatchClaim`).
- **Back off on empty scans, not on outages.** Each empty scan increments
  `Match.autoSyncAttempts`, doubling the interval (`autoSyncIntervalSeconds`,
  capped at `MATCH_INTERVAL_SECONDS << BACKOFF_DOUBLINGS`); any import resets
  it, so a forfeit or private-data fixture costs a handful of scans. For
  `BACKOFF_GRACE_MINUTES` after the window opens the cap is
  `BACKOFF_GRACE_DOUBLINGS`, because league nights start late. An unreachable
  scan gives its increment back, a pending one keeps its turn, and one that ran
  out of time restores its exact claim and the throttle (seam
  `resultSync.syncDueMatches.beforeDeadlineRollback`).
- **Show the backoff.** A match in backoff looks exactly like "no games yet",
  so the admin "Automatic result sync" card (`AutoSyncHealth`,
  `src/app/admin/page.tsx`) shows each in-window match's last scan, empty-scan
  count and next check (pure `autoCheckStatus`/`autoCheckCopy`/
  `nextRosterScanAt`, tested), the feed throttle, the cursor, how many feed
  games the last pass set aside (`IGNORED` candidates with a
  `NO_ELIGIBLE_FIXTURE*` reason, which only `syncLeagueGames` writes and every
  pass reconsiders) and the players with private match data. Never count the
  legacy skip Settings there: nothing writes them.
- **Inhouse resolvers run here too.** `syncInhouse` runs them behind a cheap
  lobby/queue read, so a lobby whose ten players all closed /inhouse still
  advances and records its result (see `inhouse.md`).
- **LIVE chips.** `/schedule` rows and the dashboard This-week strip pulse a
  partial score while a series is LIVE (`MatchView.live`); "Bo3 at 1-0" is a
  common, minutes-fresh state.

## Player data from OpenDota

- **Ranked medals.** `src/lib/rank.ts` decodes `rank_tier` (pure, tested) for
  `<RankBadge>` (`ui.tsx`) on players, teams and the draft room. Filled at login
  (`ensureRankTier`/`ensurePubStats` in `users.ts`, missing-only, so login
  pays for OpenDota at most once per account), on `/me` link/refresh
  (`updateDotaAccount`, `refreshMyAccounts` in
  `src/app/actions/registration.ts`), hourly, and by the admin button.
- **/me has one refresh button, and each half has its own cooldown.** "Refresh
  my Steam & Dota info" (`refreshMyAccounts`) runs the Steam half (name,
  avatar) and the OpenDota half (medal, public-data flag, scouting) in
  parallel. Each takes its own `claimProviderCooldown` claim and handles its
  own failures, and the toast says what each did, so one provider's cooldown
  or outage never blocks the other. The claim fails closed: if it can't be
  recorded, no provider call is made, so a database outage never becomes
  unthrottled calls on the shared Steam and OpenDota budget.
- **Private match data.** `User.fhUnavailable` mirrors OpenDota's
  `profile.fh_unavailable`: true means "Expose Public Match Data" is off, the
  top reason a roster scan can't see a player. Store only a definite answer
  (null = unknown). Shown on `/me`, the admin player list and the auto-sync card.
- **Re-assert the linked account in every metadata write.** Each async medal,
  flag or scouting write puts both link columns (`dotaAccountLinkSnapshot`) in
  its WHERE, so a relink mid-fetch drops the stale result. Changing the
  effective account clears the old account's metadata first; an outage on an
  unchanged account keeps the snapshot. Raced in
  `test/integration/rank-sync.itest.ts`.
- **Admin medal corrections win.** The admin "Edit medal & MMR" editor sets
  `User.rankTierManual`; every automatic medal write has
  `rankTierManual: false` in its WHERE.

## Player data refreshes itself (`src/lib/player-data-refresh.ts`)

Tested in `test/integration/player-data-refresh.itest.ts`.

- **Run last, and only when idle.** Only the automation worker passes
  `runResultSync({ refreshPlayerData: true })`, and the refresh skips whenever
  the league, inhouse or draft step is watching: it shares OpenDota's budget
  with result sync. It claims `playerDataRefreshAt` (`claimThrottle`) only
  after those checks and with time left, so a busy run leaves the claim.
- **Small and stalest first.** Steam names and avatars (batched, only changed
  rows written, no-op without `STEAM_API_KEY`), then
  `PLAYER_DATA_REFRESH_ACCOUNTS` accounts from pure `pickStaleAccounts`
  (`pub-stats.ts`: this season's signups, never-fetched, then oldest; fresh
  skipped via `pubStatsFresh`; last refused account last), then
  `PLAYER_DATA_REFRESH_GAMES` games through `enrichStoredGames`.
- **Back off at the first refusal.** No retry: the first refused call stops the
  pass, records the account in `playerDataRefreshFailedUser` and writes a
  future time into `playerDataRefreshAt`, adding
  `PLAYER_DATA_REFRESH_BACKOFF_MS`. A refusal is normal, not a degraded run;
  only an exception reports `PLAYER_DATA_REFRESH_FAILED`.
- **Hands off during a live or paused auction** (`profileSyncAllowed`): the
  draft room re-reads medals and names every poll. The admin button is hidden
  and refuses then too.
- **One manual button.** "Refresh player data now" (`refreshPlayerData` in
  `admin-captains-draft.ts`, Captains & draft card) refreshes Steam names,
  every active signup's medal, the stalest few scouting snapshots and a few
  games, stopping early if the first batch is all unreachable. Its toast names
  signups whose newly learned medal is above `HARD_MMR_CEILING` and removes
  nobody. The hourly pass toasts nobody; admins see that case in Needs review's
  "MMR ≠ medal" flag. "Sync league games" and the history backfills stay
  separate buttons.

## Hero report cards

- **Stored fields.** Each `Game.players` line carries `xpm`, `denies`, `level`,
  `heroDamage`, `towerDamage`, `heroHealing` and `benchmarks` (per-metric
  `{raw, pct}` percentiles against the world on that hero, from the plain
  `/matches/{id}` payload, no replay parse). `sanitizeBenchmarks` keeps only
  finite percentiles clamped to 0..1 and stores `null` when none remain. The
  `"benchmarks":` key is the "already enriched" marker; legacy lines lack the
  fields and every surface degrades.
- **Pure grading.** `src/lib/benchmarks.ts` (tested): `BENCH_METRICS`,
  `gradeFor` (S/A/B/C/D), `gameReportCard`, `careerReportCard` (averages plus
  strength/work-on callouts behind an observation floor), `percentLabel`.
- **Surfaces.** Grade chips under each box-score line
  (`src/app/matches/[id]/box-score.tsx`), the Report card on `/players/[id]`,
  the "Best report card" board on `/leaders`.
- **Backfill never touches attribution.** `enrichStoredGames` re-fetches
  unmarked games by `dotaMatchId` in bounded batches (oldest `fetchedAt` first)
  and merges only the new fields, never `userId`, `teamId` or results. The
  write is a compare-and-swap on the exact stored JSON, so a newer identity
  repair wins. A refused game goes to the back of the queue; a 404 game is
  marked done (`benchmarks: null`) so it isn't refetched every hour. No
  separate button: the hourly pass and the manual refresh each do a few.

## Player questionnaire

- **Fields.** `Registration.roles` (comma-separated keys, `src/lib/roles.ts`),
  `favoriteHeroes`, and one "About you (shown to captains)" box, captured on
  `/me` and shown in the pool and the draft room (`getDraftState` carries them
  for the nominated player).
- **Never drop half an old answer.** New text goes to `captainNote` and clears
  `statement`; an unchanged submit leaves an old two-part row alone; every
  surface shows old rows joined via `aboutText` (`src/lib/about-you.ts`).
