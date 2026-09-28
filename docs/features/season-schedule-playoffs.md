# Seasons, schedule, standings and playoffs

How a GGD2L season changes phase, gets fixtures and kickoff times, reschedules,
ranks teams, settles ties, runs its bracket and becomes history. Main files:
`src/lib/season-phase-policy.ts`, `schedule.ts`, `standings.ts`,
`playoff-field.ts`, `tiebreaker-service.ts`, `scenarios.ts` + `stakes.ts`,
`playoff-service.ts`, `reschedule-service.ts`; admin actions in
`src/app/actions/admin-season.ts`, `admin-schedule-results.ts`, `admin-roster.ts`.

## Season phases

- **One pure policy decides every phase button.** `seasonPhasePolicy` serves the
  admin UI and `setSeasonPhase`, so no button offers a move the action refuses.
  Buttons make only non-destructive forward moves and recoveries the data
  proves. Commands own the transitions they change rows for: `startDraft` /
  `abortDraft`, Start playoffs / Return to regular season, and crowning (the
  only way to COMPLETE). A crowned season can't move backward by button.
- **`setSeasonPhase` re-judges at the write.** Inside a Serializable transaction
  it re-reads, re-runs the policy and flips with an `updateMany` re-asserting
  `isActive` and the judged phase (zero count: "changed under you"). Seam
  `admin.setSeasonPhase.beforeWrite`. Rivals: `startDraft` and `undoLastSale`'s
  season read.
- **Never re-open DRAFT over results.** Moving to DRAFT is refused while any
  series is COMPLETED or any Game exists, whatever the Draft row says (missing,
  or NOT_STARTED after an abort). DRAFT with results has no exit: `abortDraft`
  refuses over results and nothing leaves DRAFT mid-auction. Only a live or
  paused auction stranded outside DRAFT may move back. `startDraft` has the same
  check (`draft.md`).
- **The Regular season needs fixtures.** DRAFT to REGULAR_SEASON needs a COMPLETE
  auction and at least one regular fixture; generate the schedule in Draft.
- **Archived seasons are read-only for players and captains.**
  `match-report-service`, `reschedule-service` (propose, accept),
  `setAvailability` and `standin-service` refuse a match whose season is not
  active, and the match page hides those controls. Declining or withdrawing a
  proposal stays legal (cleanup). An import there would run `recomputeSeries`,
  the bracket and every cross-season board.

## Schedule and kickoff times

- **`generateSchedule` requires the first match night**
  (`Season.firstMatchNight`): an untimed fixture gets no check-in, reminder,
  auto-import or pick'em lock.
  Week N is `matchNightForWeek(first, N)`, on the local clock of
  `LEAGUE_CONFIG.timeZone` (datetime rule in CLAUDE.md). Wall-time
  conversion lives in `zoned-time.ts`: a skipped spring-forward time moves
  forward by the jump, a repeated fall-back time takes the earlier one.
- **Name a single fixture with `matchRoundLabel` (`schedule.ts`, tested),
  given `playoffTotalRounds` over the season's matches:** "Week 3",
  "Tiebreaker", "Semifinal", "Grand final". Playoff rows still count weeks in
  the database, so never print "Week N" or a bare "Playoffs" for one when the
  bracket can place it. "Final" means the grand final only (a finished result
  is "Final score"; a round counter says "1 of 2 series complete"). Pages,
  pick'em, the calendar, /me, profiles, reschedule refusals and Discord
  result posts all use it; `loadPlayoffRoundsBySeason` (`playoff-rounds.ts`)
  reads the depth for cross-season lists.
- **`generateSchedule` re-reads its inputs in one Serializable transaction**
  (seam `admin.generateSchedule.beforeTx`): active season, post-auction phase,
  no COMPLETED regular series AND no Game (both halves pinned in
  `admin-flow-audit.itest.ts`), no withdrawn team, 2+ teams, no confirmed-scrim
  clash. A regenerate replaces fixture ids, so it names the check-ins, picks,
  bookings and proposals it wipes, before (confirm) and after (toast, log).
- **Decide double round robin before generating.** `roundRobin(ids, doubleRound)`
  is a checkbox; the toast names the week count. Switching later is a full
  regenerate.
- **Every retime follows one contract.** Set time (`setMatchTime`), "Move a match
  night" (`setWeekNight`) and a reschedule accept each, in their transaction:
  re-assert SCHEDULED, bump `Match.scheduleRevision`, reset
  `autoSyncedAt`/`autoSyncAttempts`, invalidate result nudges, delete the match's
  check-ins, cancel open proposals (admin paths) and delete the week-reminder
  markers (`weekReminderKey(season, week)` and its `:<kickoffMs>` keys).
  Check-ins answered the old night, and the reminder quoted the old kickoff (a
  Discord edit notifies nobody), so the marker must be released to re-fire.
  After commit, report standin clashes with `clashesAfterRetime`; don't refuse.
  A no-op resubmit returns before touching anything.
- **The week mover moves the rhythm.** The week's night is its most common
  kickoff (earliest on a tie), so a rescheduled outlier is never the baseline.
  The optional cascade shifts later weeks by the local-clock delta
  (`shiftMatchNight`), and a move re-anchors `firstMatchNight` so future playoff
  rounds follow.
- **Date new postseason rounds with `upcomingMatchNight`**, which rolls a passed
  date forward in whole weeks. Otherwise a slipped season stamps a new round with
  last week's kickoff and auto-sync searches a closed window.
- **Regular matches must fit before the playoffs.** `rescheduleDeadline` (via
  `loadRescheduleDeadline`, shared by the check and the form hint) is the earliest
  postseason kickoff, else the planned playoff night while still ahead. Start
  playoffs refuses while any regular result is outstanding.

## Rescheduling

- **The flow.** `RescheduleRequest` (PENDING / ACCEPTED / DECLINED / CANCELLED),
  guards in `reschedule-service.ts` (`test/integration/reschedule.itest.ts`),
  auth, toasts and Discord posts in `src/app/actions/reschedule.ts` (mention
  targets in `discord.md`). Shown as the captains' card
  (`src/app/matches/[id]/reschedule.tsx`), a ⏳ chip on /schedule, a "Respond"
  strip in `MyNextMatch` (`src/components/home/my-next-match.tsx`), and the
  admin list with Clear (`cancelReschedule` allows admins and the proposer).
- **One open proposal per match, by Serializable.** There is no unique
  constraint: a new proposal cancels the open one in a Serializable transaction,
  or two simultaneous proposals leave a zombie to accept days later.
- **Check the calendar at propose AND accept** (a proposal can sit open): a sane
  time (under 1h past, under 180 days ahead), no fixture of either team or
  confirmed scrim within four hours (`findFixtureConflict`), and the deadline.
- **Accept retimes; decline is cleanup.** Accept needs the active season,
  `matchLogisticsOpen` and SCHEDULED, claims the request and match with guarded
  `updateMany`s, then follows the retime contract. It returns `clearedRsvps` (the
  post says why check-ins vanished) and `standinUserIds`. Decline leaves kickoff,
  check-ins and reminder marker alone (pinned in the itest).

## Calendar feed

- **`GET /api/calendar`** (`src/app/api/calendar/route.ts`, pure RFC 5545
  builder `src/lib/ics.ts`). Bare, it
  follows the active season and is a valid empty calendar between seasons, so
  subscriptions carry over. `?team=<id>` is that team's fixtures in its own
  season (unknown id: 404). It lists every fixture with a kickoff, played ones
  too; duration `bestOf × 60 + 30` minutes.
- **Never change the event UID** (`<matchId>@<host>`): calendar apps key on it.
  SEQUENCE is `scheduleRevision`, so a retime replaces the event.
- **Offer the subscription.** `<AddToCalendar>` (`calendarFeedLinks`) on
  /schedule and active-season team pages gives a download (a one-off copy that
  never updates), a webcal subscription and a Google "add by URL" link.

## Standings and tiebreakers

- **`computeStandings`** (`standings.ts`, tested) counts only COMPLETED REGULAR
  matches: win 3, draw 1, loss 0. Order: points, game difference, series wins,
  head-to-head among the still-tied (`headToHeadRanks`: mini points, mini game
  diff), team id. Run head-to-head as a second pass over each tied group, never
  in the comparator: a three-way cycle isn't pairwise-transitive. Identical
  mini-records SHARE a rank so head-to-head never invents an order; rows left to
  the id fallback get `idDecided` + `idTieGroup`. `STANDINGS_RULES` prints the
  order under every table.
- **The recorded score counts, forfeits included**, in `gameDiff` and the
  mini-diff. A forfeit can mix imported and awarded games; dropping it erased
  real games and split identical records.
- **Read seeds, the cut and tie status through `projectPlayoffField`**
  (`playoff-field.ts`): standings over all teams, withdrawn teams dropped, bracket
  sized on the eligible count (`pickBracketSize`), `resolveTiebreakers`, seeds,
  first-round pairings, `seedingDeadHeatTeamIds`. `createPlayoffBracket`, /admin
  and every public page with seeds use it.
- **Keep `clinchStatuses` points-only and conservative** (ties count against a
  clinch, for a survival). Only the scenario engine refines it.
- **One table layout**: `standings-table-server.tsx` feeds the server-rendered
  `standings-table.tsx` on home, /schedule and the archive (status line
  Qualified / Eliminated / Withdrawn / Tiebreaker pending / Tied / Settled by
  tiebreaker / "Your team", W-D-L, game difference, points, Last 5 from `sm`).
  Movement arrows (`standingsMovement`), ✓/✗ marks. Team names truncate on one
  line (full name in `title`) rather than wrap on phones.
- **Public tables show a dead heat only once it can matter**
  (`publicDeadHeatTeamIds`, `playoff-field.ts`, tested): every regular fixture
  final, or tiebreaker fixtures exist. Before that only the quiet "Tied" chip
  shows (none while nobody has played), and seeds, the cut and projected
  matchups keep the displayed order. Presentation only: admin tiebreaker
  scheduling and `createPlayoffBracket` read `seedingDeadHeatTeamIds`.
- **One "Tied" chip:** `TiedChip`, exported beside the table. /teams' cards use
  it under the table's rule: hidden while a (non-withdrawn) team's dead heat
  waits on a tiebreaker (`publicDeadHeatTeamIds`), where the table shows its
  tiebreaker badge instead.
- **Draw the cut line and the ✓/✗ marks only when the cut drops an eligible
  team** (`cutIsReal` in `standings-table-server.tsx`; a team with a pending
  tiebreaker keeps its mark). When everyone makes the bracket every row would
  read ✓. Judge it on the whole league (`totalTeams`/`eligibleTeams`), never
  on the rows a sliced table happens to show.
- **A dead heat at the cut or a seed line is played off, never guessed.**
  `createPlayoffBracket` refuses while ties are unresolved; the admin Tiebreakers
  card schedules an extra week (`src/app/actions/tiebreakers.ts` over
  `tiebreaker-service.ts`). Its matches use phase TIEBREAKER and add no
  regular-season points. New ties play capped BO1 knockouts; published TB/TBD
  fixtures keep their original rules. `tiebreakerBasis` binds the week to the
  exact results, the opening draw is saved (`tiebreakerDrawKey`) so a reset
  can't reroll a bye, and `advanceTiebreakerWeek` (idempotent, never starts an
  unrequested week) creates the next game after every result.

## Playoff scenario engine

- **Exactness only turns unknown into certain.** `scenarioReport`
  (`scenarios.ts`, property-tested against `computeStandings`) always computes
  points bounds (`magicNumber`, `eliminationLosses`, `winAndIn`/`loseAndOut`,
  rank ranges), then enumerates every remaining REGULAR outcome under a
  200,000-leaf cap. Ties count against a clinch and for a survival, so it can
  turn null into CLINCHED/ELIMINATED but never contradicts `clinchStatuses`.
  Keep `magicNumber` and `eliminationLosses` crude bounds: that is what
  "regardless of everything else" means.
- **Branch every unstarted match win / loss / DRAW, whatever its best-of**:
  `recordResult` can record a draw or a partial ruling. A LIVE series branches
  only into outcomes keeping its recorded games (`possibleSeriesOutcomes`).
- **Check `nextMatchId` before pinning "win and in" on a match**: `winAndIn` and
  `loseAndOut` are about the team's next match only (`PlayoffOutlook matchId`).
- **Enter through `seasonScenarioReport`** (`stakes.ts`): the cut comes from the
  projected field (as in `createPlayoffBracket`), and the report is memoised on
  the whole stringified input so a new field can't serve a stale report.
  Outlooks (`scenario-outlook.ts`) count scorelines, never probabilities; home
  hides them until a regular series is final (`playoffOutlookShown`).
- **Render through `src/components/playoff-outlook.tsx`** (`PlayoffOutlook`,
  `playoffStatusLine`, `playoffPathLines`) and `PlayoffStatusLine`: clinch marks,
  /schedule's Playoff tracker, "Tonight's stakes" on regular-season match pages
  (`src/app/matches/[id]/stakes-banner.tsx`), "What we need" on /teams/[id], home.
- **"Tonight's stakes" stays silent until the night decides something.**
  `StakesBanner` renders only for a REGULAR match in REGULAR_SEASON once a side
  has `paths`, a sealed `status` or an `outlook` (forecasts exist only when
  few enough results remain, `NORMAL_FORECAST_CAP`). Never fill it with an
  early-season "everyone's in the hunt" card: that is noise.

## Playoff bracket

- **`createPlayoffBracket` builds or resets in one Serializable transaction**
  (`playoff-service.ts`, seam `playoffs.create.beforeTx`). Start and Reset are
  separate controls, each carrying a claim (expected phase +
  `playoffSetupRevision`) re-checked inside. It needs every regular result and
  resolved ties, writes round 0 as `R0M{i}` (FINAL when one pair), yields
  clashing scrims, tears the old bracket down and flips to PLAYOFFS with a
  guarded `updateMany`. Slots are `R{round}M{match}`; `pickBracketSize`,
  `playoffFirstRound`, `nextRoundPairings`, `roundName` are pure in `schedule.ts`.
- **Teardown keeps what it deletes.** `removePostseason` (reset and
  `returnToRegularSeason`, the only way back once a bracket exists) writes a
  history receipt per fixture, MERGES removed game ids into
  `playoffGamesArchiveKey` (union by id: reset, re-import, reset must lose
  nothing), releases their Dota match claims, and deletes the round-built,
  announced, champion and reminder markers. Without clearing round markers a
  reset season could never advance.
- **`advancePlayoffBracket` claims each round and re-asserts its inputs.** It
  runs after every result path and in the worker. The round is claimed by
  creating `playoffRoundBuiltKey` in the same Serializable transaction as its
  fixtures, P2002 caught outside: a find-then-create reads zero rows, takes no
  lock, and two callers build the final (no champion, ever). Inside it re-checks
  the season is active in PLAYOFFS and the current round's rows still exist with
  the same winners; otherwise a stale advance after a reset built a phantom round
  that `maxRound` points at forever (pinned in `playoffs.itest.ts`).
- **Crown only a real final.** The sole latest-round row must be phase FINAL; the
  crown re-proves it (same row, completed, same winner) and claims Season
  PLAYOFFS to COMPLETE. `announceChampionOnce` posts after commit behind a
  retryable marker.

## Bracket and schedule views

- **The bracket** (`src/components/bracket.tsx`): two wings meet at a centred
  final. `mirrorLayout` (`bracket-view.ts`) puts round i's first half left and
  second half right, the halves the `R{r}M{m}` slots feed forward;
  `bracketSkeleton`, `slotIndex`, `groupPlayoffRounds` build the rounds.
  Seeds come from `seedsFromFirstRound` (frozen pairings), never live standings,
  which drift after a correction. The trophy lights only for the completed
  final's winner. On /schedule, home and /seasons/[id], always inside its own
  `overflow-x-auto` (card rule in `pages-and-ui.md`).
- **ScheduleWeeks** (`schedule-weeks.tsx`): a team dropdown ("All teams" is the
  way back); this week, weeks to come, then "Earlier weeks"
  (`orderScheduleWeeks`). The current week is `id="this-week"` (home links
  `/schedule#this-week`). Byes show per week (`byeTeamsByWeek`) even under a
  team filter, plus "Week N: bye" (`teamByeWeek`). In PLAYOFFS and COMPLETE the
  regular season folds into `ScheduleFold` (`id="fixtures"`).
- **Playoff picture** (REGULAR_SEASON): the projected first round
  (`playoffFirstRound`, hidden while ties are open) and the Playoff tracker.
- **Head-to-head grid**: `crossTable` (`cross-table.ts`) builds cells from the
  ROW team's view over REGULAR matches (a list per pair for double round
  robins); `SeasonGrid` scrolls inside its own box.
- **Show times in the viewer's zone.** `<LocalTime ts initial>` uses the server
  string as the hydration snapshot and the browser zone after, both via
  `formatMatchTime`. Server `toLocaleString` alone is wrong in production (UTC
  host). `<Countdown>` (`countdownLabel`) runs to "happening now".

## Forfeits and team withdrawal

- **`Match.forfeit` marks a ruled score; the score still counts.** Set by
  `recordResult`'s checkbox (a ruling may be partial, `seriesScoreError`; an
  unticked score must be a finished series, `playedSeriesFinalError`). Cleared
  by `reopenMatch` and by re-saving unticked, so a ruling never outlives a
  reopen. Badged on /schedule, the match page and admin; Discord says "by
  forfeit". `powerRankings` skips forfeit series (mixed imported and awarded
  games). `MatchLike.forfeit` / `RankableMatch.forfeit` stay optional.
- **`withdrawTeam` is the mid-season dropout; `reinstateTeam` undoes the flag.**
  REGULAR_SEASON only (`teamWithdrawalLockedReason`: before it, `removeCaptain`;
  in playoffs, rule the match). After claiming the Season row it flags
  `Team.withdrawn`, forfeits every unplayed REGULAR fixture 0-N, cancels open
  proposals and scrims, posts one withdrawal message instead of per-series
  results, and stands standins down. Each forfeit is undone with "Reopen for
  import".
- **The flag, not the table, removes a team from seeding.** A team that banked
  points can out-rank the cut and its results are real, so the table keeps it
  ("Withdrawn") while `projectPlayoffField` drops it.
- **A real result landing mid-click wins.** Each forfeit write re-asserts
  `status: { not: COMPLETED }`. Seam `admin.withdrawTeam.beforeTx`; the test in
  `team-withdraw.itest.ts` must be RACED (a staged completed match is filtered by
  the read, so it passes against a blind write).

## Season history

- **`/seasons/[id]` is the page for a finished season**: champion, final
  standings, playoff rounds, weekly results, rosters, and once archived or
  COMPLETE the streamed `<SeasonAwards>`. `/seasons` lists every season newest
  first. Archived `/teams/[id]` pages work because they query by id.
- **Keep `/recap` redirecting**: a route handler (`src/app/recap/route.ts`, pure
  `recapDestination`) so it is a real 307 that Discord unfurls follow.
  `?season=<id>` goes to that season's page (Leaders while running; a repeated
  key is a 404); bare goes to the COMPLETE season, Leaders mid-season, else the
  latest archive. Old champion posts still link it.
- **Season-scoped pages share `resolveSeasonScope`** (`season-scope.ts`):
  Leaders, Hero meta, Pick'em and Fantasy take `?season=` (unknown is a 404,
  never a fallback), else the active season, else the latest one. The
  `<SeasonSwitcher>` (`season-choices.ts`) shows only when 2+ seasons have that
  page's data; Records uses it with "All seasons" as the bare page.
- **`deleteSeason` re-asserts archived-ness at the write.** It clears the
  season's Setting markers and Dota match claims, deletes matches first (Match to
  Team is RESTRICT), then `deleteMany`s the season on `isActive: false` and the
  confirmed `updatedAt`, throwing on zero so the match deletes roll back. A
  reactivation can land in between, and there is no undo. Seam
  `admin.deleteSeason.beforeTx`, tested in `season-delete.itest.ts`; production
  also needs a backup receipt (`admin-and-operations.md`).
- **"Season history" shows only once an archived season exists** (`hasHistory`,
  `site-nav.ts`).

## Rules recorded here that belong elsewhere

- **The /me Dota link accepts only the signed-in Steam account's id**
  (`updateDotaAccount`): a pasted profile proves no ownership. The derived id is
  stored as NULL; only an unchanged grandfathered override survives. The two
  stored columns are each unique, but that can't stop A.v2 = B.legacy, so an
  override copy checks `dotaAccountClaimWhere` across both and Steam; P2002 reads
  "already linked elsewhere".
- **Admin signup edits.** "Edit medal & MMR" (`setPlayerRank`) shows for every
  signup, standins included, until COMPLETE. A PLAYER's MMR locks only while the
  auction is live or paused; a standin's never does. `withdrawSignup` has no type
  gate, so the admin signups card lists standins with a remove form.
- **Leader boards** (`leader-board.tsx`): the server computes values and ranks;
  the client only expands the top-5 preview, and pins the viewer's row with its
  real rank when outside it.
