# CLAUDE.md — working notes for LD2L

A Learn Dota 2 League site. Read the README for the product overview. This file
is orientation for future work in the codebase.

## Mental model

Everything hangs off a **Season** and its `status` (the state machine):
`SIGNUPS → DRAFT → REGULAR_SEASON → PLAYOFFS → COMPLETE`. The active season is
`Season` where `isActive = true` (see `getActiveSeason`). The UI (nav + dashboard)
renders per-phase so unused features stay hidden.

## Where things live

- **Pure, unit-tested logic** (no DB): `src/lib/draft.ts`, `standings.ts`,
  `schedule.ts`, `capacity.ts`. Prefer adding logic here + a `*.test.ts` beside it.
- **Draft engine (DB, transactional)**: `src/lib/draft-service.ts` —
  `nominatePlayer`, `placeBid`, `resolveExpiredNomination`, `getDraftState`.
  The auction clock is server-authoritative; expired nominations resolve lazily
  on the next poll/action (no cron/websocket).
- **Mutations**: server actions in `src/app/actions/*` (forms) and JSON route
  handlers in `src/app/api/draft/*` (the live draft).
- **Auth**: `src/lib/auth.ts` (jose-signed cookie session), `steam.ts` (OpenID
  2.0), `users.ts` (upsert + `resolveRole`). Dev/mock login: `/api/auth/dev`
  (gated by `ALLOW_DEV_LOGIN`). Admin: if `ADMIN_STEAM_IDS` is set it's
  authoritative (exactly those SteamID64s are admin; others demoted on login);
  otherwise the first-ever user bootstraps as admin. `npm run set-admins`
  reconciles existing accounts to the allowlist in one shot. Steam name/avatar
  come from `fetchSteamProfile`/`fetchSteamProfiles` (GetPlayerSummaries, needs
  `STEAM_API_KEY`) — set on login, bulk-refreshed via admin `syncSteamProfiles`,
  and per-user via profile `refreshSteamProfile`. `<Avatar>` falls back to
  initials when `avatar` is null.
- **UI kit**: `src/components/ui.tsx` (server-safe presentational components).
  `site-header.tsx` and `draft-room.tsx` are `"use client"`.

## Concurrency: the two rules (2026-07 repo-wide sweep — read before writing a mutation)

Production is **Postgres** (`vercel.json` runs `switch-db-provider.mjs postgresql`);
local dev, integration tests and e2e are **SQLite**, which serializes writers and
therefore HIDES every race below. A 50-agent sweep plus mutation testing found
this class in every subsystem. Two rules, both non-negotiable:

1. **A read-time precondition is not a guard — re-assert it in the WHERE of the
   write.** Postgres READ COMMITTED re-snapshots per statement, so anything
   checked before a write can be false by the time the write lands. Turn
   `update({ where: { id } })` into `updateMany({ where: { id, ...what you
   checked } })` and handle `count === 0`. Where the precondition lives in
   another table (a write-skew pair), re-read it INSIDE a `Serializable`
   transaction — SSI only spots the cycle when BOTH sides have the other's
   table in their read set, so one-sided fixes do nothing.
2. **Past the first write, failure must THROW, never return.** A resolved
   Prisma interactive-transaction callback COMMITS. Every `return { ok: false }`
   after a write persists the half-done state it was trying to prevent. Throw a
   typed error and catch it OUTSIDE the callback (catching inside re-resolves
   it, and on Postgres a query error poisons the transaction anyway).

Worked examples, each with the damage it caused: `applyPick` (frozen draft),
`undoLastSale` (live lot + nomination clock at once), `advancePlayoffBracket`
(round built twice ⇒ **no champion, ever**), `recomputeSeries` (stale caller
reverts a completed series), `recordResult` (manual score over an auto-import),
`assignStandinGuarded` (double-covered seat), `deleteSeason` / `generateSchedule`
(destructive work past a stale safety check).

**Testing them: a race test must be RACED, not staged.** Staging the conflicting
row before the call is caught by the function's own read-time check, so the test
passes against the broken code — this produced four false-green tests here.
Use `Promise.all` over competing service calls, loop it, and assert the
invariant. `npm run test:pg` (`PG_TEST_URL=…`) is the only thing that runs them
for real.

**The mutation guard is CI's ratchet over all of this**
(`scripts/mutation-guard.mjs`, baseline in `test/mutation-baseline.json`, run by
CI's own 4-shard `mutation guard` matrix job). It deletes each guard the baseline records
as protected and requires the suite to fail. It gates on two things: a
protected claim that stops being caught (its test regressed), and a protected
claim that has DISAPPEARED (the guard itself was removed or weakened). Claim ids
are anchored to the ENCLOSING FUNCTION — an earlier file-wide-ordinal scheme let
a deleted guard silently re-bind to the next claim down, so the ratchet reported
all-clear on a sabotage; don't reintroduce positional ids.

**The ratchet only models ONE guard shape.** `scripts/mutation-guard.mjs` line 3
says it: a claim is an `updateMany({ where: … })` whose WHERE re-asserts a
read-time precondition. Guards written as an early `return { error }` or as a
count-check-then-`throw` inside a transaction are INVISIBLE to it — running
`--discover` after adding one produces a byte-identical baseline (verified
2026-07-29 after adding `removeCaptain`'s results guard, the
`signFreeAgent`/`releasePlayer` missing-draft-row gate, and
`assignStandinGuarded`'s empty-seat budget). Those are covered by hand-written
integration tests instead, and the honest way to check such a test is to
sabotage the guard and confirm the test goes red — the ratchet will not do it
for you. Don't read "all gradeable claims protected" as "every guard in the repo is gated".

Currently **every gradeable claim is protected** (the committed
`test/mutation-baseline.json` is authoritative for the counts — 62 of 70 (65
gradeable; the 3 unprotected are the pubStats `dotaAccountId` claims) as of
2026-08-02, and these numbers go stale here at every `--discover`) — every
gradeable non-pubStats claim fails the suite when its predicate is deleted. The
remainder are EQUIVALENT MUTANTS: predicates that can be deleted without
changing the end state, so no test can ever kill them. They are listed in the
guard and excluded from the score rather than left looking like gaps — two
archive-then-set pairs, a `{ gt: 0 }` guarding a write of 0, `applyPick`'s
advance claim (unfalsifiable behind the turn claim's row lock; see below), and
`placeInhouseBet`'s betSettlement flip (PENDING over PENDING). Each
carries its REASON in `EQUIVALENT`, because "equivalent" is also exactly what an
untested gap looks like from here. A NEW claim is still reported and never
gating — assume a guard is unprotected until the baseline says otherwise. To
raise the ratchet: write a raced test, then `npm run test:mutation:discover` and
commit the new baseline.

**Running any of this locally** (the guard and the pg suite need Postgres, and
switching the Prisma provider is a footgun if you forget to switch back):

    npm run pg:up            # create the throwaway DB, point Prisma at it, push
    export PG_TEST_URL="postgresql://$USER@localhost:5432/ld2l_pgtest"
    npm run test:pg                          # the suite on the prod engine
    npm run test:mutation                    # verify the whole baseline
    npm run test:mutation -- --shard 2/4     # one CI shard (5-7 min on CI)
    npm run test:mutation -- --discover --only acceptMatch   # probe one claim
    npm run pg:down          # BACK TO SQLITE + drop the DB — do not skip this

`pg:down` is the step that matters: without it `prisma/schema.prisma` stays on
the postgresql provider, the SQLite suites break, and a `git add -A` commits the
switched provider. `--discover --only` deliberately refuses to write the
baseline (a partial sweep would drop the ratchet for every claim it skipped);
only a full `--discover` may.

A full sweep is ~8 min of suite time (a caught mutant `--bail=1`s out
in seconds, so the cost is dominated by the survivors) but ~25 min wall clock,
because the guard proves the suite green ONCE before measuring anything and each
mutant is a fresh `vitest run`. `npm run test:mutation` (verify the baseline) is the
longer one; shard it.

**How the last four were closed** (2026-07-28). This section used to list them
as deliberate stops, each with a reason it "couldn't" be tested. Three of those
reasons were wrong in the same way — **"something upstream serializes this" only
covers rivals from the SAME path**, and every one of these claims had a rival
from a different path. Keep that in mind before writing another such excuse.

* `result-sync-service::dueMinutes` — the excuse was the global
  `rosterAutoSyncAt` throttle. It does serialize runs, which is why the `OR`
  half is genuinely belt-and-braces (nothing else writes `autoSyncedAt`, so no
  test can reach it — and it need not, since the ratchet deletes both halves at
  once). But `status: { not: COMPLETED }` has rivals the throttle has no say
  over: THREE round trips separate the `due` read from the write, and an admin
  forfeit ruling, a captain's manual import or the league feed all land in that
  gap. Blind, the run then roster-scans a DECIDED series —
  `autoDetectGamesForMatch` has no completed check of its own (that is why
  `syncLeagueGames` grew one) — and imports a late game over an admin's ruling.
  Seam `resultSync.syncDueMatches.beforeMatchClaim`; the decisive assertion is
  that OpenDota was never called at all.
* `inhouse-board-service::exists` + `::swapState` — the excuse was "belt-and-
  braces behind explicit checks in `claimBoardRow`", which had it backwards: the
  checks are READ-time and both CASes span a Discord round trip, so the checks
  are the thing that goes stale and the CAS is the only write-time re-assertion.
  What hid `swapState` for so long is subtler and worth remembering: the
  existing "does not resurrect a board removed while an edit was in flight" test
  removes the board with `setSetting(key, "")`, which **DELETES the row**
  (settings.ts) — and an `updateMany` cannot resurrect a row that isn't there,
  so a plain Remove is the one rival the blind write survives. Remove AND
  re-post is the one it doesn't: the row then holds a DIFFERENT board, and the
  blind write points it at the message Discord has already deleted while the
  freshly-posted one is left pinned with nothing tracking it. For the takeover
  CAS the rival is a second admin's post COMPLETING in the gap (seam
  `inhouseBoard.claimBoardRow.beforeTakeover`) — blind, both post. Both tests
  assert the POST COUNT, because an orphan is made of exactly one extra post.
* `applyPick::status#1` — this one was genuinely unkillable, and is now listed
  as an EQUIVALENT MUTANT instead of a gap. The turn claim a few statements
  earlier UPDATEs the same lobby row inside the same transaction, so Postgres
  holds that row's lock until commit: the admin cancel the old comment
  described as "landing mid-pick" cannot land at all — it blocks, then
  re-evaluates its own guard against the committed result. `advanced.count === 0`
  is therefore unreachable. That is an ARGUMENT, not a fact, so it is pinned:
  "the DRAFTING re-assert cannot be falsified" (inhouse.itest.ts) holds the seam
  open and shows a second connection REFUSED the row. Two details make that test
  worth copying for any future equivalence claim: `FOR UPDATE NOWAIT` turns
  "would block" into an instant `55P03` — the ordinary rival UPDATE that
  race-hook.ts warns about would HANG the suite instead of failing it — and a
  POSITIVE CONTROL runs the same statement outside the seam first, because
  otherwise a typo'd table name throws inside the seam and is read as proof of a
  lock, passing while measuring nothing. If it goes red, the equivalence has
  expired and the claim is a real gap again.

**How the last five were closed** (2026-07-27) — the two patterns are worth
copying:

* **Delete the redundant read-time check so the claim IS the enforcement
  point.** `saveRegistration` refused a REMOVED signup twice: an `if` on a row
  read at the top of the request, and the `status: { not: REMOVED }` on the
  update claim. The `if` was strictly weaker (the upsert under it still wrote
  ACTIVE unconditionally) AND it made the claim untestable — every test stopped
  at the `if` and passed just as happily with the WHERE deleted. One
  enforcement point, and the test is deterministic, needs no seam, and runs on
  SQLite. **`reopenMatch` is the same shape** and was the last blind write of
  this class in the repo: it read `_count.games`, refused if any, then wrote
  `update({ where: { id } })` — while auto-sync runs from any page view and
  reopen is pressed on exactly the matches it is scanning. An import landing in
  that gap left the match SCHEDULED at 0-0 WITH a Game row, and nothing
  repaired it: `importGameForMatch` dedupes on the unique `dotaMatchId` so the
  game never re-imports, `recomputeSeries` never runs again, and the result is
  gone from the standings with no error anywhere. The games check now lives
  only in the WHERE (`games: { none: {} }`, a relation filter — the
  `acceptMatch` pattern), and a `count === 0` re-read says WHICH predicate
  failed, because "nothing happened" is the one answer an admin cannot act on.
* **Seam the rest.** `recomputeSeries` (rival imports the game that clinches
  the series between this caller's read and its CAS — the stale caller must not
  revert a COMPLETED 2-0 to a LIVE 1-0), `startCaptainVote` (a decline CANCELS
  the check between the pending count and the flip — a blind flip resurrects a
  dead lobby, with ten players in a live lobby AND the queue at once), and
  `leaveLeague` (an admin REMOVAL lands between the gate and the write —
  overwriting it with WITHDRAWN hands the player back the one state they can't
  clear themselves). Note where each hook goes: `leaveLeague`'s fires BEFORE
  its `$transaction`, because under Serializable a rival that writes the same
  row after the snapshot makes both the guarded and the blind version fail with
  P2034 — the predicate only becomes observable if the rival commits before the
  snapshot is taken. That also makes it the one seam test that runs on SQLite.

`leaveLeague` gained a `count === 0 → throw` on that claim at the same time:
without it a player whose signup was removed mid-withdrawal was told
"Withdrawn from this season" while nothing had moved.

**When racing isn't enough, use the SEAM.** Several claims need one exact
interleaving — the caller READS, a rival COMMITS, the caller WRITES — and
`Promise.all` cannot steer that; for those, racing produced the losing ordering
so rarely that the tests passed against broken code. `src/lib/race-hook.ts` is a
test-only fault injector: the service `await raceHook("label")`s between the
read and the guarded write, and a test installs a hook that commits the rival
right there. One null check in production, and `setRaceHook` THROWS outside
NODE_ENV=test so it can't be armed by accident (all three of its guarantees —
the production refusal, the no-hook no-op, and `onceAt` firing once for exactly
its label — are pinned in `src/lib/race-hook.test.ts`; a seam that silently
stopped firing would quietly hollow out every test built on it).
Two rules for writing one: (1) the rival runs on a DIFFERENT connection, so it
must not touch a row the open transaction has already written — it will block on
that lock while the transaction waits on the hook, which is a hang, not a
failure; (2) those tests are Postgres-only (`describe.skipIf(!ON_POSTGRES)`),
because SQLite pins one connection and ANY rival inside an open transaction
hangs. Assert a `fired` flag too — a seam whose label drifts otherwise degrades
into a silently vacuous test. Deliberately removing a guard also needs a re-discover, which
is the point at which someone has to justify it.

## Conventions / gotchas

- **Node ≥ 20.18, Prisma 5.** Prisma 6/7 requires Node ≥ 20.19; this machine's
  default Node is 20.18, so we pin Prisma 5. Node 22 is installed via nvm if a
  future upgrade is wanted.
- **SQLite has no enums** — statuses are strings; the source of truth for allowed
  values is `src/lib/constants.ts`.
- **Vitest config is `vitest.config.mts`** (`.mts`, not `.ts`) — the project is
  CommonJS and Vitest's config loader needs ESM.
- After a mutation, server actions call `revalidatePath("/", "layout")`.
- **MMR cap**: `Season.maxMmr` (0 = none) is a SOFT limit — a review threshold,
  NOT a block. Players above it still join the pool; only `HARD_MMR_CEILING`
  turns anyone away (`registrationGate`, `registration.ts`, says so in two
  places). Admins set it in the create-season form or via `setMaxMmr`.
  This entry used to claim `saveRegistration` rejects `mmr > maxMmr`, which is
  the opposite of the code — and it was believed: a 2026-07-29 pass "corrected"
  the /admin hint to say over-limit signups are refused, and it took a reader
  going to the source to catch it. Nothing enforces the soft limit; reviewing
  those players is a human step with no tool behind it.
- **`Season.minTeams` is a FLOOR, and signups are UNCAPPED.** Nothing anywhere
  refuses the 31st signup on a 6-team season: `registrationGate` checks the MMR
  ceiling and the SIGNUPS phase and nothing else, and `startDraft` forms one
  team per CAPTAIN (`teams.length >= 2`, pool > 0), so extra players become
  extra teams. `capacityInfo`'s `minPlayers`/`needed`/`canDraft` are *display*
  values — never a gate; don't turn one into one. The player count is squared
  against the roster size at DRAFT START, by choosing how many captains to
  designate, and `startDraft` accepts both sides of that (a short pool takes
  standins; a long one silently leaves players undrafted as free agents). The
  Start-draft confirm states which of the three it is before the click, and the
  SIGNUPS dashboard card counts UP past the minimum rather than showing
  "31 / 30 players to start" over a pegged bar — a fraction above 1 is the
  universal shape of "sold out", rendered to exactly the person deciding
  whether to sign up. `capacityInfo` carries `extra`/`leftover`/`toNextTeam`
  for that; keep them uncapped. `scripts/seed-signups-fixture.ts` +
  `.claude/launch.json`'s `signups-fixture` entry seed and serve this state
  (seed-fixture.ts has no SIGNUPS mode).
- **Feedback**: risky server actions return `ActionResult`
  (`src/lib/action-result.ts`) instead of throwing; the UI wraps them in
  `<ActionForm>` (`src/components/action-form.tsx`), which toasts the result via
  the global `<Toaster>`. Use `<SubmitButton confirm="…">` for destructive
  actions. Global `error.tsx` / `not-found.tsx` / `loading.tsx` exist.
  The live rooms (draft/inhouse) toast `act()` failures via `pushToast` too —
  never reintroduce inline top-of-room error banners there: race rejections
  ("Another bid just landed") arrive while the captain is scrolled deep in the
  pool where a banner is invisible, and the old banner persisted stale.
- Run `npx tsc --noEmit` for a fast type check; `npm test` for unit;
  `npm run test:e2e` for Playwright — fully isolated: it schema-pushes and
  reseeds a DEDICATED `prisma/e2e.db` and serves it on port 3210 (never
  dev.db/:3000, safe to run any time). Caveat: Next 16's project-dir lock
  means it can't start while another `next dev` runs from this repo.
- `npm run test:e2e:mid` is the MID-SEASON browser suite
  (`playwright.midseason.config.ts`, specs in `e2e-mid/`): its own
  `prisma/e2e-fixture.db` (name satisfies seed-fixture's guard) seeded to
  `FIXTURE_MODE=regular` + a staged LIVE match (`e2e-mid/stage.ts`), port
  3212. Covers dashboard/standings sorting, schedule (collapse/filter/LIVE
  chip/calendar), box scores, leaders/meta/records, team/player pages,
  fantasy+pick'em signed-in, and a mobile no-horizontal-overflow tripwire
  whose failure output names the offending elements and the scroll chain.
  Every spec asserts zero uncaught client errors (`trackPageErrors`) — the
  crash class raw-HTML checks can't see. Can't run SIMULTANEOUSLY with the
  main e2e (one dev server per repo) — CI runs them sequentially.

## Roster moves (done)

- `signFreeAgent`: permanently adds a registered, unrostered player to a team
  with an open seat at $0 — how short rosters (pool-dry drafts, late signups)
  get topped up. Guards: post-draft phases only, team in season, ACTIVE
  registration, not already rostered, seat available.
- `releasePlayer`: removes a non-captain from their roster (registration stays
  ACTIVE → back in the free-agent pool; release + sign = replace/trade).
  Captains can't be released. **A release is THREE things in one transaction —
  keep it that way:** free the seat, REFUND `member.price` to the team, and
  CANCEL any `StandinAssignment` covering them on a series that HASN'T STARTED
  (no imported games) — never one mid-series: `gatherTeamAccounts` re-reads
  assignments on every import, so deleting one mid-Bo3 drops the standin from the
  team's account set for games 2-3 (null `teamId` lines, and the side can fall
  under `classifyGame`'s recognizable-account floor and stop importing). That is
  the deletion `removeStandinGuarded` already refuses; release reports those in
  the toast instead of doing it by the back door.
  Skipping the refund broke the auction's `budget >= need * MIN_BID` invariant
  (a team that spent out ended at need=1/budget=$0); leaving the cover behind
  made `matchNightRoster` report the side ONE TOO LARGE, because the swap is
  "remove the covered player, add the standin" and the covered player was gone —
  six players in a 5v5 on /schedule, the dashboard strip and the Discord week
  reminder. The toast names both effects.
- **A roster move must never leave stale cover.** `withdrawGateError` takes
  `pendingAssignments` and refuses a standin who still owes cover on an unplayed
  match ("remove that assignment first" — the `promoteGateError` wording family);
  BOTH callers pass the count (`leaveLeague` and admin `withdrawSignup`). It
  refuses rather than auto-cancelling on purpose: the captain who arranged the
  cover is the one who needs to know the seat reopened. **The withdraw paths AND
  `assignStandinGuarded` all run their read+write at SERIALIZABLE** — they are a
  write-skew pair (assign reads the Registration and writes an assignment;
  withdraw counts assignments and writes the Registration), and SSI only spots
  the cycle when EVERY participant is serializable, so don't drop one back to a
  plain transaction. Once hand-verified only; now pinned by
  `test/integration/standins-raced.itest.ts` (Promise.all races over the
  assign-vs-withdraw and assign-vs-release pairs — `npm run test:pg` is what
  runs them for real, SQLite degrades them to sequential). Belt-and-braces,
- **A standin can't cover two matches the same night.** Pure `standinConflict`
  (`src/lib/standin.ts`, tested): kickoffs within `STANDIN_CONFLICT_HOURS` (4)
  clash, falling back to the same WEEK when either time is unset. The old
  duplicate check asked only "is this standin already in THIS match", so the
  same person could be booked for two fixtures at the same minute — not a
  corner case, since the league plays every team on one night and it happens
  the first time a captain and an admin both go looking for cover. Checked in
  BOTH places, like every other precondition here: once up front and again
  inside the SERIALIZABLE transaction (outside it, two concurrent assigns each
  see a clear field). Completed matches are ignored — that cover is history.
  The error names the clashing fixture, because "remove that assignment first"
  is useless without saying which.
- Belt-and-braces,
  `matchNightRoster` DROPS an assignment whose non-null `replacingUserId` isn't
  on the base roster — a NULL replacingUserId is kept (that's a standin filling
  an empty seat, which adds a player without replacing one).
- Both announced in Discord; the admin "Roster moves" card shows whichever
  forms currently apply (sign needs a short team + free agent; release needs
  any non-captain rostered).
- `promoteStandinToPlayer`: flips an ACTIVE STANDIN registration to PLAYER —
  the mid-season refill path (late joiners can only register as standins once
  signups close, and `signFreeAgent` refuses standins). Guards in pure
  `promoteGateError` (`registration.ts`, tested): blocked during SIGNUPS
  (self-serve covers it), COMPLETE, a LIVE/PAUSED draft (would inject into
  the running auction pool — pre-start and post-draft are fine), and while
  the standin has assignments on unplayed matches (remove those first).
  Third row in the Roster moves card; flow is promote → sign via the
  free-agent form (which does the Discord announcement).

## Playoffs & standins (done)

- **Playoffs**: `src/lib/playoff-service.ts` — `createPlayoffBracket` seeds the
  top teams by standings; `advancePlayoffBracket` (called from `recordResult`
  when a match's phase isn't REGULAR) builds the next round from winners and
  crowns the champion when the final ends. Bracket slots are `R{round}M{match}`.
  Pure helpers live in `schedule.ts` (`pickBracketSize`, `nextRoundPairings`,
  `roundName`).
- **Standins**: guards live in `src/lib/standin-service.ts`
  (reschedule-service pattern, integration-tested in
  `test/integration/standins.itest.ts`); the replaced player's roster infers
  which team the standin fills for. CAPTAINS self-serve their own team's cover
  via the match-page "Standins" card (`captainAssignStandin`/
  `captainRemoveStandin` in `src/app/actions/standins.ts` — actingCaptainId
  must own the covered team); the admin panel keeps the any-team override
  (`actingCaptainId: null`). Assign AND remove announce to Discord
  (`standinAssignedMessage`/`standinRemovedMessage`) — being assigned is the
  most action-demanding event a standin can get. Shown on `/schedule`.

## Match data / OpenDota (done)

- `src/lib/dota.ts` — OpenDota client, SteamID64 ↔ `account_id` conversion,
  match-id/URL parsing. Optional `OPENDOTA_API_KEY`. Hero names are NOT fetched
  — `heroById` (`src/lib/heroes.ts`) is a static table, so no hero label anywhere
  in the app depends on OpenDota being up.
- `src/lib/match-import.ts` — `classifyGame` (pure, unit-tested) decides whether
  a fetched game is between our two teams and who won; `importGameForMatch`
  records a `Game` + `recomputeSeries`; `autoDetectGamesForMatch` scans rosters'
  recent games. Standins assigned to a match count for their team. Uses
  `Game.dotaMatchId` unique to dedupe.
- Admin: `MatchImportControls` (client, `useActionState` for inline errors) →
  `importGameAction` / `autoDetectAction`. Box score lives at `/matches/[id]`.
- **Captain result reporting**: the two captains can import their own finished
  games on `/matches/[id]` ("Report your result" card, shown while the match
  isn't COMPLETED) — guards in `src/lib/match-report-service.ts`
  (reschedule-service pattern, integration-tested in
  `test/integration/match-report.itest.ts`), thin actions in
  `src/app/actions/match-report.ts` (auth + "games" tag bust + toasts).
  `MatchImportControls` now takes the two server actions as props (admin panel
  passes the admin ones). Import-only — manual score entry stays admin-only.
- Games roll up into `Match.homeScore/awayScore`; playoff game imports call
  `advancePlayoffBracket`. Note: `tsconfig` target is ES2017, so use
  `BigInt("…")` not `123n` literals.
- **Automatic result sync**: see its own section below — league + inhouse
  results now pull themselves from OpenDota with no button press; the captain
  and admin controls above remain as manual overrides (players with public
  match data off, unscheduled fixtures).
- **Ranked medals**: `src/lib/rank.ts` decodes OpenDota `rank_tier` (pure,
  tested) → `<RankBadge>`. `fetchPlayerRankTier` fills `User.rankTier` on profile
  link/refresh (`updateDotaAccount`/`refreshRank`) and in bulk via admin
  `syncPlayerRanks`. Medals render on players/teams/draft (a captain resource).
- **In-client league sync**: `Season.dotaLeagueId` + `syncLeagueGames` (fetch
  `/leagues/{id}/matches`, `classifyGame` each vs. scheduled matches, import).
  Admin `setLeagueId` / `syncLeagueAction`. League registration is done at
  dota2.com/league; games are tagged by hosting private lobbies with the id.
- **Discord contact**: `User.discordName` (empty string = unset; persists
  across seasons). Pure `normalizeDiscordName` (`src/lib/discord-name.ts`,
  tested — modern lowercase handles + legacy Name#1234, strips @, "" clears),
  `updateDiscordName` action, edit card on `/me`. Rendered as the copyable
  `<DiscordTag>` chip (`src/components/discord-tag.tsx`, clipboard + toast)
  on the signup pool, team rosters, player profiles, and the draft room's
  nominated panel — ALWAYS gated to signed-in viewers (contact info is for
  members, not the public internet; keep that rule on new surfaces).
- **Discord account linking (OAuth2)**: `User.discordId` (@unique snowflake,
  null = unlinked) is set ONLY by the OAuth callback — proof the player owns
  the account; the typed `discordName` stays as the unverified fallback, and
  `<DiscordTag verified>` shows a ✓ wherever `!!discordId`. Flow mirrors
  Steam: `/api/auth/discord` (session required — this is linking, not login;
  state+PKCE verifier in a one-shot httpOnly cookie scoped to the callback
  path) → Discord (`identify`, plus `guilds.join` when a bot is configured —
  see below; never email, never the guild LIST) →
  `/api/auth/discord/callback`, a thin shell over `handleDiscordCallback`
  (`src/lib/discord-link-service.ts`, reschedule-service pattern,
  integration-tested in `test/integration/discord-link.itest.ts`): state
  checked before the code is spent, tokens fetched server-side and DISCARDED
  (only id+username persist), collisions → `?discord=taken`. Pure URL/PKCE/
  parse helpers in `src/lib/discord-oauth.ts` (tested; RFC 7636 vector).
  `/me` maps KNOWN `?discord=` codes to copy (hasOwnProperty-guarded — a
  `?discord=__proto__` must fall back to the generic note, never echo), and
  `<StripQueryParam>` scrubs the one-shot param after first render so the
  note can't go stale against the card. The Link button hides unless
  `DISCORD_CLIENT_ID`+`DISCORD_CLIENT_SECRET` are set. `updateDiscordName`
  refuses while linked via an ATOMIC `updateMany({where:{discordId:null}})`
  claim — a plain read-then-write loses a race against the callback and a
  typed handle would wear the verified ✓; `unlinkDiscord` clears both
  fields. The client secret follows the webhook rule: server-only, never
  rendered or logged. Re-linking a DIFFERENT account strips the ping role
  from the replaced one (see the guild-membership entry below — this was a
  KNOWN GAP here for a while).
- **One click links AND joins the server (`guilds.join`)**: the scope is
  CONDITIONAL — `buildDiscordAuthUrl({withGuildJoin})`, passed
  `!!getGuildConfig()` by `/api/auth/discord`. Without a bot the consent
  screen is identify-only exactly as before; asking to "join servers for you"
  when the callback can't deliver it would be the scarier screen with none of
  the payoff. `getGuildConfig` (token+guild, NO role id) is deliberately
  separate from `getRoleConfig` — gating the join on the latter would silently
  disable it on any server that just hasn't picked a ping role.
  `joinGuild` (`discord-roles.ts`) PUTs `/guilds/{g}/members/{userId}` with the
  BOT token in the header and the user's access token in the body — both are
  required, which is why it can only run inside the callback while the token
  is still in hand (it is still discarded immediately; nothing is stored).
  **A failed join must NEVER fail the link** — the link is already committed
  when it runs, and the whole thing is wrapped in a try/catch that degrades to
  `?discord=join_failed`; pinned by `discord-link.itest.ts`. 201 with
  `pending: true` means Membership Screening has them behind the rules — in
  the guild but unpingable, so it reports `joined_pending` rather than
  claiming success. Two silent 403 causes, both on the admin card's
  "Auto-join on link" line: the bot lacks CREATE_INSTANT_INVITE, or
  `DISCORD_BOT_TOKEN` and `DISCORD_CLIENT_ID` are DIFFERENT applications
  (a bot user's id IS its app id, so `getPingHealth` compares them free).
  `discord-oauth.test.ts` pins the scope in BOTH directions — identify-only by
  default, and never a READ scope beyond identify in either mode. `joinGuild`
  itself is exercised over REAL HTTP in `discord-roles.itest.ts` (its stand-in
  server BUFFERS the request body, since the whole contract is bot-token-in-
  header + user-token-in-body): a mocked dep can't catch the bug class this
  file has already met once — branching on a status whose meaning is
  counter-intuitive, here `204` = "already a member" = success.
- **The signed-up-but-unlinked prompt** (`src/components/discord-setup.tsx`):
  linking used to be offered in exactly ONE place — a card partway down `/me`
  — while the invite had six. `DiscordSetupPrompt` renders on the dashboard
  (and `DiscordSetupCard` at the top of `/me`) for a viewer who is ACTIVE in
  the season and has no `discordId`, and is phase-independent on purpose: a
  player who signs up during SIGNUPS is still unreachable in week 4. It is
  DERIVED state, never a dismissible flag — a nag that can be dismissed
  permanently stops working, and one that outlives what it asks for is worse.
  Copy branches on `autoJoins` so it never promises the one-click version on a
  league with no bot. The callback lands on the `?next=` return path now
  (packed into the OAuth cookie as a base64url third part — see the
  guild-membership entry below); a half-filled signup form is still lost to
  the full-page redirect, but the player at least comes back to the page they
  left.
- **Guild membership verification** — linking proves OWNERSHIP; only being in
  the server makes a player reachable, and the auto-join runs exactly once (in
  the OAuth callback), so linked-before-the-bot / join-failed-and-ignored /
  joined-then-left / stuck-behind-Membership-Screening all wore the same green
  "Linked ✓" forever. `fetchGuildMember`/`guildMembership` (`discord-roles.ts`,
  real-HTTP itested) re-read it live: ONE member GET answers both membership
  AND the ping role (`hasPingRole` is now a wrapper — its null-means-unknown
  contract is unchanged). **A bare 404 from that endpoint is NOT "player left"**
  — it also 404s with code 10004 (Unknown Guild) when the BOT is missing or the
  guild id is wrong, which read naively would nag the whole league to re-join a
  server they're in; only body codes 10007/10013 mean not-a-member, anything
  else is `null` = unknown, and **unknown never renders as a negative
  anywhere**. Membership is never mirrored into a column (the `hasPingRole`
  drift argument); hot surfaces go through `memoGuildMembership` — asymmetric
  TTLs (member 5min, everything else 30s) because a non-member is mid-fix and
  the nag must notice their join fast — and /me's live read calls
  `primeMembershipMemo` so the dashboard can't contradict the profile page.
  Surfaces: /me's Discord card is three-state (In the server ✓ / Rules pending
  / Not in the server + a durable CTA strip; the one-shot `?discord=` join
  button renders only when `membership === null` so two CTAs never stack);
  `DiscordJoinCard` renders on the dashboard via `DiscordSetupPrompt` for
  linked-but-not-in/pending ACTIVE players (unknown renders NOTHING); the
  admin card's `getDiscordReachFunnel` extends the reach line with
  in-server/pending/missing/unknown — **unknown is its own count, never lumped
  into missing**, and the headline's denominator is the players we could
  CHECK, collapsing to just the couldn't-check line when Discord answered for
  nobody — via `sweepGuildMemberships` (per-id on purpose: the bulk list
  endpoint needs the GUILD_MEMBERS privileged intent, a fifth way to be
  half-configured; `getDiscordReach` itself stays DB-only, its contract is
  "no Discord calls, cannot fail"); the Start-draft confirm appends
  `discordReachWarning` (names the missing/pending, counts the unlinked)
  through a Suspense-wrapped `StartDraftControl` whose fallback is the SAME
  working button with the base confirm — the admin blocking path gains no
  Discord call, per the streamed-DiscordSection rule — and `adminNextStep`'s
  Start-draft steps (BOTH of them — SIGNUPS and the DRAFT-phase pre-start
  state) take `unlinkedDiscordCount`, counted over ALL ACTIVE registrations
  in `loadSeasonAdminData` so the banner and the funnel card it points at can
  never disagree. Policy: warn-and-name, never hard-block signup or
  `startDraft` on a third-party API. The `<DiscordTag verified>` ✓ still means
  ownership only, deliberately — per-row membership on pool/roster lists is
  unaffordable and a mirrored column drifts.
  An adversarial review pass hardened the edges — keep these:
  * `memoGuildMembership` also memoises the IN-FLIGHT promise (two funnel
    consumers render concurrently on /admin; a result-only memo doubles the
    cold burst), its resolution won't clobber a FRESHER entry, and
    `primeMembershipMemo` ignores null — one failed /me lookup must not erase
    a real answer the dashboard nag renders from. `sweepGuildMemberships` has
    an aggregate `SWEEP_DEADLINE_MS` (8s): the per-call 4s timeout compounds
    across serial batches, and past the budget ids come back null — the
    funnel's honest couldn't-check count, never silently dropped. The member
    lookup is RATE-PACED (first prod sweep: one bucket's worth answered, the
    other 11 burned into 429s and read "couldn't check 11"): it reads
    X-RateLimit-Remaining/Reset-After off every response and waits out a
    known-empty bucket before spending a request on a guaranteed 429, and an
    actual 429 honors retry_after with ONE capped retry (`RATE_WAIT_MAX_MS`
    2.5s — longer means unknown NOW, because /me's blocking render and the
    sweep deadline both sit on top of this). The stand-in tests enforce their
    own bucket server-side, so the exact request COUNT is what proves the
    pacing, not just the outcome.
  * **The join CTAs carry three DISTINCT names on purpose** ("Join the
    server" = one-click re-OAuth in `DiscordJoinCard`; "Use the invite
    instead" beside it; "Join via the invite" in /me's strip — and the pending
    strip says "Open Discord" vs the card's "Open the server"). Two rules
    collide here: one-control-one-name, and **a broken auto-join must always
    leave an invite path visible** — re-OAuth alone bounces a player whose
    join 403s (bot missing CREATE_INSTANT_INVITE, mismatched app) through
    consent back to the same card forever.
  * **The live membership answer beats the `?discord=` param** (`/me`'s
    `discordNoteResolved`): the note was minted by the CALLBACK, and a player
    who was already in the server when the auto-join 403'd otherwise reads
    "we couldn't add you — join it with the button below" under an
    "In the server ✓" badge, with no such button on the page.
  * **`getPingHealth` runs its bot checks WITHOUT a ping role** (only the
    role rows stay null): bot-without-role is a supported config that can run
    the membership sweep, so when the sweep reads all-unknown because the bot
    was kicked or the guild id is wrong, the checklist on the same card is
    what names the cause — every unknown-copy pointer to it depends on that.
    Never claim "reload fixes it" for unknowns: reload inside the 30s memo
    TTL is a no-op, and a kicked bot answers that way forever.
  Second pass (same day), four additions:
  * **The OAuth link carries a return path** — `/api/auth/discord?next=…`,
    validated by `safeReturnPath` at pack time AND at unpack (the cookie is
    client-held bytes; a tampered third part degrades to no-path, never a
    redirect), ridden as a base64url third cookie part (two-part cookies from
    mid-deploy still round-trip). `oauthLandingPath` (pure, tested) honors it
    ONLY on full success (`joined`/`linked`) — every other outcome carries a
    `?discord=` code that only /me can render and scrub, so it overrides the
    path; a success bound for /me anyway keeps its confirmation code. The
    dashboard's setup/join cards pass `next="/"`.
  * **The chase message** (`discordChaseMessage` + `<ChaseCopy>`): the funnel
    can't notify the very people it names, so the last mile is a human
    pasting into Discord — one click builds the post (invite for the missing,
    rules nudge for the pending, profile link for the unlinked) onto the
    clipboard, origin built client-side at CLICK time (the InviteLink rule).
    The funnel's name lists are now UNCAPPED — a chase that names 12 of 28
    isn't a chase — and the CARD does the 12-cap display. The pure copy
    builders live in `discord-reach.ts`, split out because ChaseCopy is
    `"use client"` and discord-roles imports prisma; discord-roles re-exports
    them so server import paths didn't move.
  * **`reachabilityNote(userId)`** rides the assign-standin toasts (BOTH
    paths — captain and admin): being assigned is the most action-demanding
    message the league sends, so if the announcement structurally can't reach
    the standin (unlinked / not in server / rules-pending), the person
    arranging cover hears it NOW, not on match night. Silent on unknown — a
    Discord hiccup must not dress up as "this player is unreachable" — and it
    never throws (a toast garnish can't be allowed to fail an assignment).
  * **Re-linking a DIFFERENT Discord account strips the ping role from the
    replaced one** (was a KNOWN GAP): `linkDiscordAccount` returns
    `previousDiscordId`, and the callback's injected `stripPingRole` dep
    fires best-effort AFTER the link commits — a failed strip never costs
    the link. Same-account re-links don't strip.
  * **"Missing" is a fact about the LINKED ACCOUNT, not always the human —
    and every surface says which account** (first live use: the admin
    reported "some of these players are in the discord", and they were —
    on accounts they hadn't linked). The membership check runs by ID
    against the account the player linked, so a smurf/old-account link
    classifies not-member while the person sits in the server. The funnel's
    guild lists carry `ReachPlayer` ({name, handle}); the admin card, the
    chase message and both player-facing surfaces render "(@handle)" plus
    the remedy (join on the linked account, or re-link the one they use —
    the OAuth Join button re-links whichever account the browser is signed
    into, fixing both in one click). The Start-draft confirm stays
    names-only (a confirm is glanced at; handles are for acting on). The
    chase message's unlinked block also states "being in the server isn't
    enough" — the admin read that list as "not in Discord", which it never
    claimed. When copy follows a JSX expression onto a new source line, use
    the quoted-string form — the plain leading space is line-trimmed
    ("(@gone4)isn't"); this has now bitten three times.
  COVERAGE LIMIT (stated, not hidden): the three-state /me card, the
  dashboard join nag and the note-resolution are server-rendered JSX with no
  automated render test (no jsdom; e2e has no bot env) — the lib layer under
  them is fully itested, and they were verified in a real browser via the
  `discord-fixture` launch entry (port 3115): run
  `node scripts/discord-standin.mjs` (a stand-in Discord API on :4310 whose
  member answers key off discordId suffix — …02 member, …03 pending,
  …04 404-10007, …05 500), seed `signups-fixture.db`, then
  `scripts/link-fixture-discord.ts` links fixture users to those ids; log in
  with `/api/auth/dev`.
- **Player questionnaire**: `Registration.roles` (comma-sep position keys,
  helpers + tests in `src/lib/roles.ts`), `favoriteHeroes`, `statement`,
  `captainNote` — captured on `/me`, surfaced in the player pool and draft room
  (`getDraftState` carries roles/heroes/note for the nominated player).

## Automatic result sync (done)

The league updates itself — results flow in from OpenDota with no captain or
admin button press. Lazy, no cron/websocket (draft-clock philosophy).

- **Trigger**: `<ResultSyncPing>` (`src/components/result-sync-ping.tsx`,
  mounted once in the root layout, renders nothing) POSTs `/api/sync` on page
  view, then heartbeats — `AUTO_SYNC.WATCH_POLL_SECONDS` while the server says
  `watch: true` (matches in their detection window or a live inhouse), else
  `IDLE_POLL_SECONDS`. Hidden tabs don't ping; a visibilitychange → visible
  syncs immediately. TWO refresh triggers, both required: `updated` (this
  client's own request performed the import) and the `cursor` advancing — the
  atomic claims mean exactly ONE request ever "does" an import, so without
  the cursor every other parked dashboard would poll `updated:false` forever
  and stay stale. The cursor is the `resultChangedAt` Setting, bumped by
  `stampResultChange()` (`settings.ts`) from EVERY result path:
  `importGameForMatch`, admin `recordResult`, and inhouse `applyResult`.
- **Route** (`src/app/api/sync/route.ts`): per-IP `rateLimit` speed bump, runs
  `runResultSync`, and busts the `"games"` tag on imports — it's a route
  handler (not a `<WeekReminderPing>`-style server component) precisely
  because `revalidateTag` is only legal from a request scope.
- **Service** (`src/lib/result-sync-service.ts` + pure window math in
  `src/lib/result-sync.ts`, both tested;
  `test/integration/result-sync.itest.ts`): a match is due from
  `AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF` after its `scheduledAt` until
  `WINDOW_HOURS` later, while not COMPLETED (LIVE partial series keep
  scanning — Bo3 games 2/3 arrive later; unscheduled matches never auto-scan).
  With a `Season.dotaLeagueId` one `syncLeagueGames({ auto: true })` call
  covers everything, globally throttled via the `leagueAutoSyncAt` Setting
  claim — auto mode fetches at most `LEAGUE_MAX_FETCHES_PER_RUN` unknown ids
  per run (a typo'd league id can list thousands) and remembers
  fetched-but-not-imported ids in a per-season `leagueSyncSkip:` Setting so
  they're never refetched (the admin's manual button bypasses both, since a
  skipped game can become importable after a roster/standin change).
  Otherwise ONE due match per run (stalest first) is claimed atomically on
  `Match.autoSyncedAt` (updateMany — the inhouse `detectedAt` pattern) and
  roster-scanned with `autoDetectGamesForMatch`. API budget guards, all
  load-bearing: consecutive EMPTY scans back off exponentially via
  `Match.autoSyncAttempts` (interval doubles per miss, cap ≈4.3h, reset on
  any import — a forfeited/private-data fixture costs ~15 scans across its
  48h window instead of ~700), and a global `rosterAutoSyncAt` Setting claim
  (`SCAN_GAP_SECONDS`) stops N simultaneous pollers fanning out into N
  parallel scans. One scan ≈ 10 recentMatches + ≤12 match fetches.
  `syncLeagueGames` never touches a COMPLETED match (was: completed-with-0-
  games only) — a decided series or an admin forfeit ruling must not be
  rewritten by a late league-lobby import; amending is per-match admin work.
- **Inhouse from anywhere**: the same run executes the inhouse lazy resolvers
  (`maybeFormLobby`/`resolveCaptainVote`/`resolveStalledPick`/
  `maybeAutoDetectResult`) behind a cheap active-lobby/queue gate — while all
  ten players are in the Dota client with /inhouse closed, any page view on
  the site still closes the lobby out.
- Downstream effects are free: imports funnel through `importGameForMatch` →
  `recomputeSeries`, so brackets advance, honors fire, and the new
  `announceSeriesResultOnce` posts the result to Discord (see Discord section)
  whichever path — captain, admin, league sync, or auto sync — finished the
  series.
- **GET /api/sync** exists for external pingers: point a free 5-minute uptime
  monitor at it (README) — downtime alerting + a sync heartbeat for the
  nobody-on-site window, without abandoning the lazy no-cron design.
- **Health surface**: the admin "Automatic result sync" card (`AutoSyncHealth`
  in `admin/page.tsx`) renders each in-window match's last scan / empty-scan
  count / next-scan time (pure `nextAutoSyncAt`, tested), the league-feed
  throttle, the change cursor, and skip-memory size — a match parked in
  backoff is otherwise indistinguishable from "no games yet".
- **Private match data**: `User.fhUnavailable` (OpenDota `profile.
  fh_unavailable` — true means "Expose Public Match Data" is off, the #1
  reason auto-import can't see a player). Captured wherever the medal is
  fetched (`fetchRankTier` carries it; login `ensureRankTier`, /me
  link/refresh, admin bulk sync) under the same never-overwrite-on-failure
  rule as `rankTier` (rank-sync.itest). Surfaced as a danger note on /me and
  a "private data" badge in the admin player list.
- **LIVE chips**: /schedule rows and the dashboard This-week strip show a
  pulsing partial score (`live` flag on `MatchView`) while a series is LIVE —
  auto-sync makes "Bo3 at 1–0" a common minutes-fresh state.

## Player-facing navigation & info pages (done)

Purely additive UX layer — no league logic changed. Every player/team name in
the app is a link (`<PlayerLink userId>` in `ui.tsx` for players; plain
`next/link` to `/teams/[id]` for teams).

- **Player profiles** `/players/[id]` — season registration (roles, heroes,
  goals, captain note), team + draft price, career record/KDA, most-played
  heroes, and match history. Career stats roll up from each `Game`'s stored
  player JSON via pure `summarizePlayerGames` (`src/lib/player-stats.ts`, tested).
- **Teams index** `/teams` — phase-aware: budgets/rosters during DRAFT, then
  re-sorts by standings with W–L(–D), points, and diff. Team detail
  (`/teams/[id]`) adds recent-form chips + head-to-head (pure `recentForm` /
  `headToHead` in `src/lib/team-matches.ts`, tested) and a draft-spend summary.
- **Leaders** `/leaders` — six leaderboards (wins, KDA, win rate, kills,
  assists, games) via pure `topBy` (`player-stats.ts`); rate boards use an
  adaptive min-games floor.
- **Dashboard** (`src/app/page.tsx`) shows a compact playoff bracket during
  PLAYOFFS and a champion/final-standings recap on COMPLETE. Bracket
  round-grouping is pure `slotRound` / `groupPlayoffRounds` (`schedule.ts`,
  tested), shared with `/schedule`.
- **Nav** (`site-header.tsx`) gates links by phase: Teams appears from DRAFT on;
  Schedule + Leaders from REGULAR_SEASON on. `isActive` keeps "Teams" and
  "My Team" from both highlighting on your own team page.

## Inhouse (done)

A casual pick-up mode, **entirely separate from the league** (no `Season`
coupling — touches only `User`). Mirrors the draft engine's architecture:
server-authoritative, resolves lazily on poll (no cron/websocket).

- **Every state transition is a guarded claim (2026-07 hardening — keep it
  that way)**: `applyResult` is `updateMany({id, status: IN_PROGRESS})` (a
  cancel racing the seconds-long OpenDota fetch must never be overwritten,
  nor a CANCELLED lobby resurrected — the claim winner alone stamps
  `eloDeltas`, bumps the cursor, and sends the Discord result); `cancelLobby`
  re-claims inside its tx (loses to a landed result, skips the requeue);
  `applyPick` claims the target row `{team: null}` (double-click = one turn)
  and AUTO-ASSIGNS the final pool player (no dead-air last clock);
  `resolveCaptainVote` claims the `CAPTAIN_VOTE → DRAFTING` flip before
  installing captains; `maybeFormLobby` runs Serializable + catches P2034
  (the one-active-lobby invariant has no DB constraint — this is what holds
  it on Postgres); `joinQueue` wraps guard+upsert in one tx. The queue ping
  throttle is the Setting create/P2002/conditional-update claim.
- **`applyPick` must THROW, never return, once it has nulled `pickTeam`**
  (2026-07 audit). Nulling `pickTeam` IS the turn claim, and a `return` from a
  Prisma interactive-transaction callback RESOLVES it, i.e. COMMITS — so the
  two post-claim failure paths used to leave the lobby DRAFTING with
  `pickTeam = null`, which NOTHING can move (`resolveStalledPick` filters
  `pickTeam: { not: null }`, `makePick` bails on `!lobby.pickTeam`): a dead
  clock for all ten, admin cancel the only exit. They throw `PickRaceError`
  now and `makePick`/`resolveStalledPick` catch it OUTSIDE the callback (catch
  it inside and you're back to committing). Two more parts of the same fix,
  keep all three: the turn claim's WHERE includes `pickEndsAt` — the snake
  repeats a team across consecutive picks (2,1,1,2,2,1,1,2), so `pickTeam`
  alone does NOT identify a turn and a loser that blocked on the winner's row
  lock re-matches after the commit; `makePick` passes the team it AUTHORIZED
  against to `applyPick` as `expectTeam`, because Postgres re-snapshots per
  statement even inside one transaction, so the re-read can show a turn that
  has since moved to the OPPOSING captain; and `restoreLostPickTurn` (run at
  the top of `resolveStalledPick`) recomputes the turn from the rosters via
  pure `nextPickTeam` if a DRAFTING lobby is ever found off the clock, making
  the frozen state unreachable rather than merely fixed.
- **`resolveAbandonedLobby` — READY and IN_PROGRESS are the only phases with
  no clock**, so before it they held the single active-lobby slot forever:
  `maybeFormLobby` early-returns on any active lobby, so no new game could
  form, AND the dead lobby's own ten were refused by `joinQueue`'s
  inActiveLobby guard. The whole feature was down until an admin visited
  /inhouse. It runs FIRST in both resolver chains (`getInhouseState` and
  result-sync's `syncInhouse` — the latter is what reaches a lobby nobody is
  polling, which is how one gets abandoned) and guard-claims on the status it
  read, so a late Start or a landed result always wins. Floors are
  deliberately generous (`ABANDON_READY_HOURS` 3, `ABANDON_IN_PROGRESS_HOURS`
  6 off `startedAt`): Start can be pressed after the game and the manual
  result paths have no time gate, so a group that simply forgot still records
  normally. It does NOT re-queue anyone — unlike `cancelLobby`, whose players
  are present and want the next game, nobody has touched this one for hours.
- **`InhouseLobby.eloDeltas`** (JSON userId → Elo swing) is stamped once at
  completion; the room's post-game banner reads it — never re-derive the
  ladder on the poll path. **`InhouseLobbyPlayer.wins/losses/games`** are
  record snapshots frozen at formation (safe: results can't land while the
  lobby is active) — the vote/draft views and RECORD ordering read them, so
  polls never scan history. `@@index([status])` on lobbies,
  `@@index([userId])` on lobby players.
- **Queue MMR trust chain**: latest `Registration.mmr` (league-trusted) >
  clamped typed value > the player's last lobby snapshot (so the one-tap
  "Run it back" join with a blank field doesn't reset anyone to unknown).
  Client-claimed MMR alone never decides captaincy for registered players.
- **recordMatch (paste path)**: rejects matches that started before the lobby
  formed (same floor as auto-detect — yesterday's game can't replay as
  today's result) but accepts `minPerSide 2` (vs the background scan's 3) —
  the escape hatch when most players have public match data off. buildResult
  refuses 0-duration games. Auto-scan cadence: pure `detectIntervalSeconds`
  grows the `detectedAt` claim interval with game age (base 180s → cap 1800s)
  so an abandoned IN_PROGRESS lobby scans at a trickle, not forever at rate.
- **Discord result announcement**: `inhouseResultMessage` (score, duration,
  MVP via the league's `gameMvp`, OpenDota link) fires from `applyResult`
  post-claim — exactly once whichever path (button, paste, background scan)
  lands the result.
- **Surfaces added**: `/inhouse/history` (compact archive of every completed
  game — date, score, winner, MVP, OpenDota link; linked from "All results →");
  "Run it back →" on the victory/defeat banner (dismissal persists across
  reloads via localStorage); a vote-phase compact fixed clock bar (same
  `useBannerOffscreen`/`top-20` contract as the draft); queued players beyond
  the ten slots render as an "In line for the next game" chip list (never
  silently hidden); `/api/inhouse` has the same per-IP `rateLimit` speed bump
  as `/api/sync`; the page streams results + ladder behind `Suspense` (room
  paints immediately); an "Inhouse" career card on `/players/[id]`
  (`InhouseCareerCard` — ladder line + last 3 games with hero/KDA, streamed).
- **Provisional gating**: pure `rankInhouse` (`inhouse-stats.ts`, tested)
  splits the ladder — medals and `#N` ranks belong to established accounts
  (≥ PROVISIONAL_GAMES) only; provisionals list after, dimmed, `—`-ranked.
  Both the /inhouse ladder and the profile card use it.
- **`fetchRecentMatchIds` returns `null` on fetch failure** (429/5xx/timeout)
  vs `[]` for a genuinely empty history — the detect button's error blames
  OpenDota when it was unreachable and privacy settings only when it wasn't.
  League caller (`autoDetectGamesForMatch`) treats null as empty.
- **No ticket required — keep the copy honest**: inhouses are plain private
  lobbies; results come from players' match histories. Never reintroduce
  "league ticket" language on inhouse surfaces.
- **Seeded demo queue entries are born AWAY** (backdated `lastSeenAt`) — they
  dress the page but can never be pulled into a real first-night lobby.
- **e2e**: `e2e/zz4-inhouse.spec.ts` (main suite, runs zz-last) drives the
  real browser through queue join/leave (+ mobile no-overflow tripwire) and
  the full lifecycle — vote → UI draft pick → ready → in-progress — with
  nine API-driven players and zero-pageerror assertions.
- **KNOWN COVERAGE LIMIT — now largely closed by EXTRACTION** (`vitest.config
  .mts` is `environment: "node"` with no jsdom/testing-library, so nothing in
  either ~1800-line room can be rendered in a unit test). Every rule below was
  once comments-only inside a `useEffect`; each is now pure, tested, and called
  by BOTH rooms where the rule is shared:
  * `roomPollCadence` + `inhousePollCadence` / `draftPollCadence`
    (`src/lib/room-poll.ts`) — the 429 back-off, the hidden-tab keepalive vs
    full pause, the fast retry, the idle rate, and `coldStart`.
  * `issueSequence` / `acceptSequence` / `isColdStart`
    (`src/lib/room-sequence.ts`) — payload ordering by request START.
  * `pollHealthAfter` (`src/lib/poll-health.ts`) — the disconnect gate's
    CONSECUTIVE-failure rule; `usePollHealth` now only owns the ref.
  * `nextClockOffset` (`countdown.ts`) — the 1s-hysteresis skew fold, the other
    half of each room's `apply()`.
  * `inhouseAlerts` / `wasInReadyCheck` / `inhouseTitleFlag` /
    `readyCheckEndedToast` / `autoJoinDecision` / `queueSlots` (`inhouse.ts`).
  * `outbidLatchAfter` / `draftTitleFlag` + `stripDraftTitleFlag` /
    `draftViewerStake` (`draft.ts`), beside the older `wasOutbid`.
  `src/components/room-source-guards.test.ts` backs all of it: a pure test
  proves nothing if the room stops calling the function, so it parses both
  room files and fails on a re-inlined rate, flag string, ordering gate, or a
  sequence minted on the wrong side of its `await`.
  * `seedDraftFeed` / `draftFeedDiff` (`src/lib/draft-feed.ts`) — the live
    feed, the SOLD! flash and the draft's chime triggers. The feed is an
    append-only LOG and genuinely cannot be derived from one payload; what IS
    pure is the STEP, so the module answers "what did this poll change" and the
    component keeps the accumulated list and the React keys.
  Prefer this treatment for anything else that comes up; a Playwright spec
  (`zz3`'s route-interception + attempt-count pattern) is the fallback for
  behaviour that genuinely needs a browser, and adding a jsdom environment is
  still the last resort. What is left in the components is React and the DOM:
  refs, effects, `document.title`, and the audio plumbing.
  Separately, the integration suite runs on SQLite, which serializes writers,
  so the guarded claims are never under real contention there — it stages
  races by hand-mutating rows. `npm run test:pg` (`PG_TEST_URL=…`) runs the
  SAME files on Postgres and is the only thing that exercises them for real;
  run it after touching any claim.

- **Models** (`schema.prisma`): `InhouseQueueEntry` (one global rolling queue,
  `userId` unique), `InhouseLobby` (the game + its state machine:
  `READY_CHECK → CAPTAIN_VOTE → DRAFTING → READY → IN_PROGRESS →
  COMPLETED`/`CANCELLED`), `InhouseLobbyPlayer` (`team` 1/2, `isCaptain`,
  `pickIndex`, `mmr` snapshot, `acceptedAt` for the ready check,
  `votedMethod`/`votedNomineeId` for the captain vote). One active lobby at a
  time (`INHOUSE_ACTIVE_STATUSES`).
- **Ready check (Dota-style accept gate)**: a filled lobby opens in
  `READY_CHECK` with `acceptEndsAt` (`INHOUSE.ACCEPT_SECONDS` = 45 — web
  players need the chime/tab-title to reach them first). All ten must
  `acceptMatch` (idempotent claim guarded on BOTH `acceptedAt: null` AND
  `lobby: { status: READY_CHECK }` — the relation filter stops a Postgres
  race where a concurrent decline/expiry cancels the lobby between the read
  and the write, which would otherwise stamp acceptedAt on a dead lobby and
  falsely report success; zero rows + gone lobby ⇒ "match was cancelled").
  The last accept claims the `READY_CHECK → CAPTAIN_VOTE` flip via
  `startCaptainVote` and only then starts `voteEndsAt`; the
  `resolveReadyCheck` all-accepted branch is the safety net for the
  two-concurrent-final-accepts race where neither inline flip fires (runs on
  every poll, before the expiry check). `declineMatch` fails the match NOW;
  an expired check resolves lazily via `resolveReadyCheck` (wired into
  getInhouseState AND result-sync's inhouse hook — a Discord-queued group who
  never open /inhouse still gets their stuck check cleared, freeing the single
  active slot). Failure policy (`failReadyCheck`): it re-reads `acceptedAt`
  AFTER winning the CANCELLED claim (never the caller's pre-claim snapshot —
  an accept committed mid-cancel must count, not be dropped as a no-show),
  then accepters re-queue with LIVE heartbeats + priority (queue slot anchored
  to `lobby.createdAt` so they outrank anyone who joined DURING the check), a
  decline's still-pending players re-queue BACKDATED but inside the drop
  window (their own poll re-confirms — the cancelLobby pattern), and the
  decliner + timeout no-shows are DROPPED. The Discord lobby ping now says
  "accept your game"; the room shows an ACCEPT MATCH button + accepted-grid
  (pending players sort first) + the standard compact clock bar, the tab title
  flips "(!) Accept your match" until accepted, a chime fires both on the
  ready check AND on the vote opening (a player may accept early and tab away),
  and a failed check that snaps the room back to the queue toasts
  "Match cancelled" instead of vanishing silently. That toast is gated on
  MEMBERSHIP (`!me.inLobby`), NOT on a list of statuses, and its wording
  branches on `me.inQueue` — the status list told the decliner and the
  timed-out no-shows they were "back in the queue" when `failReadyCheck`
  deliberately DROPPED them (contradicting the decline dialog they had just
  confirmed), and it announced a cancellation to a player whose match was very
  much alive, because ACCEPT_SECONDS + VOTE_SECONDS fit inside one hidden-tab
  `POLL_KEEPALIVE_MS` gap so their next poll could jump straight to DRAFTING.
- **Game-setup instructions**: once teams lock, the READY and IN_PROGRESS
  views render a `GameSetupCard` — step 1 hosts the Dota 2 lobby with a shared
  name (`GGD2L #<code>`) + password (`<code>`) all ten derive identically from
  the lobby id (pure `inhouseLobbyCode`, tested — no server round-trip/field),
  shown as click-to-copy chips; step 2 points each player to their team's
  Discord voice channel (`INHOUSE.VOICE_TEAM_1`/`_2`, the viewer's side
  highlighted via `me.myTeam`). Channel names + lobby prefix are constants.
- **Captain-selection vote**: when a lobby fills it opens in `CAPTAIN_VOTE` — the
  10 players vote how captains are chosen so it isn't always the same top-2 MMR
  pair: `VOTE` (elect specific players), `MMR` (highest 2), or `RECORD` (best 2
  inhouse records). Resolves when everyone votes or the timer expires, then
  installs the top two and drops into `DRAFTING`.
- **Pure, tested logic**: `src/lib/inhouse.ts` — `tallyMethod` (winning method,
  ties lean `VOTE > RECORD > MMR`), `orderCaptains(method, candidates)` (ranks
  captains per method, always MMR/join fallback), `nextPickTeam` (SNAKE draft
  — single, then pairs, closing on a single: `F O O F F O O F` for a 5v5 — so
  each side's summed pick position is equal and first pick isn't a standing
  advantage; team 2 — the lower seed — picks first via
  `INHOUSE.FIRST_PICK_TEAM`), `isDraftComplete`, `playersNeeded`.
  `src/lib/inhouse-stats.ts` — `summarizeInhouse` ladder
  (wins/losses/win%/streak + personal team-Elo `rating`/`peak`: start 1000,
  K=32, delta from side-average ratings, ranked by rating; `<5` games =
  provisional, dimmed in the UI; also feeds the RECORD method — `orderCaptains`
  re-sorts by wins itself, so ladder order doesn't drive captaincy). The
  ladder query must fetch ALL completed lobbies (no `take` window — Elo
  accumulates over full history). Tunables in
  `constants.ts` (`INHOUSE`: LOBBY_SIZE 10, TEAM_SIZE 5, VOTE_SECONDS 25,
  PICK_SECONDS 60; `CAPTAIN_METHOD` labels).
- **Service (DB, transactional)**: `src/lib/inhouse-service.ts` —
  `getInhouseState` (calls `maybeFormLobby` + `resolveCaptainVote` +
  `resolveStalledPick` + `maybeAutoDetectResult` on every read, like the league
  draft), `joinQueue`/`leaveQueue`, `castVote`, `makePick`, `startGame`,
  `autoDetectResult`, `recordMatch`, `cancelLobby` (admin). Queue hits 10 →
  lobby forms on the next poll; the vote, a stalled pick clock, and the result
  scan all auto-resolve lazily on poll.
- **Results (OpenDota only — no manual winner)**: a result is recorded solely
  from a real Dota match. `buildResult` fetches an OpenDota match, validates it
  with the league's pure `classifyGame` (rosters on opposite sides → winner +
  which side was Radiant), and stores the full per-player **box score** (hero,
  KDA, net worth) as `InhouseLobby.boxScore` JSON + `winnerTeam`/`radiantTeam`/
  `durationSecs`/`radiantScore`/`direScore`/`dotaMatchId`. Two entry points:
  `recordMatch` (paste a match ID) and `autoDetectResult` — `findInhouseGame`
  scans the 10 players' recent matches in parallel, finds the shared game, and
  takes the most recent one that started after the lobby formed. Auto-detect also
  runs on poll (`maybeAutoDetectResult`, gated by `DETECT_MIN_MINUTES`, throttled
  via an atomic `detectedAt` claim — one active lobby, so API usage is bounded).
  Needs players' "Expose Public Match Data" on. The page renders the box score as
  a `GameResultCard` (hero icons via `heroById`/`HeroIcon`, names, KDA, winner).
- **THE PLAYED GAME IS THE TRUTH — `buildResult` reconciles the draft against
  it** (2026-07 audit). Nothing enforces sides in the manually hosted Dota
  lobby (players click their own slots) and `classifyGame`'s side assignment is
  a tolerant MAJORITY vote — it exists for league games, where a standin may be
  unknown to us — so a 1-for-1 slot mix-up classifies fine and used to credit
  the two swapped players with the OPPOSITE of what they did: a win and a
  positive Elo swing for the player who actually lost, listed in the other
  side's column of the result card (which groups by the game's real
  `isRadiant`). `buildResult` now emits `teamFixes` and `applyResult` writes
  them to `InhouseLobbyPlayer.team` post-claim and **before** the
  `summarizeInhouse` history scan — do that after and the Elo lands on the
  wrong five. `isCaptain` is deliberately untouched (who captained is a fact
  about the draft). We move players rather than reject the game: rejecting
  strands the lobby IN_PROGRESS and blocks the single active slot.
- **`findInhouseGame`'s `unreachable` flag is not "every fetch failed"**. A
  candidate needs 4 of the 10 recent-match lists to name it, so once enough
  lookups 429 that the survivors can't reach the threshold, detection is
  structurally impossible however public everyone's data is — and reporting
  that as "turn on Expose Public Match Data" sends ten players hunting through
  Dota settings for a problem they don't have. Both clauses matter: it also
  requires a fetch to have ACTUALLY failed, so a lobby that simply has too few
  resolvable accounts isn't blamed on OpenDota either.
- **API**: one dispatch endpoint `POST /api/inhouse` (`{ action, ... }`; actions:
  `state`/`join`/`leave`/`accept`/`decline`/`vote`/`pick`/`start`/`detect`/
  `record`/`cancel`), always returns fresh viewer-tailored state. Polled by
  `src/components/inhouse-room.tsx` (`"use client"`, one view per phase incl.
  `VoteView`; syncs the vote/pick clocks via server `now` offset like
  `draft-room.tsx`; `router.refresh()` on lobby end to update the
  server-rendered leaderboard + results). Page: `src/app/inhouse/page.tsx`.
  Nav link is always visible (season-independent).
- **Adaptive poll loop** (not a fixed `setInterval`): a self-scheduling
  `setTimeout` that polls FAST (`pollMs`, 1500) while the viewer is in a lobby
  or the queue — where accepts/votes/picks are second-sensitive — and IDLE-slow
  (`INHOUSE.POLL_IDLE_MS`, 10s) when just spectating. **Every cadence rule below
  lives in pure `inhousePollCadence` (`src/lib/room-poll.ts`, tested) — the loop
  only schedules what it returns**, and a source-level guard
  (`room-source-guards.test.ts`) fails if `INHOUSE.POLL_IDLE_MS`/
  `POLL_KEEPALIVE_MS` reappear in the component, because a policy re-inlined
  into a room is how `avgKnownMmr` ended up with three drifting copies. It
  answers twice per tick: before the fetch (`skip`) and after the response
  settles (`delayMs`). **The draft room shares the machine** — one
  `roomPollCadence` with two bindings, because the two rooms want the same four
  rules in the same precedence order but differ in their rates and in what
  counts as "active": inhouse fast = the VIEWER's membership, draft fast = the
  AUCTION's phase (a spectator watching a live lot needs 1.2s polling; a
  captain staring at a finished draft does not). Hidden-tab handling splits on
  stake: a hidden tab with NO stake fully pauses (no fetch — browsers throttle
  background timers anyway; the sitewide `/api/sync` ping still advances
  lobbies), while a hidden tab that's QUEUED or in a lobby keeps a slow
  keepalive (`POLL_KEEPALIVE_MS`, 45s — under `QUEUE_AWAY_SECONDS` 90 even
  after Chrome clamps hidden timers) so its presence heartbeat holds the spot
  and a forming ready check's chime/title still reaches it (`hasStakeRef`, kept
  current by an effect). **`coldStart` is the exception to that pause**: stake
  is learned FROM a payload, so before the first one it is `false` for
  everybody, and a tab that is HIDDEN at load (cmd-clicked, restored with the
  session) used to skip forever — no keepalive, no title flag, no chime, until
  someone looked at it. `isColdStart` allows a few attempts before the first
  paint: bounded, because "until a payload lands" would leave an offline hidden
  tab retrying forever and "one attempt" is spent by a single 429. The
  reschedule re-checks visibility so a mid-fetch refocus snaps back to the
  active rate; `visibilitychange → visible` re-syncs immediately (the
  `<ResultSyncPing>` pattern). A successful `act()` nudges the loop
  (`bumpPollRef`) so joining an idle page snaps to fast polling in ~250ms
  instead of waiting out a stale idle timer. Anyone IN the queue polls fast, so
  a filling queue / forming lobby stays responsive for the players who matter.
  Three guards on that loop, all load-bearing (2026-07 audit) — the draft room
  has the same three, and they are SHARED code now rather than a promise to
  keep them in step: responses are SEQUENCE-ORDERED (`issueSequence` /
  `acceptSequence`, `src/lib/room-sequence.ts`, applied to the poll AND to
  `act()`) because `/api/inhouse` answers mutations with `syncBoard:false`
  while the poll behind them can still be blocked on the Discord board edit, so
  a pre-pick poll landing late put the drafted player back in the pool,
  re-fired the chime and the "(!) Your pick" title, and the captain re-clicked
  into an error toast. Two things about that gate no unit test can see, so the
  source guard checks them: the sequence must be minted BEFORE the `await`
  (order by request START — mint it after and the gate rejects nothing, in
  silence), and `apply()` must stay the only writer of room state. The poll
  fetch carries `AbortSignal.timeout(ROOM_POLL_TIMEOUT_MS)` against the
  never-answering request (see Poll health — the draft room shares the constant
  and the regression spec); and **429 is NOT a poll failure** — it eases off to
  `POLL_IDLE_MS` instead. The route's speed bump is per-IP and a queued tab
  polls 40/min, so one household or NAT crosses 300/min just by having a lobby;
  counting it as a disconnect greyed out ACCEPT MATCH mid-ready-check, and
  retrying at 1.5s kept the fixed window saturated so it never cleared.
- **The bell and the tab title are pure and tested** (`inhouseAlerts`,
  `inhouseTitleFlag`). The room keeps ONE snapshot ref of the previous poll,
  which feeds both the chime and the "Match cancelled" toast, so they can never
  disagree about what changed; `prev === null` IS "first payload", which is
  what stops a mid-lobby reload ringing for things that happened before the
  player arrived. Rules worth knowing before touching them: the five triggers
  are OR'd into ONE `playChime()` (two calls in a commit double-strike the same
  AudioContext); `lobby-formed` keys on the lobby APPEARING, not on
  READY_CHECK, because a hidden tab's first sight of it may be CAPTAIN_VOTE —
  and `vote-opened` requiring the previous status to be exactly READY_CHECK is
  what stops that case ringing twice; `game-ended` keys off `lastResult.lobbyId`
  because the active-lobby query drops COMPLETED and CANCELLED identically, so
  an admin cancel would otherwise ring a victory bell. The title is
  STATE-derived and ungated by the sound toggle (a backgrounded tab shows "(!)"
  without ever needing a gesture) — and each nag stops once the player has done
  the thing: accepted, or voted. The room now also primes the AudioContext on
  the first `pointerdown` anywhere, as the draft room always has: the people
  who most need "match found" are the ones who arrived from a Discord ping
  (`?join=1` auto-joins programmatically) or reloaded a page they had queued
  from — neither has clicked anything, so the alert was computed correctly and
  played into a suspended context.
- **`avgKnownMmr` (`inhouse.ts`, tested) is the ONLY place a team's average
  MMR is computed** — 0 means UNKNOWN and is excluded, never averaged in as a
  zero. The room shows this figure on three screens and each had its own copy;
  the READY/IN_PROGRESS `MatchupGrid` divided by the whole roster, so one
  unregistered player made a side the drafting banner had just called 120 MMR
  stronger render 620 weaker the instant the last pick landed and one view
  replaced the other. `mmrBalance` is a thin wrapper over it.
- **Radiant = team 1 (green), Dire = team 2 (red)**. Seed enqueues 6 demo
  players so `/inhouse` isn't empty on a fresh DB (they prune ~3 min after
  seeding once someone polls /inhouse — expected, see queue presence).
- **Queue presence (heartbeat)**: `InhouseQueueEntry.lastSeenAt`, refreshed
  (throttled, `QUEUE_HEARTBEAT_SECONDS`) by the viewer's own polls at the top
  of `getInhouseState` — a spot is held by keeping /inhouse open. Entries seen
  more than `QUEUE_AWAY_SECONDS` ago are "away" (listed dimmed with an away
  chip, excluded from `needed`, the headline count, the dashboard strip count,
  and lobby formation); past `QUEUE_DROP_SECONDS` they're pruned inside
  `maybeFormLobby` (runs on every poll, before the active-lobby early return).
  `cancelLobby` re-queues its players with a BACKDATED heartbeat
  (`requeueLastSeenAt`) so present players re-confirm on their next poll and
  ghosts drop out instead of instantly re-forming the lobby. Pure helpers
  (`queuePresence`/`queuePresentCutoff`/`queueDropCutoff`/`requeueLastSeenAt`)
  in `inhouse.ts`, tested; window invariants asserted in `inhouse.test.ts`.
  **`QUEUE_RECONFIRM_SECONDS` (the slack that requeue leaves before the prune)
  must comfortably EXCEED `POLL_KEEPALIVE_MS`, and the binding case is a live
  game**: all ten tabs are hidden (everyone is in the Dota client), so they
  re-confirm on the 45s keepalive — which Chrome clamps toward once a minute.
  At 45s of slack the admin's own 1.5s poll ran `maybeFormLobby`'s prune
  before a single keepalive landed, so "players re-queued" silently emptied
  the queue and, with nobody left polling, nothing noticed. It's 75s, pinned
  by a test against `POLL_KEEPALIVE_MS`; raising the keepalive means raising
  this too.
- **Balance meter**: pure `mmrBalance` (`inhouse.ts`, tested — MMR 0 =
  unknown, excluded) drives per-team "avg N" chips on the drafting columns
  and a "⚖️ X ahead by N avg MMR" line in the on-the-clock banner (sm+).
- **PRESENT players claim the ten visible slots** (pure `queueSlots`, tested).
  The grid used to index the raw queue, so away entries took slots that the
  headline count, `needed` and lobby formation itself all ignore — and on a
  fresh DB that is the DEFAULT state, because the seed enqueues six demo
  players born away: five real players rendered "5 / 10" above six dimmed demos
  with a real, counted player relegated to "In line for the next game". The
  pinned Discord board has always listed present names, so the two surfaces
  contradicted each other on the one screen that exists to convert a browser
  into a tenth player. Away entries keep their rows in whatever slots are left.
- **The vote previews rank with `orderCaptains`** — the same function
  `resolveCaptainVote` installs captains with, not a hand-copy of it. That
  needs two things, and both are load-bearing: `VoteCandidate` carries
  `joinedAt`, and the ordering is TOTAL (userId as determinism's last resort).
  All ten lobby players share one `createdAt` — they are written by a single
  `createMany` — so the earliest-queued tiebreak cannot separate them, and
  without the final key the server ranks Prisma's row order while the room
  ranks a name-sorted payload: same function, same inputs, different captains.
  Ties are the NORMAL case on a young ladder (everyone 0-0, unregistered
  players at MMR 0), and the vote's whole premise is that the card tells you
  what you are voting for.

## Inhouse betting — "Cred" (done)

Play-money wagering on inhouse games. `src/lib/inhouse-bets.ts` (pure, tested),
`src/lib/inhouse-bet-service.ts` (DB), `test/integration/inhouse-bets.itest.ts`.

**THE TRIPWIRE, first because every safety argument below rests on it: Cred is
WORTHLESS.** It cannot be bought, sold, transferred, gifted, or spent on
anything. The anti-collusion reasoning is only sound while there is nothing to
collude FOR — so the moment anyone proposes making Cred buy something real,
this whole feature has to be reconsidered from scratch, not patched.

**A player may bet ONLY on their own team, once, immutably.** That is the
anti-throw rule and it is the reason the feature is shippable at all: you can
never hold a position that pays you for losing. `@@unique([lobbyId, userId])`
is what enforces single-shot — it is the double-spend guard, not a nicety, so
two tabs cannot both charge.

**Pools are MATCHED, and that is the load-bearing economic choice.** Each
side's stakes are matched against the other's (`M = min(pool1, pool2)`), matched
Cred pays even money, unmatched Cred is returned untouched. It was chosen over
house-backed Elo odds specifically because **a payout must be funded by an
opposing stake**: a throw conspiracy can only ever win what honest players on
the throwing side voluntarily risked, where a house mints currency from nothing
with no counterparty to notice. The same property makes perfect information
worth exactly ZERO — a side that already knows it lost stakes nothing, so
`M = 0` and the winners collect nothing. That is a property of the mechanism,
not a check that can have a bug in it. **Never add odds, a house, a rake, or
any MMR/Elo input to the price**; each one reintroduces the money printer and
the MMR-sandbag exploit at a stroke (`joinQueue` trusts a free-typed MMR for
unregistered accounts, so a price that reads MMR is a price players can set).

**Bet size touches the Elo ladder in NO way, and this is not up for revisiting.**
`summarizeInhouse` keeps its exact signature; no stake is an input to any
rating. Three reasons: the expectation is the two sides' AVERAGE rating, so a
stake-scaled K lets one player's wallet move the yardstick the other nine are
rated against without their consent — precisely the class the own-team rule
exists to eliminate; it destroys the reproducibility that makes `voidLastResult`
safe (that works BECAUSE nothing is stored and every rating recomputes on read);
and the blast radius is four independent full-history scans plus the RECORD
captain-vote ordering. The visible payoff instead is a SECOND ladder — net Cred
profit, as a column beside Elo on `/inhouse`. Elo is skill, Cred is nerve, and
being #8 in one and #1 in the other is the point.

**The window opens at the DRAFTING→READY transition and closes on `betsCloseAt`
ALONE — pressing Start does not close it.** Nobody should ever be the person
who closed the ante, and Start has to stay instant. `betsCloseAt` is stamped by
`readyTransitionData(nowMs)`, which exists because there are **TWO write sites
that set `status: READY`** — `applyPick`'s advance claim and
`restoreLostPickTurn` — and wiring only the first is invisible: a lobby
recovered through the lost-turn path would arrive with betting silently off and
no error anywhere. Same shape as the standin announcement's four call sites.
One definition; don't hand-write the second. It is deliberately NOT keyed on
`startedAt`, which an interested party can push forward simply by pressing
Start later — the pick'em lesson, lock on a timestamp nobody can rewrite.

**Settlement rides `applyResult`'s existing COMPLETED claim, and its POSITION
is load-bearing in both directions.** It runs AFTER the `teamFixes` loop,
because that loop rewrites the very column the lineup void reads; and BEFORE
the full-history Elo scan, because that scan is the slow unwindowed one and the
`eloDeltas` write beneath it is the ONE write in that function that is not a
claim — money must not sit downstream of it. It is wrapped in try/catch that
logs and continues: `/api/sync` runs this chain on every page view sitewide, so
a play-money bug must never stop the Elo stamp, the cursor, the announcement,
or ten people playing Dota.

**Any check performed AFTER a claim must be computable from COLUMNS.** This is
the generalised rule and it is why `matchStartTime` is persisted into
`applyResult`'s existing claim `data` rather than passed along: the request
holding `BuiltResult` in hand is allowed to die, and the lazy sweeper has to
reach the same late-bet verdict as the fast path. Crash recovery is then
byte-identical to the happy path instead of a second, weaker implementation.

**Two voids, and they are removed BEFORE the pools are computed.** Ordering is
the whole thing — compute pools first and the survivors get matched against
money that was refunded, silently overpaying. `VOID_LINEUP`: the bettor's
post-`teamFixes` team ≠ the side they bet on. Two players swapping slots in the
hand-hosted Dota lobby would otherwise walk a big stake onto the strong side
(`classifyGame`'s side assignment is a tolerant MAJORITY vote, so a 1-for-1 swap
classifies cleanly); voiding makes a swap EV-zero in BOTH directions, so nobody
arranges one. `VOID_LATE`: placed after the played game's own `start_time` —
Valve's clock is the one timestamp ten interested parties cannot forge. A bet
that is both is labelled `VOID_LATE`, fixed and documented, because settlement
must name one outcome.

**ONE refund rule, not four.** `resolveUnsettledBets()` probes the indexed
`betSettlement` column and has three branches, each its own guarded claim:
PENDING+COMPLETED ⇒ settle, PENDING+CANCELLED ⇒ refund in full, SETTLED+CANCELLED
⇒ reverse to exact pre-game balances. **`cancelLobby`, `failReadyCheck`,
`resolveAbandonedLobby` and `voidLastResult` therefore need NO refund legs** —
they already flip the lobby into a state a branch recognises, and bolting money
into four already-hardened claims is how you get a half-refund. It runs in both
resolver chains AND in `syncInhouse` **above** the `!active && queued === 0`
early return, which is exactly the stranded-pot state: game over, everyone
closed their tabs, nobody polling. Below the return it would first fire when the
next lobby forms.

**`cancelLobby` gained the one guard on hardened code**: its IN_PROGRESS branch
now requires `bets: { none: { confirmedAt: { not: null } } }` unless an explicit
`force` is passed, because cancelling a live game is otherwise an admin undo for
a losing bet. `force` writes an `AdminAction` naming the pot. Admins are NOT
locked out on purpose — an unkillable lobby holding the single active slot for
six hours is a strictly worse failure than a logged override.

**THE RECOVERY PATHS ARE WHERE THE BUGS WERE.** An adversarial audit run *after*
the whole suite was green (1035 unit, 528 pg, 52/52 ratchet, 19+27 e2e) found six
blockers, four of which lost or minted Cred, and every suite passed against all
of them. The happy path had been tested hard and the failure paths barely. If you
extend this feature, spend your testing budget on what happens when a lobby dies,
not on what happens when it doesn't. What was wrong, and what each rule now is:

- **`applyResult`'s COMPLETED claim and its `teamFixes` loop commit in ONE
  transaction.** They used to be separate statements — harmless before betting,
  a money bug after. The claim commits alone, so between it and the end of the
  loop the row reads COMPLETED with a PENDING pot but the DRAFT roster, and
  `resolveUnsettledBets` runs on EVERY page view sitewide. A rival in that gap
  settles against the drafted sides: the wrong five get paid, `VOID_LINEUP`
  never fires, and it is permanent because settlement is single-winner. The Elo
  history scan stays OUTSIDE the transaction — it is a full-history read with no
  business holding a write open.
- **`voidLastResult` refuses while ANY lobby in `INHOUSE_ACTIVE_STATUSES` holds
  a confirmed bet.** Reversal is an unfloored decrement, so a winner who has
  already staked those winnings on the live game goes NEGATIVE. Read-time only,
  deliberately: re-asserting it at the write makes a write-skew pair with
  `placeInhouseBet` (it reads the lobby and writes a bet; this counts bets and
  writes the lobby), and SSI only spots the cycle when BOTH sides are
  Serializable — so closing a gap of milliseconds would put the hot betting path
  on Serializable with P2034 retries. The residual case now lands on a balance an
  admin can actually fix, which is the next rule.
- **`adjustCred`'s no-overdraw predicate applies to DEBITS ONLY.** It was
  `gte: Math.max(0, -delta)`, which on a CREDIT evaluates to `gte: 0` — so a
  negative balance refused the one operation that repairs it. The bug and its own
  fix were locked together.
- **`reverseLobbyBets` claws back the FLOOR top-up and DELETES its ledger row.**
  Reversing only the wager legs MINTED up to 100 Cred: a player floored after a
  loss kept the top-up when the game was voided. Deleted rather than offset
  because `refId` is `<userId>:<utc-day>` and the `@@unique` IS the once-a-day
  rule — an offsetting row leaves the key burned, punishing the player for an
  admin's void.
- **`applyFloor`'s balance write is a compare-and-swap, and its receipt follows
  the movement.** It is the ONE absolute assignment in the money layer
  (everything else is a relative `{ increment }`) over a row the transaction has
  not written, so under READ COMMITTED an admin `adjustCred` in the gap was a
  lost update. `count === 0` SKIPS — not a throw, because the settlement it runs
  inside is already correct and losing a top-up costs a player 100 play-money
  Cred where a lost update costs the books their integrity.
- **`ensureCredAccount` wraps the account create and its GRANT receipt in one
  transaction.** They were two statements under a comment claiming "the unique
  makes the retry free" — wrong about its own function, because the
  `if (existing) return` fast path above means there IS no retry. A death between
  them left a funded account with no provenance, permanently.

**Two coverage limits, stated because "no test moved" is what a gap looks like
too.** `applyFloor`'s CAS-declines branch needs a rival committing inside
settlement's own transaction and there is no seam in `inhouse-bet-service.ts` to
steer one, so it is pinned by a `[source]` assertion (the
`room-source-guards.test.ts` precedent) rather than a behavioural test — verified
non-vacuous by restoring the absolute write and watching only the source guard go
red. Replace it with a real test if a seam ever lands there. And the FIX 1 race
is pinned by two tests: a SQLite-runnable one asserting the sweeper finds nothing
to mis-settle, plus a Postgres-only second-connection test that is skipped
everywhere else — `npm run test:pg` is the only thing that runs it.

**Deliberate deviations from house style, each with its reason:**
- **`InhouseCredit.balance` is a MUTABLE column, not a SUM over the ledger.**
  Against this repo's derive-don't-store idiom, and forced: the affordability
  test has to be re-asserted in the WHERE of the debit itself
  (`balance: { gte: stake }`), and you cannot atomically re-assert a SUM in one
  Prisma statement. The ledger is provenance; the column is the claim.
- **The payout `{ increment }` is BLIND, and must stay that way.** The
  settlement claim already elected exactly one winner, so there is no rival —
  same reasoning as `Team.budget`. Do not "fix" it into a conditional write;
  that would make settlement non-idempotent in the wrong direction.
- **The `RETURN` ledger leg carries the WHOLE stake, not just the unmatched
  part** (despite what the reason's name suggests). `credProfitBoard` sums
  `{STAKE, RETURN, WIN, LOSS, REFUND, REVERSAL}`, so STAKE(−s) and RETURN(+s)
  must cancel for the board to reduce to net profit. Any split where RETURN is
  partial makes the board read 0 for every winner.
- **The once-a-day floor uses a `findUnique` probe, not a P2002 catch.** Inside
  an open interactive transaction a P2002 POISONS the transaction on Postgres
  (`current transaction is aborted`). The `@@unique([reason, refId])` is still
  the real guard — a genuine collision rolls the settlement back and the
  sweeper's retry sees the row.

**The profit board ranks NET PROFIT, never balance** — `INHOUSE_CRED_PROFIT_REASONS`
excludes `GRANT`, `FLOOR` and `ADJUST` for that reason. It is what makes the
bankruptcy floor safe: a player parked at the floor mints liquidity but can
never mint SCORE, so the designated-donor farm has nothing to farm, and
attendance stops being rankable. **Never add a "total staked" board beside it** —
volume is the one number a bet-max-every-game behaviour farms perfectly.

**`MAX_STAKE` is FLAT at 100 forever, never a fraction of balance.** A newcomer
and the ladder leader cap out at the same number on night one (so the economy
cannot compound into a rich-get-richer spiral), and a conspiracy's take is
bounded at five stakes per game.

**The pinned Discord board carries the pot ONLY in the frozen LIVE state.**
THE DIGEST IS THE COST MODEL — put a live pot or a countdown in it and the board
burns one PATCH every `BOARD_MIN_SECONDS` forever, on the message whose entire
design is "a motionless queue costs zero requests". Both digest builders
(`loadBoardSnapshot` and `getInhouseState`) must agree on null-vs-0 for a
bet-free lobby, or alternating paths repaint each other in a loop.

**The ratchet caught the overdraft guard being untested, and the reason is the
one this file keeps re-learning.** `placeInhouseBet`'s
`balance: { gte: stake }` came back `[unprotected]` on the first discover even
though a RACED overdraft test existed — because that test raced one player
against THEMSELVES on one lobby, where `@@unique([lobbyId, userId])` stops the
loser first: its bet-create raises P2002, which rolls back its own transaction,
debit included. The balance predicate never fires, so deleting it changes
nothing. **"Something upstream serializes this" only ever covers rivals from
the SAME path.** The rival from a different path is `adjustCred` — an admin
correcting a balance while that player places their FIRST bet meets no unique
constraint at all, and unguarded the account goes NEGATIVE (verified: −100),
a state nothing else can produce and whose only symptom is a player later
unable to bet for no visible reason. That test now exists; deleting the
predicate turns it red.

**Known gaps** (deliberate, stated rather than hidden): two friends splitting
winnings out of band is unfixable and mostly harmless (the currency buys
nothing, and net-profit ranking drives an alternating arrangement to ~0 for
both); a thrower can hold no position and let a confederate collect, bounded at
500 Cred in a game where nine people watch him feed and his Elo takes the real
hit; and a stake can be locked for 3–6 hours if a lobby is abandoned rather than
played — refunds make that EV-neutral, and the room SAYS SO at bet time rather
than letting someone discover it.

## Draft edge cases (done)

- Nomination auto-skip: `resolveStalledNomination` nominates the top available
  player at min bid when the nominator's clock runs out — but only if the team
  can actually pay. It was the ONE nomination path with no affordability check
  (nominatePlayer and placeBid both refuse an unaffordable amount), so it would
  open a MIN_BID lot for a broke team and `resolveExpiredNomination` charged it
  unguarded, leaving a NEGATIVE budget. Pure `canNominate` (`draft.ts`, tested)
  = needs a player AND `maxBid >= minBid`; the resolver advances via its existing
  full-roster branch when it fails, and `nextNominatorIndex` requires it too so
  advancing can't cycle forever. -1 still means draft-complete. In a healthy
  auction this is a no-op (maxBid maintains the invariant on every purchase).
  (An earlier version of this line claimed a "150-run randomised auction fuzz"
  pinned it. There is no such test in the repo and there never was — the
  2026-07-31 audit caught it. What exists is draft.itest.ts's broke-nominator
  and pool-dry cases. Don't cite coverage without grepping for it.)
- Pool-dry completion: if signups run out mid-draft, both resolvers mark the
  draft COMPLETE (short teams play with standins) instead of stalling forever.
  `startDraft` warns in its success toast when seats outnumber the pool.
- `recordResult` validates scores against the match's `bestOf` via pure
  `seriesScoreError` (`standings.ts`); partial results/forfeits are allowed.
- Cancelling an inhouse lobby re-queues its 10 players with a backdated
  presence heartbeat — a fresh captain vote forms once the players still on
  the page have re-confirmed via their own polls (ghosts drop out instead).

## Draft hardening (2026-07 — keep these invariants)

- **Every draft transition is a guarded claim** (the inhouse bar):
  `resolveExpiredNomination` claims the exact-nomination clear before awarding
  (two pollers → ONE sale/decrement/announcement); it also VOIDS the lot (no
  charge, rotation still advances) if the player's registration went
  non-ACTIVE mid-auction. `resolveStalledNomination` claims the
  auto-nomination AND both completion/advance branches (no duplicate opening
  Bid rows, no double draft-complete announce), and advances the rotation
  instead of freezing if the on-clock team is somehow already full.
  `nominatePlayer` claims `{nominatedUserId: null}` so it can't replace a
  live lot. `placeBid` already had the optimistic lock — keep the pattern.
- **withdrawSignup refuses the player currently ON THE BLOCK** (live/paused
  draft) — otherwise every room renders a headless auction and the expiring
  lot charges a team for a withdrawn player (the resolver void above is the
  belt-and-braces).
- **setSeasonPhase refuses to leave DRAFT while the auction is IN_PROGRESS**
  — a phase flip mid-auction strands every captain.
- **Admin night-of controls**: `pauseDraft`/`resumeDraft` (PAUSED parks the
  clocks; resolvers/bids all key off IN_PROGRESS so nothing can sell; resume
  restarts the live lot's clock at full length) and `undoLastSale` (delete
  the newest non-captain TeamMember, refund the budget, hand the buyer the
  next nomination; works from COMPLETE — re-opens the draft; refused while a
  lot is live). Buttons in the admin Captains & draft card.
- **`undoLastSale` targets the newest AUCTION PURCHASE, not the newest roster
  row** — filtered on `price > 0`, which is EXACT rather than a heuristic:
  non-captain rows are created in exactly two places, `resolveExpiredNomination`
  at `draft.currentBid` (floored at `MIN_BID` = 1) and `signFreeAgent` at a
  hard-coded 0. A pool-dry draft leaves the season in DRAFT where Sign free
  agent is legal, so without the filter undoing a disputed lot deleted the $0
  signing instead — refunding nothing, leaving the disputed sale standing, and
  re-opening the auction anyway. Because it can therefore skip past newer
  signings, the toast NAMES the purchase it reverted (player → team, price);
  don't reduce that back to a generic "Sale undone".
- **`undoLastSale` re-asserts "no live lot" AT THE WRITE, and THROWS if it
  lost** (2026-07 Postgres pass). It checks `nominatedUserId` at its read, then
  runs four more statements — roster delete, Bid sweep, budget credit, team
  scan — before writing the draft, and that gap is genuinely reachable: the
  draft-night sequence is a disputed sale, a minute of captains arguing, the
  nomination clock expiring, a poller's `resolveStalledNomination` opening a
  fresh lot, and THEN Undo landing. The blind `update({ where: { seasonId } })`
  stamped status + nominator + a fresh `nominationEndsAt` over the top while
  leaving that lot's `nominatedUserId`/`currentBid`/`bidEndsAt` intact, so the
  draft held a LIVE AUCTION and a RUNNING NOMINATION CLOCK at once — states the
  engine treats as mutually exclusive. `resolveExpiredNomination` would then
  sell that player to a team that never nominated them and advance the rotation
  from the nominator Undo had just repointed. Reproduced 11 times in 12 on
  Postgres; zero after. It must THROW rather than return, for the same reason
  the inhouse turn claim does: the refund and the roster delete are already
  written, and a `return` from a Prisma interactive transaction COMMITS them —
  money back, player gone, sale never undone. Caught outside the callback.
  Pinned by a RACED test in `abort-draft.itest.ts` (staging the lot up front
  passes against the broken code — the read-time check catches it — so the
  test has to be concurrent, which means `npm run test:pg` is what runs it for
  real).
- **`abortDraft` is the way back from a premature "Start draft"** (the draft's
  equivalent of "Reset playoffs"). Nothing else ever writes `Draft.status` back
  to NOT_STARTED, and addCaptain/removeCaptain/randomizeDraftOrder/
  setDraftSettings all refuse once it has moved off — so starting with 2 of 8
  captains used to cap the season permanently, recoverable only by creating a
  new season (which archives every registration). In ONE tx it claims the status
  flip (guarded `updateMany` on the status it read), deletes non-captain
  TeamMembers, credits each team back exactly what those rows cost, clears the
  draft's Bid rows, and drops the season to SIGNUPS — which is what reopens
  captain management AND lets the late players it exists for register at all.
  **Captains and Team rows are deliberately KEPT.** Refuses once ANY match is
  COMPLETED or ANY Game exists (rosters are load-bearing for standings/box
  scores/brackets by then — dissolving them isn't a recovery); the button's
  visibility mirrors that exact predicate so it never appears where the action
  would refuse. Not phase-gated on purpose: recovering a season whose phase
  already moved is the point. Captain rows keep a nonzero `price` after
  `transferCaptaincy` and are correctly NOT credited (that player is still
  rostered). Pinned by a raced test: raceN(4) simultaneous aborts tear down
  once (draft.itest.ts — an earlier version of this line said "8" and nothing
  pinned it). The placeBid / resolveExpiredNomination pairing was hand-verified
  during the hardening pass but is NOT pinned by any test — don't cite it as
  coverage (the 2026-08-01 audit caught exactly that citation drift here).
- **setSeasonPhase refuses to leave DRAFT while the auction is PAUSED** (parked
  is not finished) and refuses to move BACKWARD into DRAFT once the draft is
  COMPLETE and any result exists — **counting imported GAMES as well as decided
  series**, the same pair `abortDraft` and `generateSchedule` use, because
  auto-sync makes "one series LIVE at 1-0" routine on opening night and counting
  only COMPLETED left the auction re-armable for exactly those hours. Otherwise
  `undoLastSaleAction` (gated only on
  `season.status === DRAFT`) becomes callable again and re-arms the auction
  against a live league, where `resolveStalledNomination` auto-sells an
  undrafted signup onto a mid-season roster on the next poll from any visitor.
  Coverage in `test/integration/season-phase.itest.ts`.
- **/draft page gates ONLY on "no active season"** — never on season.status:
  the league parks there during SIGNUPS and a static gate never learns the
  admin hit start. The room's poll handles waiting → live → complete.
- **Room correctness**: poll/action responses are sequence-ordered (a slow
  tick must not clobber a fresher bid response); the outbid latch is NOT
  cleared just because the captain is priced out (they most need to see it);
  a `selected` pool player who got drafted is auto-cleared. `/api/draft/tick`
  has the standard per-IP `rateLimit` speed bump.
- **Draft-night UX added**: per-lot "Bid trail" (from the Bid audit table,
  served as `lotBids` in state), "next: <team>" nominator preview,
  budget-after-win line under the bid controls, quick-bid steppers show the
  absolute amount they'll submit, Max-bid + admin-auto-nominate confirms,
  paused strip, Discord `draftRecapMessage` (biggest buy/steal/top spender
  via the tested draftRecap lib) sent after draft-complete, and
  `setDraftNight` no longer re-announces an unchanged timestamp.
- **e2e**: `zz-admin-draft.spec.ts` registers two KNOWN captains and drives a
  real nominate → quick-bid → 💸 outbid → re-bid in two browser contexts
  (plus waiting-room flip-to-live with no reload). The compact clock bar has
  NO aria-label on purpose (content = accessible name) — target it by title.

## Discord notifications (done)

- `src/lib/discord.ts` — pure message formatters (unit-tested) +
  `sendDiscordMessage` (best-effort POST to an incoming webhook, 5s timeout,
  never throws). Webhook URL: `Setting` table key `discordWebhookUrl`
  (`src/lib/settings.ts`, admin panel card with save/validate/test) with
  `DISCORD_WEBHOOK_URL` env as fallback.
- **The webhook URL is a bearer credential (anyone holding it can post to the
  channel — prime phishing bait) and is NEVER sent to the client.** The admin
  card renders only a boolean + a masked fingerprint from pure `maskWebhookUrl`
  (`discord.ts`, tested — hides the secret token, keeps a short id hint); the
  input starts EMPTY (no `defaultValue`). Because the field is blank on purpose,
  `setDiscordWebhook` treats a blank submit as a no-op (never a wipe); turning
  announcements off is the explicit `clearDiscordWebhook` action + Remove
  button. Env-managed webhooks (`DISCORD_WEBHOOK_URL` only, no DB row) show a
  note and hide Remove (clearing the DB key can't touch env). Regression guard:
  don't reintroduce any client render of the raw URL.
- Announces: new player signups (with countdown to the draft threshold), draft
  started (`startDraft`), every auction sale (`resolveExpiredNomination`,
  captured in-tx and sent post-commit — one message per sale, idempotent),
  draft complete (both draft-service resolvers), match results — every decided
  series announces via `announceSeriesResultOnce` (`match-import.ts`, fired
  from `recomputeSeries` on the transition to decided, idempotent through an
  atomic `resultAnnounced:<matchId>` Setting CREATE; admin `recordResult`
  always sends but upserts the same marker so a later game import can't
  double-post), playoff bracket (`startPlayoffs`), the champion
  (`advancePlayoffBracket`), and inhouse moments: lobby formed
  (`maybeFormLobby`, captured in-tx/sent post-commit) plus a "queue is two
  short" ping (`joinQueue` — fires only on an upward crossing of
  `LOBBY_SIZE-2` present players, never on the lobby-forming join, throttled
  via the `inhouseQueuePingAt` Setting to one per `QUEUE_PING_MIN_MINUTES`).
  The inhouse room also flips `document.title` ("(!) Your pick…") while the
  viewer's attention is needed — works without the sound toggle/audio unlock.

## Discord notifications that actually notify (done)

The board informs but structurally CANNOT notify (edits produce no
notification, no unread, no bump), and every send hard-set
`allowed_mentions: {parse: []}` — so for a while nothing in the integration
reached a player who wasn't already looking at it.

- **`MentionAllowlist` (`discord.ts`)** — an OPTIONAL per-send
  `{roles?, users?}` id allowlist threaded through `sendTo`. `parse: []` stays
  on every send, so a Steam persona of "@everyone" is still inert: only ids the
  SERVER chose can ring a phone. The shape Discord rejects is `parse`
  CONTAINING "roles"/"users" alongside the array — an empty parse plus an
  allowlist is the documented "these and nothing else".
- **`INHOUSE_PING_ROLE_ID` Setting** (admin field, accepts a raw snowflake or a
  pasted `<@&id>`). Unset = nothing pings, the old behaviour. **The role must be
  SELF-ASSIGNABLE** — a ping people can't opt out of gets the channel muted,
  which is permanently worse than silence. Only the two INTERRUPTING messages
  carry it (queue filling, match found); never results, never the board.
- **`maybeFormLobby` mentions the ten by `<@discordId>`** where they linked,
  plain escaped text where they didn't. Queueing thirty seconds ago IS the
  consent — don't "fix" this with an opt-out later. This is the payoff for
  OAuth linking: `discordId` stops being a cosmetic ✓. A formed lobby is the
  scarcest thing the league produces and `ACCEPT_SECONDS` is 45, so one
  tabbed-away player burns a lobby that already cleared the hard part.
- **`INHOUSE.QUEUE_PING_AT` (4), was `LOBBY_SIZE - 2` (8).** Eight is a
  threshold the queue essentially never reaches unaided: the first person to
  queue is invisible to anyone not already on the site, so the ping meant to
  pull people in sat downstream of the problem it exists to solve. Raise it if
  it starts crying wolf; `QUEUE_PING_MIN_MINUTES` is the other knob.
- **`/inhouse?join=1`** — every ping deep-links into the queue (`joinLink()`).
  The room auto-joins ONCE per page load behind a ref, scrubs the param via
  `history.replaceState` so a refresh can't re-enqueue, and refuses when
  signed out, already queued, or a lobby is live (never drop someone into a
  45-second ready check from a standing start). The `act()` call is deferred a
  tick — setting state synchronously in an effect cascades a render.

- **Self-serve ping opt-in** (`src/lib/discord-roles.ts`, integration-tested
  over real HTTP): Discord has NO native self-assignable-role toggle, so the
  site grants the role itself — `PUT/DELETE /guilds/{g}/members/{u}/roles/{r}`
  with a bot token. This is the ONE place a bot token is used and it stays
  tiny: no gateway, no process, no slash commands. Token + guild are ENV (never
  the Setting table — an admin page must not be able to read a token back); the
  role id is a Setting. Missing any piece = the feature is invisible, never
  half-working. `hasPingRole` returns `boolean | null` and **null means UNKNOWN,
  never false** — showing an unticked box to someone already opted in makes them
  click it and change nothing, which reads as broken. State is read LIVE rather
  than mirrored into a column, which would drift the moment someone removes the
  role in Discord. A 403 is surfaced as its own outcome: it means the bot's role
  sits below the ping role, retrying never fixes it, and the message must say so
  rather than blaming the player's click.

- **`GET /guilds/{g}/members/@me` IS NOT A ROUTE.** `@me` is accepted only on
  PATCH there; on GET it fails snowflake coercion and returns **400** with
  `Value "@me" is not snowflake` — as perfectly valid JSON. The first version
  of the health check parsed that as a member object, got `roles: undefined`,
  defaulted the bot's height to 0, and reported "can't grant" on EVERY server
  while also claiming "bot in server" (it only branched on 403/404, so a 400
  fell through to the success path). To read its own roles a bot must
  `GET /users/@me` for its id, then `GET /guilds/{g}/members/{thatId}`.
  **Branch on `res.ok` for every Discord call** — an error body that parses
  proves nothing.
- Granting a role needs BOTH hierarchy and permission: the bot's HIGHEST role
  strictly above the target (equal position is refused), AND MANAGE_ROLES or
  ADMINISTRATOR — Administrator does NOT bypass hierarchy. `permissions` is a
  STRING bitfield, so `BigInt("268435456")`, never a `1n << 28n` literal
  (tsconfig targets ES2017).
- The panel renders the raw positions, not just a verdict. A boolean with
  nothing to check it against is precisely how the broken version stayed
  invisible.
- **`getPingHealth` + the admin checklist** — the opt-in has FOUR independent
  ways to be half-configured and three are invisible until a player clicks the
  button and gets an error. The one worth its extra API call is `canGrant`:
  Discord silently refuses to let a bot assign a role positioned ABOVE its own,
  the portal never warns you, and the first symptom is otherwise a confused
  player days later. Computed from `/guilds/{g}/members/@me` (the bot's roles)
  vs `/guilds/{g}/roles` (positions), bot height = its HIGHEST role. The panel
  shows the first broken step and its exact fix, in the order they must be
  fixed. Missing env is reported WITHOUT calling Discord at all.

- **`getDiscordReach` — the denominator.** Every notification the league sends
  (personal mentions on lobby formation, the un-RSVP'd ping below, the opt-in
  role) SILENTLY skips anyone who never linked Discord, so "N of M registered
  players have linked" is the number that says whether that machinery reaches
  the league or six people. Deliberately a plain DB count over the @unique
  `discordId` — no Discord calls, cannot fail. Below 50% the admin card says
  to chase links rather than build more notifications, because that is the
  actual next move.
- **The week reminder MENTIONS the people who owe an answer.**
  `teamAvailability` gained `unansweredUserIds` (the ids behind the count it
  already reported — anything that isn't a valid IN/OUT counts as no answer,
  so the list and the count can never disagree). `maybeAnnounceUpcomingWeek`
  resolves those to `<@id>` for linked players and plain names for the rest,
  and passes ONLY those ids in the `MentionAllowlist`. Teammates who already
  checked in get nothing. This is the cheap version of "mirror rosters into
  per-team Discord roles" — same targeting, no mirrored Discord state, none of
  the reconcile debt. Don't build the roles version; the argument against it is
  already written at the top of `discord-roles.ts`.
- **Every announcement that ENDS BY NAMING AN ACTION now mentions the person
  who has to take it** (`src/lib/discord-mentions.ts`). `sendDiscordMessage`
  had accepted a `MentionAllowlist` since the mention work landed, but only the
  queue ping and the week reminder ever passed one — so the four messages that
  literally say "captains: line up a standin" / "the other captain can respond"
  notified NOBODY. They were the largest remaining seam in the integration.
  Targets, and the reasoning behind each: a player's OUT → **their captain**
  (who finds the cover; never the captain about their own withdrawal); standin
  assigned/removed → **the standin** (being told to turn up for a game is the
  most action-demanding message the league sends); reschedule proposed → **the
  opposing captain**; reschedule accepted → **the proposer**, who asked and has
  been waiting. Never a broadcast: a withdrawal is not the rest of the league's
  problem, and a notification people can't act on is what gets a channel muted.
  `mentionsOf` (pure, tested) exists so no call site hand-rolls the null
  filtering and builds `{users:[undefined]}`, which Discord rejects silently
  because every send is best-effort; it returns `undefined` rather than
  `{users:[]}` so a league where nobody has linked sends byte-for-byte what it
  sent before. Only `discordId` is mentionable — the typed `discordName` is a
  string a captain copies by hand and no amount of it makes someone pingable.
  Services return `mentions`/`notifyUserId` and the ACTION does the send, so a
  webhook failure still can't touch the write. NOTE the assign/remove
  announcement has FOUR SEND sites (`standins.ts` ×2 AND `admin.ts` ×2) — miss
  one and the admin path silently stops notifying. The STAND-DOWN message
  (`standinRemovedMessage`) is sent from EVERY path that kills a booking or
  its fixture: both removeStandin paths (one builder site in
  `standin-service.ts` — the actions send it), `releasePlayer`,
  `signFreeAgent` (last-seat cleanup), `generateSchedule`, `startPlayoffs`
  (bracket rebuild), `withdrawTeam`, `recordResult` (forfeit ruling, zero
  games), and `abortDraftAction`. Eight builder call sites in src as of
  2026-08-02 — `grep` before claiming a number here; a cover-killing path
  that doesn't send one is a bug (the standin keeps a live @-mentioned
  instruction to show up for a dead fixture).
- **Every player/team name in an announcement goes through
  `escapeDiscordText`** (`src/lib/discord-escape.ts`, tested; `discord.ts`
  aliases it to `name`). Discord renders markdown in WEBHOOK messages and,
  unlike user-typed messages, does NOT suppress masked links there — so a
  Steam persona of `[free mmr](https://evil.test)` arrived as a live link that
  read as league-authored. This lived only in `inhouse-board.ts` because that
  message is pinned; correct about the board, wrong about everything else. The
  board keeps its own wrapper, since the TRUNCATION is board-specific (fixed
  height rack) while the escaping isn't. NOT applied to admin-authored text
  (news bodies, season names) — an admin writing `**bold**` means it, and
  `newsMessage` emits a bare media URL on purpose so the GIF embeds. `<@id>`
  MENTION markup is never escaped, only the plain-name fallback beside it;
  `discord.test.ts` sweeps every formatter for `](` and pins both.
- **`sendTo` pins v10 via `webhookApiUrl`.** It fetched the raw webhook URL,
  so all ~28 announcements rode Discord's unversioned default (v6, deprecated)
  while the board's transport had always pinned v10 — the same webhook string
  reaching Discord two different ways.
- **`RSVP_OUT_PING_THROTTLE_SECONDS` backs up the was-it-already-OUT check.**
  `prior?.status !== "OUT"` misses OUT→IN→OUT while a player decides. That was
  a duplicate line in a channel; now that the message mentions the captain it's
  a repeat phone buzz, so `setAvailability` also claims
  `outPing:<matchId>:<userId>` via `claimThrottle`.
- **Unlinking Discord strips the inhouse ping role** (`unlinkDiscord` reads the
  snowflake BEFORE clearing it, then best-effort `setPingRole(…, false)`).
  Leaving it behind was the worst outcome that action had: the player keeps
  getting pinged AND the toggle that turns it off renders only inside the
  `discordId` branch, so they'd just thrown away their own off switch — exactly
  the un-opt-out-able ping the design refuses to ship. `failed`/`forbidden`
  says so in the toast rather than claiming success. The re-linking half of
  this (a DIFFERENT account replacing the linked one) is closed the same way:
  `linkDiscordAccount` returns the previous id and the callback's injected
  `stripPingRole` dep takes the role off it, best-effort after the link
  commits (see the guild-membership entry).

## Live inhouse queue board (done)

**THREE webhooks, and the third one matters more than it looks.** The queue
BOARD gets its own channel (`inhouseWebhookUrl`) and inhouse ALERTS — the queue
ping, "match found", results — get another (`inhouseAlertWebhookUrl`,
`getInhouseAlertWebhookUrl`, falling back to the board's webhook when unset).
The board is a message read at a glance from the BOTTOM of its channel, so a
single alert posted under it pushes it out of view and defeats the entire
design; that surfaced the first time a real queue hit four players. Board
transport keeps `getInhouseWebhookUrl`; `sendInhouseDiscordMessage` uses the
alert resolver. Changing the ALERT webhook must never disturb the board — its
webhook id is untouched, so no strand detection fires.

**Inhouse has its OWN optional webhook** (`inhouseWebhookUrl` Setting /
`DISCORD_INHOUSE_WEBHOOK_URL` env, `getInhouseWebhookUrl`, falling back to the
league webhook when unset). A Discord webhook is bound to the channel it was
created in, so one webhook meant the queue board landed wherever league
signups and results go — it shipped into #welcome. Everything inhouse posts
(`sendInhouseDiscordMessage`: lobby formed, the two-short ping, results, and
the board) routes through it; the other 27 announcement types keep using
`sendDiscordMessage`. Changing EITHER webhook tears the board down first when
that webhook is the one the board rides, so it can't be stranded in an old
channel.

ONE pinned Discord message showing the live queue count, rewritten IN PLACE —
a live counter that never posts a second message. Pure render in
`src/lib/inhouse-board.ts` (tested), service in `inhouse-board-service.ts`
(reminder-service pattern, `test/integration/inhouse-board.itest.ts`),
transport in `discord.ts` (`postWebhookMessage`/`patchWebhookMessage`/
`deleteWebhookMessage`, real-HTTP tested in
`test/integration/discord-webhook-transport.itest.ts`). Admin posts/removes it
from the Discord card; no bot, no new credential — it rides the webhook URL
already in the `Setting` table.

- **The `inhouseBoard` Setting row IS the on/off switch** (JSON
  `{webhookId, messageId, digest}`). No row = feature off, and "off" costs one
  PK read on the poll path. Don't add a separate toggle — it would drift from
  the message that actually exists in Discord.
- **`?wait=true` is mandatory on the POST.** Without it Discord answers 204
  with no body, and there is NO endpoint to look the id up afterwards — a
  message sent without it can never be edited again.
- **`allowed_mentions: {parse: []}` must be repeated on every PATCH, not just
  the POST.** Discord rebuilds a message's mention list from scratch on each
  edit and parses it with DEFAULT allowances, ignoring what the original send
  asked for. Drop it and a Steam persona of `@everyone` mass-pings the server
  on the board's next repaint — from a message that is pinned forever.
- **Design is "Find Match"** — it borrows Dota's own matchmaking script (Find
  Match → Searching → Match Found → Preparing → live) so every state name is a
  phrase the reader already knows. Two glyphs carry the whole visual language:
  `▰` taken, `▱` open — horizontal where there are no names, vertical (Dota's
  lobby slot list) where there are. **The trailing `▱ open` rows ARE the call
  to action**; at 9/10 a column of nine names above one open slot is the most
  persuasive thing the channel can render. The slot list is also the only
  name layout immune to a 32-char persona: one player per row, fixed height.
- **NO EMOJI, deliberately.** The message is pinned, edited in place and alone
  in its channel — permanently on screen. Decoration on a permanently-visible
  surface becomes wallpaper within a day and drags the information beside it
  down too. The 4px colour bar does that job instead and can't go stale through
  familiarity, because it carries information rather than sitting next to it.
  Colour is the ONLY chromatic element, which is what makes dropping emoji
  costless. LIVE red means "broadcast", never Dire — which side is Radiant
  isn't known until the match imports, so nothing is ever side-labelled.
- **The EMPTY state is the product.** It is ~95% of views, and a bare 0/10
  reads as a dead league. `BoardStats` (last result + MVP, all-time lobby
  count, ladder #1) is the proof-of-life, loaded ONLY for that render and
  memoised in-process on a 60s TTL (`loadBoardStats`) because it scans full
  history for Elo. Every figure is monotonic or completes-with-a-state-change —
  NEVER a trailing window like "games this week", which would silently rot
  through the exact quiet stretch it exists to paper over. Anything missing is
  OMITTED, never faked: a league with no games shows no stat row at all.
  That state also carries NO "updated <t:R>" line on purpose — its digest
  barely moves, so after a quiet weekend it would read "updated 3 days ago",
  the single most off-putting thing a conversion surface can say.
- **`escapeMarkdown` strips newlines FIRST, before truncation.** The rack is
  one player per LINE, so a persona containing a newline would forge phantom
  rows and make the board lie about its own count. Ordering is load-bearing.
- Do NOT put `brand/banner.png` on this board. It reads "UNDER 4.5K LEAGUE ·
  sub-4500 MMR" — a drafted-league eligibility gate that does not apply to
  inhouses, on the state a stranger sees 95% of the time.
- **The digest is the cost model.** It hashes SEMANTIC state only and excludes
  the clock; elapsed time renders as `<t:…:R>`, which keeps counting in every
  client with no further edits. Put anything time-varying in the digest and the
  board silently burns one PATCH every `BOARD_MIN_SECONDS` forever, on an empty
  queue. A motionless queue currently costs zero requests — verified live.
- **`syncInhouse` repaints the board on its EARLY-RETURN path too** (queue
  empty AND no lobby). Nothing else runs in that state — the resolvers are
  skipped and no one is polling the room — yet it is the state the board is
  most likely to be lying about: a game that just ENDED leaves the board
  reading "game in progress", and the last player can leave and close the tab
  in one breath. Pinned by `runResultSync` tests in
  `test/integration/inhouse-board.itest.ts`; don't drop it.
  Separately, `syncInhouse`'s `watch` includes a non-empty PRESENT queue, not
  just a live lobby — sitewide pingers used to idle at 300s through the whole
  fill, which is the stretch that decides whether a game happens.
- Board freshness ultimately tracks SITE TRAFFIC, and the queue shrinking is
  the weak direction: going "away" writes nothing (presence is classified at
  read time from `lastSeenAt`), so a decay is only noticed when some request
  happens to run.
- **The board is NEVER synced on a mutation.** `/api/inhouse` answers every
  mutation with a `getInhouseState` payload, so without
  `getInhouseState(user, { syncBoard: false })` the player who pressed ACCEPT
  is exactly the request that renders the changed digest, wins the edit claim
  and blocks on Discord — on the 45s ready check. Measured with a deliberately
  slow Discord: join 75ms, the poll behind it 2.0s. The client's own poll
  (~250ms later via `bumpPollRef`) carries the board instead.
- 404/401/403 on the PATCH is PERMANENT (`"gone"`): drop the row and stop.
  It never re-posts — deleting the message in Discord is the natural "turn it
  off" gesture, and a self-resurrecting message would be exactly the spam this
  feature avoids. 429/5xx is `"failed"`: keep the OLD digest (so the next poll
  retries) but bump a `failures` counter.
- **The digest write-back is a compare-and-swap** (`swapState`) on the exact
  previous row value: the row is read BEFORE a round trip of up to 2.5s and
  written after, so a blind upsert would resurrect a board an admin removed
  mid-flight.
- **Health must not flatter itself.** `lastEdit` on the admin card is
  `lastOkAt` — stamped only when Discord ACCEPTED an edit — never the throttle
  timestamp, which is written when the claim is won, i.e. before the request,
  and so keeps looking healthy while every edit fails. The card also renders
  the LIVE queue (`boardStateLabel`) plus an `inSync` digest comparison, which
  is the only way to answer "is the channel lying right now?".
- **Removal reports honestly** — an orphan (row forgotten, message still
  pinned and now unreachable) is the worst end state this feature has, and the
  next "Post" would add a SECOND board beside it. So: Discord confirmed → ok;
  refused → row KEPT and the admin told to retry; `force: true` (used by
  `setDiscordWebhook`/`clearDiscordWebhook`, where the credential is about to
  stop working) → always clear and report `orphaned` so the toast can say
  "delete that message by hand". A STRANDED board never routes through
  `deleteWebhookMessage` at all: that endpoint is scoped to the sending
  webhook, so it would 404, which the transport correctly reads as success.
- Swapping the webhook to a DIFFERENT channel strands the message;
  `setDiscordWebhook`/`clearDiscordWebhook` tear the board down FIRST, while
  the old credential is still the configured one. A regenerated token keeps the
  same webhook id, so that case correctly survives (`webhookIdOf`).
- **The board informs; it does not convert.** Edits produce no notification and
  no unread. The `LOBBY_SIZE-2` `@`-ping in `joinQueue` is still the only thing
  that actually gets a ninth player to queue — keep it.
- KNOWN LIMIT: with nobody on the site at all, nothing runs and the board
  freezes. The `updated <t:…:R>` line makes that visible rather than hidden;
  the README's optional uptime monitor on `GET /api/sync` is what actually
  bounds it.

## Match-night check-in (done)

- `MatchAvailability` model (matchId+userId unique, status IN|OUT). Pure
  summary math in `src/lib/availability.ts` (`teamAvailability`, tested).
- Players RSVP via the shared `<CheckinBanner>`
  (`src/components/checkin-banner.tsx`) rendered on the dashboard
  (`MyNextMatch` in `page.tsx`), `/schedule`, and unplayed `/matches/[id]`
  pages (`setAvailability` action — rostered players and assigned standins
  only, no completed matches). Schedule match rows show per-team ✓/✗ counts
  while a match is unplayed.
- Admin standin card flags players who declared OUT and aren't covered by an
  assignment yet, right above the assign form.
- **Match-night Discord reminder**: `src/lib/reminder-service.ts`
  (`maybeAnnounceUpcomingWeek`) — lazy, fired by the invisible
  `<WeekReminderPing>` server component (own `<Suspense fallback={null}>`) on
  the dashboard and /schedule. Announces the next week's unplayed fixtures
  once kickoff is within `WEEK_REMINDER.AHEAD_HOURS` (24h ahead, up to 3h
  after) with `<t:epoch:R>` kickoffs and standin-aware check-in counts (same
  `matchNightRoster`/`teamAvailability` as /schedule). Idempotent via an
  ATOMIC `weekReminder:<season>:<week>` Setting CREATE (P2002 ⇒ already sent
  — the trigger is concurrent page loads; honors uses the same atomic
  pattern since auto-sync made its triggers concurrent too).
  The send is awaited (serverless kills orphans).
  Integration-tested in `test/integration/reminders.itest.ts`.

## Returning-player prefill (done)

- `/me`: when a player has no registration for the active season but does
  have one from a past season, the signup form defaults (MMR, roles, heroes,
  statement, captain note, type, wants-captain) come from the most recent
  prior registration, with a "Welcome back — prefilled from Season N" hint.
  Registration state (`isRegistered`, badges) still keys off the active
  season only.

## Player career history (done)

- `/players/[id]` has a "Seasons" card: every rostered season (newest first)
  with team, captain badge / draft price, team W–L(–D) via `resultFor`, 🏆 on
  championship seasons, and a titles count in the subtitle. Links to
  `/seasons/[id]` and `/teams/[id]`.

## Season history (done)

- `/seasons` — every season newest-first (phase badge / Current, champion,
  team/signup/match counts). `/seasons/[id]` — champion banner, final
  standings, playoff rounds, weekly results, full rosters. Reuses
  `computeStandings`, `groupPlayoffRounds`, and `StandingsTable`; archived
  `/teams/[id]` pages already work since they query by id, not active season.
- Admins can **permanently delete an archived season** (test runs/misfires)
  via a confirm-guarded button on `/seasons` → `deleteSeason` (never the
  active season; deletes matches first since Match→Team is RESTRICT, then
  the season — everything else cascades).
- Nav "History" + footer "Past seasons" links appear only once an archived
  (`isActive: false`) season exists — layout passes `hasHistory` down.

## Match previews (done)

- `/matches/[id]` renders a `MatchPreview` while a match has no games and
  isn't COMPLETED: side-by-side rosters (rank, roles, RSVP status, standins),
  recent-form strips, prior-meetings line (leader-phrased head-to-head), and
  the same check-in banner as `/schedule` for participants. Completed matches
  without imports keep the "no games recorded" empty state.

## MMR-weighted draft budgets (done)

- `mmrWeightedBudgets` (`src/lib/draft.ts`, tested): linear min–max
  interpolation across the captain pool — lowest-MMR captain gets
  `base × (1+w)`, highest gets `base × (1−w)`, `Season.budgetMmrWeight`
  (percent, default 20, 0 = flat) is the knob, floored at
  `(teamSize−1) × MIN_BID` so every team can fill. Unknown MMR → base.
  The weight scales with the captain gap (`BUDGET_FULL_EFFECT_GAP` =
  1000 MMR): full spread only at a 1000+ MMR gap, proportionally less
  below it, so near-equal captains get near-equal budgets.
- Seed medals derive from signup MMR via `approxRankTierFromMmr`
  (`src/lib/rank.ts`, tested) so demo profiles look consistent.
- Applied in `startDraft` (replaces the uniform `season.draftBudget`);
  create-season form has the weighting field; the admin captains card shows
  projected (pre-start) / actual (post-start) budgets per captain.
- Gotcha: after `prisma db push` regenerates the client, restart the dev
  server or new Season fields read as `undefined` in the running process.

## Medal MMR validation (done)

- Pure lib in `src/lib/rank.ts` (tested): `mmrRangeForRankTier` — the
  plausible-MMR window for an OpenDota medal: the exact star band from the
  accepted ladder (154/star Herald–Ancient, 770/medal; DIVINE stars are 200
  each — 4620/4820/5020/5220/5420 — ending at the 5620 Immortal floor)
  padded symmetrically up to `MMR_WINDOW_MAX` = 1000, so no window is ever
  wider than 1000 MMR (Immortal open-ended above 5220). `clampMmrToRank`
  (an out-of-window claim, blank/0 included, snaps to the window FLOOR; no
  medal = no clamp) and `rankTierExactMinMmr` (the no-padding band floor,
  for eligibility). `approxRankTierFromMmr` shares the same band constants —
  the inverse-consistency sweep in rank.test.ts pins that they never drift.
- **Gate order is load-bearing** (`saveRegistration`): the medal is ensured
  (new-signup OpenDota fetch) BEFORE `registrationGate`; the gate judges the
  RAW claim + medal — never the clamped value (clamping snaps DOWN under the
  ceiling, so gating post-clamp would admit any overstated lie — the bigger
  the lie, the lower the number the gate would see); and the medal-floor rule
  rejects Divine 3+/Immortal (`rankTierExactMinMmr > HARD_MMR_CEILING`)
  whatever they type, so sandbagging can't walk past the ceiling either.
  Only gate-approved claims are clamped and stored.
- **A stored registration MMR is league-approved**: an UNCHANGED resubmit is
  never re-clamped (an admin `setRegistrationMmr` correction — the documented
  never-clamped escape hatch for stale medals — must survive the player
  editing their roles), and inhouse `joinQueue` trusts reg-sourced MMR as-is,
  clamping only the self-reported sources (the typed value and the old lobby
  snapshot; blank+medal seeds the medal floor instead of unknown).
- Surfaces: /me signup hint (range display capped at the ceiling; floor-0
  medals say "treated as unknown", 5K+ medals get a danger note), the inhouse
  queue panel hint (always visible — it explains why the listed MMR can
  differ from what was typed), an adjustment note in the signup toast
  (estimated / left unknown / set to N — never a silent rewrite), and the
  advisory "heads up" mismatch flag in the admin override's message.
- Tested end-to-end: `rank.test.ts` (incl. an exhaustive inverse-consistency
  sweep vs `approxRankTierFromMmr`), `registration.test.ts` gate rules,
  `registration.itest.ts` + `inhouse.itest.ts` clamp paths, override trust,
  and the `setRegistrationMmr` advisory contract.

## Draft room QoL (done)

- Draft-night alerts: the room chimes (shared `src/components/chime.ts`, also
  used by inhouse; persisted `draftSound` toggle, gesture unlock in `act()` and
  on the first `pointerdown`) on your-turn-to-nominate and on being outbid; an
  OUTBID flash (with one-tap re-bid via `quickBid`) latches until the poll sees
  it stale, and the tab title flips "⏰ Your pick — "/"💸 Outbid — ".
  **Both halves of the latch are pure and tested** (`draft.ts`): `wasOutbid`
  raises it — its same-player guard prevents a false flash when a winning bid
  resolves into a fresh nomination within one poll — and `outbidLatchAfter`
  decides set/clear/KEEP. It takes no budget or `canBid` input on purpose, and
  the signature is the guard: a captain who has been priced out is exactly who
  most needs to see they lost the player (the re-bid button disables itself).
  The title flag is `draftTitleFlag`, and `stripDraftTitleFlag` +
  `DRAFT_TITLE_PREFIXES` live beside it because the room used to keep its own
  hand-copied duplicate of those two literals for the strip — a lost trailing
  space or an en dash for an em dash would have stacked prefixes in the tab
  forever with nothing anywhere to notice. A round-trip test pins it.
- **The live feed is `draftFeedDiff` + `seedDraftFeed`** (`draft-feed.ts`,
  tested). Rules that each have a silent, in-front-of-everyone failure mode:
  the previous-rosters set includes CAPTAINS (`transferCaptaincy` demotes a
  member while leaving them rostered, and is legal in both states where this
  room polls — filter them out and the room announces the outgoing captain as
  a signing); a bid line only fires while the lot is UNCHANGED, so a sale
  resolving into the next nomination can't be logged as a bid nobody made; two
  bids inside one poll collapse to one line at the higher amount (the feed is
  a highlight reel — the lot's `lotBids` trail is the audit log); and lines
  come back NEWEST FIRST because the room prepends them whole. That last one
  is a fix, not just an extraction: one poll routinely carries a sale AND the
  nomination it resolved into (`getDraftState` runs both resolvers before it
  reads), and the diff used to emit them oldest-first while the seed emitted
  newest-first, so the two halves of one feed disagreed on screen. What the
  component keeps is React: the accumulated list, and the KEYS — live ids count
  up from 0, seeded ids count down from -1, and a collision would break the
  list mid-draft. The SOLD! flash takes the last sale in PAYLOAD order when
  several land at once, which is NOT the newest (teams arrive by draft order,
  members by price, and no timestamp reaches the client) — stated in the code
  so nobody reads recency into it.
- **Both rooms ring ONCE per transition**, from the alerts their diff returned.
  The draft room used to call `playChime()` from four scattered sites, which
  double-struck the same AudioContext when two moments coincided; folding them
  makes that line a single point of failure, so `room-source-guards.test.ts`
  asserts EXACTLY two call sites per room (the ring + the sound toggle's own
  confirmation) and that the ring is derived from the alerts list. A room that
  rings from nowhere is otherwise invisible: tsc is happy, the alerts are still
  computed and tested, and no browser spec can hear audio.
- The auction's "Available" list has search, position-filter chips, and
  MMR/rank/name sorting (`AvailableList` in `draft-room.tsx`).
  `filterAndSortPlayers` (`player-pool.ts`) is generic over
  `FilterablePlayer` so the signup pool page and the live draft share the
  same tested filter logic.

## Auto match times (done)

- `Season.firstMatchNight` + pure `matchNightForWeek` (`schedule.ts`, tested):
  the admin picks week 1's datetime in the Generate-schedule form; every
  regular week and each playoff round (both `createPlayoffBracket` and
  `advancePlayoffBracket`) gets `scheduledAt = first + (week−1)×7d`.
  Empty input = no times (old behavior); per-match "Set time" still overrides.

## Calendar feed (done)

- `src/lib/ics.ts` — pure RFC 5545 builder (escaping, UTC dates, CRLF;
  tested). `GET /api/calendar` serves the active season's scheduled,
  unplayed matches (`?team=<id>` filters); duration is `bestOf × 60 + 30`
  minutes. Linked from `/schedule` ("📅 Calendar (.ics)") and team pages
  (during REGULAR_SEASON/PLAYOFFS).

## Draft recap card (done)

- `draftRecap` (`src/lib/draft-recap.ts`, tested): biggest single spend, best
  MMR-per-dollar steal, top-spending and least-spending teams, total spent —
  captains ($0) excluded. Rendered as a "Draft night" card on `/teams`
  whenever any purchases exist (live during DRAFT, historical after).

## Accessibility conventions (done — keep following these)

- Buttons get focus rings from `baseBtn` (`focus-visible:ring-2`) — use
  `buttonClasses`/`Button` for anything clickable.
- Purely visual indicators carry an accessible name: `FormStrip` and the
  schedule `RsvpBadge` are `role="img"` + `aria-label` with inner glyphs
  `aria-hidden`; `RankMedal` has `aria-label`; `TeamCrest` is decorative
  (`aria-hidden`, name always adjacent as text).
- Toggle chips (draft-room role filter/sort) use `aria-pressed`; selects
  without visible labels need `aria-label`; countdown clocks are
  `role="timer"` with a spoken label.

## Mobile layout rules (done — keep following these)

- Card grids must use `grid-cols-1` explicitly (`grid grid-cols-1 gap-4
  sm:grid-cols-2`) — without it the implicit track is `auto` and a long team
  name widens the whole page. Same trap: grid *items* need `min-w-0` (see the
  dashboard's two column divs).
- `StandingsTable` is `table-fixed` with column widths on a responsive
  `<colgroup>` so the Team column truncates instead of stretching. Widths must
  live on `<col>`, NOT on `hidden sm:table-cell` th/td — fixed layout still
  hands display:none columns an equal share of the leftover width, starving
  Team on phones. Responsive-hidden columns get `w-0 sm:w-*` cols.
- `CardHeader` clamps its title/subtitle (`min-w-0` + overflow-wrap) — free-
  text names are safe there. In custom flex headers, every level between the
  container and a `truncate` span needs `min-w-0`.
- `CheckinBanner` text has `min-w-[14rem]` so the RSVP buttons wrap below the
  copy on phones instead of crushing it.
- **A card holding an `overflow-x-auto` scroller needs `overflow-hidden` on
  the CARD** (see SeasonGrid): Chrome propagates the inner scroller's full
  table width into the page scroll area through the card otherwise — every
  phone got a ~100px horizontal page scroll before the mid-season mobile e2e
  caught it. Flex-wrap chips need `min-w-0` to truncate instead of widening
  the page (Run-in opponent chips).
- **The site header is `h-20` (80px)** — anything pinned beneath it must use
  the same offset and be updated TOGETHER: the draft room's fixed compact
  clock bar (`top-20`) and its IntersectionObserver (`rootMargin -80px`),
  anchor targets (`scroll-mt-20`, pool anchor `scroll-mt-32` = header + bar).
  A past header resize (h-16→h-20) silently clipped the clock bar.
- Draft room on phones: the player-pool column comes FIRST in DOM (captains
  on the clock need it now; `lg:order-*` restores teams-left/feed-above-pool
  on desktop). Keep the `#player-pool` anchor + NominateBar's ↓ link working.

## Page layout & the UI kit (2026-07-28 pass — read before laying out a page)

**A fixed two-column split sizes its row to the TALLER column, so the shorter
one becomes a hole.** The dashboard's `lg:grid-cols-3` with the standings alone
in a `col-span-2` and four cards in the 1/3 rail measured a **728 × 790px void**
in the lower-left — the single worst thing on the site, and invisible in code
review because both halves are individually correct. Two replacements, both in
`src/app/page.tsx`, and neither is optional decoration:

* **A band whose card count is KNOWN** gets an explicit grid whose spans adapt:
  Standings is `lg:col-span-2` when a "Your team" card sits beside it and
  `lg:col-span-3` when the viewer has none. The `COMPLETE` view's twin split
  instead uses `items-start`, because there the short card genuinely should not
  stretch.
* **A band whose card count is UNKNOWN at render time** (League pulse renders
  `null` until the league has games; Upcoming and Recent each vanish at the ends
  of a season) uses auto-fit:
  `grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr))]`.
  auto-fit COLLAPSES the empty track, so two cards share the width and three
  split it with no conditional spans to keep in sync.

  **Do NOT add `grid-cols-1` to an auto-fit grid.** It is the reflex that the
  mobile rule above trains, and it silently wins the cascade — Tailwind's
  `grid-cols-1` emits the same `grid-template-columns` property, so the whole
  band collapses to one column at every width and the page just gets taller.
  This cost a debugging round the first time. The `min(16rem,100%)` in the
  minmax is what makes `grid-cols-1` unnecessary: the track can never exceed the
  container, so a long team name cannot widen the page.
  `ThisWeek`'s body uses the same form — a league with a bye plays an ODD number
  of matches per week, and the old `sm:grid-cols-2` left a permanently empty
  cell.

  **The inverse rule still stands for ORDINARY responsive grids**, and it had
  six live violations. A `grid gap-4 sm:grid-cols-2` with no base column has an
  implicit `auto` track below `sm`, which sizes to its content's max-content —
  on `/leaders` that was a 560px leaderboard row inside a 390px viewport, i.e. a
  188px horizontal page scroll, shipped to production. The other five (recap
  awards, admin's create-season form, the season archive's weekly results,
  `/me`'s participation tiles, the dashboard's pool composition) were latent
  only because their content happened to be narrow. A sweep of all 20 pages
  reports zero horizontal overflow at 390px; keep it that way.

**The hero is a two-column marquee with ONE control slot.** Mid-season
`heroAction` is null — there is no league-wide CTA once the season runs — which
is exactly when a signed-in player has the most personal thing to do. So the
slot holds, in order of preference: the phase's CTA buttons, or (mid-season)
`MyNextMatch` rendering `<CheckinBanner variant="panel">`. Two rules: `aside` is
optional and the identity column takes the full width without it (an empty 23rem
column is worse than none), and **anything passed as `aside` MUST render
something** — that is why `MyNextMatch` has a no-match branch instead of
returning `null`. `SeasonTimeline` is the hero's footer rail now, not its own
band; it kept `<ol aria-label="Season progress">`, the per-`<li>`
`aria-current="step"` and the sr-only `(done)`/`(current)` text.
`SeasonViewSkeleton` mirrors these bands — if you change one, change both or the
page visibly rearranges after streaming.

**Additive-only changes to the shared kit.** `Stat`, `EmptyState`, `PageTitle`,
`SectionTitle`, `CardHeader` and `Card` have 15-22 call sites each, so every new
capability is an optional prop whose default is byte-identical to what shipped:
`Card tone` (`default` | `feature` | `quiet` — `feature` is the ONE card on a
page the viewer should act on; if two are `feature`, neither is), `Stat size`
(`md` drops the figure to text-xl, replacing a hand-rolled inline override in
the dashboard's narrow rail), `EmptyState compact` (a section that is routinely
empty and is not the point of the page — two full 240px dashed boxes made a
populated `/players` read as broken), and `CheckinBanner variant`
(`strip` is byte-for-byte what `/schedule` and `/matches/[id]` render, including
the seven `details →` assertions; `panel` stacks for a narrow column). New:
`StatStrip`/`StatCell` — the "shape of this thing in one line" band under a page
title. Tokens `--color-surface-3` (an OPAQUE elevation step; a translucent one
lets scrolled rows show through a table header) and `--color-line-soft` (a rule
INSIDE a dense list, where `--color-line` draws a box around every row).

**`/players` — the pool is a table, and one string is why.** `ROW_GRID` in
`player-pool.tsx` is shared by the column header and every row; two copies would
drift within a week and the header would start lying about which column is
which. Below `md` there are no columns — the avatar keeps the left gutter and
everything else stacks in the second track. That is not a nicety: the old
`justify-between` row gave its right-hand chips `shrink-0`, so at 390px real
players rendered as `P…`, `R.` and `Dir…`. Two placement details are
load-bearing: the status chip spans BOTH phone tracks rather than sitting in
track 3 (an `auto` track sized by a "Techies Anonymous $4" chip stole ~170px
back off the name), and heroes ride with the roles below `md`, drop out between
`md` and `xl`, and take their own track at `xl` — `xl:order-*` swaps them ahead
of status for the wide layout only. The pool leads the page and the rosters
follow it; `/teams` is the rosters' real home.

**`/inhouse` — order is the product.** The page was room → guide → four ~500px
box scores → ladder, which put the Elo ladder (the reason anyone comes back)
past 4,000px AND paid the page's most expensive query for its least reachable
content. It is now room → `SceneStats` → ladder → results → guide. `SceneStats`
calls the SAME memoised `loadBoardStats` the pinned Discord board uses, so the
channel and the site can never disagree about when the last game was — and the
empty queue, which is ~95% of views, stops reading as a dead league. Recent
results keep all four box scores but fold the older three into `<details>` whose
summary IS the scoreline; the anchor id lives on the `<details>` element so a
`#result-<id>` jump from the room's "Box score ↓" always lands. The OpenDota
setup guide is `open={fhUnavailable}` — closed for everyone EXCEPT the cohort
OpenDota reports as having public match data switched off. Folding it shut for
everybody would have hidden it from exactly the people it is written for.

**The dashboard shows a fixture ONCE per job it does.** Mid-week it printed
tonight's games four times: the hero's check-in panel, the This-week band, the
Upcoming card, and the your-team next-up tile. `focusSlate` (`schedule.ts`,
tested) now defines the front band, and "Coming up" is the PARTITION of the
open matches against it — so the two bands can never hold the same match, and
the card disappears in the final week instead of restating it. The stake line
and the next-up tile merged into one block: they were always about the same
match (the tile is aligned to the scenario engine's `nextMatchId` so "win the
next series" and the fixture beneath it cannot disagree), and it names the
OPPONENT, not "us vs them", which was the third printing of the viewer's own
team name on one card. Measured on the fixture: 14 links over 9 fixtures
became 13 over 11 — strictly more of the league surfaced, in less space. The
remaining 3 printings of the viewer's own match each do a different job
(RSVP / the league's slate with both check-in counts / the stake anchor).

**Tap targets: size the PRIMITIVES, not the call sites.** A bare text link is
exactly its line-height tall — 20px at `text-sm`, 16px at `text-xs` — and WCAG
2.5.8 (AA) wants 24×24. An audit of 533 targets found **208 real failures**, and
`PlayerLink` alone was 81 of them. Two shared things fixed 195: `TAP_SAFE`
(`py-1 -my-1` — padding grows the border box, which is what hit-testing and
`getBoundingClientRect` follow, and the negative margin hands the space back to
the layout, so nothing moves; on an inline element neither value affects the
line box at all) and `textLink()`, which is `buttonClasses`' sibling for the
"Full schedule →" idiom that had been hand-written at 44 call sites with no
focus ring. Use them; don't hand-roll `text-info hover:underline` again.

**The audit only means anything because it applies the spec's EXCEPTIONS.** A
naive "flag everything under 44px" reports every page and is worth nothing —
the first pass here did exactly that and had to be thrown away. `expectTapTargets`
(`e2e-mid/helpers.ts`) exempts a target that sits in a run of text (2.5.8's
inline exception) and one with no neighbour inside 24px (the spacing exception),
but does NOT exempt a link that is the sole control of a list row — that is the
row's control however much other text the row carries, and it is the case the
check exists for. Four pages are pinned; deleting `TAP_SAFE` turns `/leaders`
and `/players` red, which is how the guard was verified.

**44px (AAA / Apple HIG) is NOT achievable here, and the measurement says why.**
A hit box can only grow into vertical space no other target owns. Measured at
390px across 15 pages: of 446 sub-44px targets, 370 could reach 44 by taking
half the whitespace around them — but only if each took a DIFFERENT amount, and
a static utility class cannot. Under the honest rule (both neighbours grow, so
each gap must be ≥2× the padding), a uniform bump big enough to matter puts
~100 targets into overlap. **An ambiguous target is worse than a small one**:
two links 6px into each other send the tap wherever paint order decides, and in
the pool that was a profile page vs Dotabuff. So `TAP_SAFE` stays at 4px/side
and stacked links get REAL spacing instead (the pool's meta line is `mt-2`, not
`mt-0.5`, for exactly this reason).

What 44px IS free for: **standalone controls with whitespace round them**.
`buttonClasses` is mobile-first — `h-11 sm:h-10` for md, `h-10 sm:h-8` for sm,
so a phone gets the touch size and the desktop keeps its original density — and
the pool's filter row (search, role chips, toggles, sort, the clear-✕) is `h-11
sm:h-9`. That took 44×44 coverage from 31 to 46 targets for +41px per page.
Don't chase the rest by shrinking gaps.

**RESOLVED — those 439 "overlapping targets" on /admin were the probe, not the
page.** `getBoundingClientRect()` is not a test of whether something is on
screen, and two things on this site prove it:

* **A closed `<details>` LAYS ITS CONTENTS OUT.** Non-zero box, `display:block`,
  `visibility:visible` — Chrome simply never paints or hit-tests them. Every
  collapsed disclosure was contributing phantom controls that "overlapped"
  whatever sat near them; on /admin, which now has five collapsed
  `AdminSection`s plus a `✎ Rename team` disclosure per team, that alone was
  439 of 442 findings.
* **A clipping ancestor does not move the rect.** A row scrolled below the fold
  of `admin/page.tsx`'s `max-h-80 overflow-y-auto` captain list still reports
  coordinates hundreds of pixels down the page, landing on the Schedule card's
  controls. That was the other 3-4.

So `expectTapTargets` checks `closest("details:not([open])")`, `checkVisibility
({contentVisibilityAuto, opacityProperty, visibilityProperty})`, AND intersects
the rect with every non-`visible` ancestor before believing it. With all three,
real overlapping pairs across 15 pages: **0**. Any future probe over rendered
geometry needs the same three, or it will report the same ghosts.

The hunt did turn up two REAL defects, which is the argument for doing it:
`CardHeader` crushed its title when the `action` slot held a whole form (the
admin Schedule card read "Schedul / e & / results" in a ~60px column on a
phone — fixed with `flex-wrap` + `basis-48` on the title, so a link-sized
action still sits inline), and six genuine sliver overlaps on /leaders and
/schedule where two `TAP_SAFE` links stacked 4px apart. Rows whose links carry
TAP_SAFE need ≥8px between them.

**A Dota name can be ONE character**, and the live league has a player called
"x" — an 8px-wide link. `PlayerLink` carries `min-w-6`, and the five callers
that pass a truncating row name were moved from `min-w-0` to `min-w-6` (a flex
child can still shrink to 24px, which truncates fine). The guard has NO
length exemption: the first cut skipped one-character labels as "data, not
layout" and was thereby hiding the only real failure left on production. If a
guard's exemption is what makes it pass, the exemption is the bug.

**One control, one name.** `/players` rendered "Clear filters" twice whenever
a filter matched nothing — a text link in the count line and a button in the
EmptyState. Two controls with the same accessible name is both a UI wart and
a strict-mode e2e flake that only fires on the seeds where the filter happens
to empty the list. The count line now yields when the list is empty.

**`/players` filters live in the URL** (`?q=&pos=&sort=&cap=1&status=free`,
defaults omitted). They seed from `useSearchParams` on mount — which is why
`<PlayerPool>` needs its `<Suspense>` boundary — and mirror back via
`history.replaceState`, NOT `router.replace`: the filter is entirely
client-side, and a router call re-runs the page's four Prisma queries on every
chip tap. Debounced 250ms because browsers rate-limit `replaceState` (Safari:
100 per 30s). React is the source of truth, the URL is a mirror. `sort` is
excluded from `resetFilters` and `filtersActive` — an ordering preference is
not a filter. The e2e reloads the URL COLD, because seeding from it is the half
that rots while mirroring to it keeps looking fine.

**`/admin` is anchors + disclosure, and both halves matter.** It was 6,948px /
11,501px — the longest page in the app by 36%, and the tool the league is run
from on match night. `AdminJump` is sticky at `top-20` (the header offset the
draft room's clock bar uses) and every card is an `AdminAnchor`; the five cards
touched ONCE — Discord, the Valve league id, news, security, next season —
are `AdminSection`, a `<details>` whose `<summary>` keeps the title as a real
visible heading (so a scanning admin AND the e2e assertions still find it).
2,415px of set-once forms folds to 420px. **A `<button>` inside a `<summary>`
toggles the disclosure instead of submitting** — that is why the Discord test
send and the league sync moved into their card bodies.

**Tripwires.** `/`, `/players` and `/leaders` now have
`expectNoHorizontalOverflow` tests
(`e2e-mid/dashboard.spec.ts`, `e2e-mid/boards.spec.ts`) — they were the two
pages with none, and both carry wide content. All four `<Card>`s wrapping
`<Bracket>` gained `overflow-hidden`: `Bracket`'s root is `overflow-x-auto` over
a `min-w-max` row, and every one of them was violating the SeasonGrid rule.

## Player pool scouting (done, 2026-08-01 — /players row enrichment)

The pool rows carry per-player scouting data, ALL of it gated on **data
presence, never season phase** (the `anyDrafted` precedent) — an empty league
renders byte-identical to the pre-feature page:

- **Inhouse record** (rating / ladder rank / W–L) via NEW
  `src/lib/inhouse-ladder.ts` — the full-history ladder scan behind a
  `loadBoardStats`-style in-process memo (60s TTL, `nowMs` param,
  `resetInhouseLadderCache` seam; deliberately NOT `unstable_cache` — the
  `"games"` tag is league-import semantics and inhouse completions never bust
  it). Rendered as a 5.5rem column between MMR and Roles at **lg+ only** (md
  has no rem budget — a sixth track at 768px recreates the name-truncation bug
  class), as a plain-text meta-line token below lg. Provisionals
  (< PROVISIONAL_GAMES) are dimmed, never ranked, and show `· Ng`; a player
  with no games gets an EMPTY cell, never a dash. "Sort: Inhouse" is
  **component-local** (`PoolSortEx` in player-pool.tsx) — never added to the
  shared `PoolSort`, which the draft room consumes; the ranked band orders by
  ladder RANK (it encodes the full tiebreak — rating alone rendered #5 above
  #4 on a tie).
- **Pub-scouting snapshot** — NEW `User.pubStats`/`pubStatsAt` (JSON string;
  parse with `parsePubStats` in `src/lib/pub-stats.ts`, which degrades
  garbage to null). Fetched by `fetchPubStats` (`dota.ts`: `/wl?limit=100` +
  `/heroes` in parallel, both-or-nothing, the `fetchRankTier` ok:false
  contract). Rendered as the "Pubs 54% in last 100" token — the copy NAMES
  the recent window so a streak never reads as a lifetime figure, and the
  window is the games OpenDota could actually see (a 37-game account reads
  "in last 37") — plus top-3 most-played hero icons (real, from /heroes —
  the self-typed signature heroes keep their own column) and a
  "last played Nmo ago" flag past `PUB_QUIET_DAYS`. Deliberately NO
  games-played volume figure anywhere visible. An empty recent window
  (private data / new account) renders NOTHING — never "0% of 0". The
  PROFILE page renders the same token/flag in its hero meta line and folds
  the full top-5 into the "Most played heroes" card beside the league
  section (HeroPool's prop shape IS the stored PubHero shape) — which now
  renders for pub data alone, so season-1 profiles aren't empty.
- **Discord reachability marker** — beside the existing `<DiscordTag>`, a
  muted "no Discord" token renders for players with neither a typed handle
  nor an OAuth link, on the pool rows AND profiles. GATED to signed-in
  viewers via the `showContact` prop: the payload blanks handles when
  signed out, so without the flag the component cannot tell "signed out"
  from "player has no Discord" and would leak the marker to the public
  internet. Keep that rule.
- **Capture points mirror rankTier exactly**: login (`ensurePubStats` —
  MISSING-only, the ensureRankTier rule; an earlier 7-day staleness gate put
  a recurring 8s worst case on the login path and was reverted), /me
  link/refresh, and the admin "Sync ranks & stats" button. Never overwritten
  on a failed fetch, and **every pubStats write re-asserts
  `dotaAccountId` in its WHERE** — a relink committing mid-fetch must not
  inherit the old account's data (raced in rank-sync.itest.ts). These
  updateMany claims are NEW to the mutation baseline — assume unprotected
  until a full `--discover` says otherwise.
- **`PUB_SYNC_MAX_PER_RUN` (12) is the API budget** — the bulk sync fires 3
  OpenDota calls per account with pub stats riding along, and the free tier's
  bucket is ~60/min, so an uncapped 31-account sweep burned its own tail into
  429s (and could false-trigger the outage bail). Each press syncs medals for
  everyone, pub snapshots for the STALEST ≤12 (fresh ones skipped via
  `pubStatsFresh`); the toast reports "(N more next run)".
- `PoolPlayer` stays FROZEN: everything rides `PoolScoutInfo`, one parallel
  record (the `PoolDraftInfo` precedent) carrying `{inhouse?, pub?,
  statement?}` — statement is the row quote's fallback when `captainNote` is
  empty, sent only when it will render. Token/title text lives in
  `player-pool.ts` (`inhouseToken`/`pubToken`/…) so the rows, the lg column
  and the hopefuls cards can never phrase the same fact differently.
  The component takes `now` (server epoch ms) so SSR and hydration compute
  identical recency labels.
- The row grid is `rowGrid(withInhouse)` now — ONE computed template shared
  by header and rows; `rowGrid(false)` is byte-identical to the old
  `ROW_GRID`. The meta line moved `gap-y-1 → gap-y-2`: the tokens make wraps
  routine and two stacked TAP_SAFE links 4px apart overlap by ~4px.
- COVERAGE LIMIT (stated): the cell/token/StatCell JSX has no automated
  render test (no jsdom; neither e2e seed has completed lobbies or pub
  stats). The lib layer is fully tested; verified in a real browser at
  390/768/1024/1440 via the enriched `signups-fixture` seed (which now also
  creates 8 completed inhouse lobbies).

## Fantasy league (done, branch: bigger-features)

- Anyone signed in picks a **fantasy five** from the drafted rosters under an
  MMR salary cap (`fantasyCap` = league-avg rostered MMR × 5 × 1.05); points
  score per imported game via `fantasyPoints` (kills/assists/deaths/economy/
  win bonus — weights in `FANTASY` constants). All pure + tested in
  `src/lib/fantasy.ts`.
- Models `FantasyRoster`+`FantasyPick`; `saveFantasyRoster` action validates
  picks server-side and **locks league-wide once the first game is imported**.
- `/fantasy`: live-budget picker (client `FantasyPicker`, checkboxes named
  `picks`), standings with per-pick breakdowns, locked-roster chips. Nav from
  REGULAR_SEASON on.

## MVPs & achievements (done, branch: bigger-features)

- Pure `src/lib/achievements.ts` (tested): `gameMvp(players, radiantWin)` =
  best fantasy line among mapped players (win bonus favors winners; kills →
  fewer deaths → id tiebreaks); `achievementsFor(lines)` = badge catalog
  (Match MVP ×N, Deathless, Killing spree 15+, Playmaker 20+ assists,
  Tycoon 600+ GPM, Veteran 10 games, Centurion 100 kills).
- Match box scores show an MVP chip on the crowned line; player profiles get
  an "Achievements" trophy case computed career-wide (all seasons' games).

## Hall of Fame (done, branch: bigger-features)

- `/hall-of-fame`: cross-season career boards — 🏆 titles and ⚔️ series wins
  via pure `careerCounts` (`src/lib/hall-of-fame.ts`, tested; team cuids are
  globally unique so cross-season membership just works), 🎯 career fantasy
  points (`pointsByPlayer` over all games ever), 🔮 all-time oracle record
  (`pickemStandings` over all predictions, min 3 graded). Linked from
  `/seasons` and the footer.

## Power rankings (done, branch: bigger-features)

- Pure Elo in `src/lib/power-rankings.ts` (tested): K=32, start 1000,
  per-GAME (each series expands into its game results, week order; home wins
  applied first inside a series). `powerRankings` returns rating + rank +
  prevRank (before the latest completed week) + weekly delta. Regular-season
  matches only feed it.
- `/teams` shows the card with ▲/▼ movement arrows and rating deltas whenever
  a completed match exists.

## Weekly honors (done, branch: bigger-features)

- Pure `weeklyHonors` (`src/lib/honors.ts`, tested): Player of the Week =
  best fantasy points that week (same `fantasyPoints` identity as the
  fantasy league); Team of the Week = most game wins, points tiebreak.
- `honors-service.ts`: `maybeAnnounceWeekHonors(seasonId, week)` fires once
  a regular week's matches are all COMPLETED — idempotent via an ATOMIC
  `honorsAnnounced:<season>:<week>` Setting CREATE (P2002 ⇒ already sent;
  claimed only after the nothing-imported check so a games-less week never
  burns the marker — auto-sync means the week's last two series can finish
  from two concurrent unauthenticated pings, which the old read-then-upsert
  could double-announce). Hooked in `recomputeSeries` (all import paths) and
  manual `recordResult`.
- `/leaders` shows a "Weekly honors" card (newest week first, hero name via
  `heroById`).

## Pick'em (done, branch: bigger-features)

- `Prediction` model (matchId+userId unique). Pure `src/lib/pickem.ts`
  (tested): `predictionOpen` (locks at `scheduledAt` or completion),
  `pickemStandings` (correct desc, accuracy tiebreak; draws void picks),
  `pickSplit` (community percentages).
- `savePrediction` action re-validates the lock + that the pick is one of the
  two teams. `/pickem`: oracle-board leaderboard, open matches as two
  team-buttons with live pick splits, "your graded picks" review. Nav from
  REGULAR_SEASON on.

## Interactive bracket (done)

- `src/components/bracket.tsx` (`"use client"`) draws the classic CENTERED
  tournament shape: two wings converge on a grand final with the 🏆 floating
  above it (greyed until a champion is crowned, then glowing). Pure
  `mirrorLayout` (`bracket-view.ts`, tested) splits the linear rounds into
  left/right wings + center — round i's first-half slots go left, second half
  right, matching the R{r}M{m} feed-forward. Connector lines are pure CSS
  (flex-1 wrappers so pair midpoints land on the next card's center); wing
  direction flips the stub/vertical edges; the inner wing column is always a
  single slot whose center meets the final's. Seed numbers, dashed TBD slots,
  tap/hover run tracing, 🏆 on the final's winner all still apply. Pure
  `bracketSkeleton`/`slotIndex` (`schedule.ts`, tested) build the round
  structure; `src/lib/bracket-view.ts` serializes matches + `seedMap`.
  Rendered on `/schedule`, the dashboard, and `/seasons/[id]` — wide by
  design, always inside its own `overflow-x-auto`.

## Season grid (done)

- "Who's played who": `crossTable` (`src/lib/cross-table.ts`, tested) maps
  teams × REGULAR matches into per-meeting cells from the row team's
  perspective (W/L/D + score, `wk N` link when unplayed, list per pair for
  double round robins). Rendered as `SeasonGrid` on `/schedule` (standings
  order, crest+rank column headers, sticky row-header column, result-toned
  chips linking to match pages) whenever regular matches exist. Scrolls
  inside its own container on phones.

## Hero meta page (done)

- `/meta`: league-wide hero report from imported box scores — pick/win rates,
  most-contested table, best-win-rate board (adaptive `metaMinPicks` floor),
  signature player per hero, untouched-pool card. Pure `heroMeta`/
  `bestWinRates` in `src/lib/hero-meta.ts` (tested); unknown hero ids render a
  "Hero #N" fallback. Nav "Meta" + footer link from REGULAR_SEASON on.

## Record book (done)

- `/records`: all-time single-game records across every season — player
  records (kills, assists, net worth, GPM, last hits, deaths) and game
  records (longest/fastest by `durationSecs`, bloodiest/biggest stomp by kill
  score; 0–0 or 0-duration games never qualify — unreported ≠ record). Pure
  `leagueRecords` in `src/lib/records.ts` (tested): first achiever keeps a
  tie, so feed games chronologically. Linked from the footer + Hall of Fame.

## Hero report cards (done, branch: ambitious-features)

- Import now stores the extended per-player OpenDota fields on each
  `Game.players` line: `xpm/denies/level/heroDamage/towerDamage/heroHealing`
  + `benchmarks` (per-metric `{raw, pct}` percentiles vs the world on that
  hero — present on plain `/matches/{id}` payloads, no replay parse needed).
  `sanitizeBenchmarks` (exported, tested) keeps only finite pcts, clamped
  0..1, and stores `null` when none — the `"benchmarks"` JSON key doubles as
  the "already enriched" marker. Legacy lines simply lack the fields.
- Pure `src/lib/benchmarks.ts` (tested): 7-metric catalog, `gradeFor`
  (S/A/B/C/D), `gameReportCard`, `careerReportCard` (per-metric averages +
  focus/best callouts with an observation floor), `percentLabel` ordinals.
- Surfaces: grade-chip strip under every box-score line (`/matches/[id]`),
  "Report card" percentile bars + strength/work-on callouts on
  `/players/[id]`, "Best report card" board on `/leaders`.
- Admin backfill: `enrichStoredGames` (integration-tested) re-fetches games
  missing the marker by `dotaMatchId` in bounded batches, merging new fields
  WITHOUT touching userId/teamId attribution; button lives in the Dota
  league integration card.

## Opponent scouting report (done, branch: ambitious-features)

- Pure `src/lib/scouting.ts` (tested): `playerHeroPool` (per-hero W-L/KDA),
  `threatBoard` (team-wide ban list, adaptive `max(2, ceil(picks/25))`
  floor; `contested` = most-picked fallback), `paceProfile` (win/loss avg
  minutes; 0-duration games excluded — unreported ≠ data), `dossierEmpty`.
  Role coverage reuses `pool-stats.roleCoverage`.
- Rendered as a two-sided "Scouting report" card in the `/matches/[id]`
  preview (both dossiers public), over ALL seasons' stored box scores.

## Playoff scenario engine (done, branch: ambitious-features)

- Pure `src/lib/scenarios.ts` (tested, incl. a seeded property test that
  re-derives every leaf via `computeStandings`): `scenarioReport` enumerates
  every remaining REGULAR outcome under a 200k-leaf cap and refines the
  conservative `clinchStatuses` — ties always counted against a clinch and
  for a survival, so exactness only turns null into CLINCHED/ELIMINATED,
  never contradicts. EVERY match branches win/loss/DRAW regardless of bestOf
  parity — `recordResult` accepts drawn scores (1-1 Bo3, 0-0) for regular
  matches, and "exact" must survive anything recordable. Layer-1 bounds
  (always): `magicNumber`, `eliminationLosses`, focal-match-conditioned
  `winAndIn`/`loseAndOut`, rank ranges. Over the cap it degrades to
  `clinchStatuses` + bounds. `TeamScenario.nextMatchId` names the match the
  winAndIn family is about; `matchStakes(matchId, …)` suppresses those labels
  on any other match page. `stakesHeadline` picks the banner line.
- `src/lib/stakes.ts` (tested) adapts prisma rows → engine inputs and the
  report → the standings `clinch` prop (cut from `pickBracketSize`, same as
  `createPlayoffBracket`; null when everyone makes the bracket).
- Surfaces: refined ✓/✗ marks on the dashboard + `/schedule` standings,
  "The race" notes in the Playoff picture card, "Tonight's stakes" banner on
  regular-season match previews (silent until a night decides something),
  "What we need" card on `/teams/[id]`.

## League news (done)

- `NewsPost` model (title/body/pinned/author). Pure `sortNews` (pinned first,
  newest first) + `newsPostError` validation in `src/lib/news.ts` (tested).
- Admin "League news" card (create/pin/delete, always rendered — news is
  season-independent) → `src/app/actions/news.ts`; new posts announce to
  Discord via `newsMessage` (tested formatter, best-effort send).
- Surfaced on the dashboard (`LeagueNews` card, top 3, pinned first) and the
  full `/news` archive (footer link). Post dates render via `<LocalTime>`.
- Header nav collapses to the menu below **xl** (was lg), omits "Home" inline
  (the logo is the home link), and the link strip scrolls (hidden scrollbar)
  instead of overlapping the account cluster — with Admin + name + Logout the
  inline nav couldn't fit inside `max-w-6xl` at lg.

## Player comparison (done)

- `/players/compare?a=&b=` — GET-form page (plain selects, no client JS):
  head-to-head card (pure `meetings` in `src/lib/compare.ts`, tested — rivals
  record + games-as-teammates), career table over ALL seasons' games (reuses
  `summarizePlayerGames`; better side highlighted, deaths lower-is-better,
  games count never judged), top-5 hero lists per player. Linked from
  `/players` (action) and each profile ("Compare vs… →" prefills `?a=`).

## Dashboard: the SIGNUPS view (2026-07-29 audit — read before editing it)

The whole view assumed a league that hadn't filled yet and a visitor who
hadn't joined. Both are wrong for most of signup week (`minTeams` is a FLOOR —
see the capacity entry above), and the page had no control anywhere behind the
ask it made twice. What that turned into:

- **A scheduled date the page PRINTS must say when it has gone by.**
  `countdownLabel` returns null 3h past its target, so a slipped draft night
  rendered "🗓️ Draft night: Sun, Jul 26" as a plan, under "Ready to draft",
  days later — and a bare "🗓️ Draft" in the hero, a label with nothing after
  it. `<Countdown passedLabel>` renders an amber chip instead of vanishing;
  pure `hasPassed` (`countdown.ts`) is the same boundary as the label's null
  and `countdown.test.ts` sweeps every offset to pin that they agree. The
  season does NOT advance its own phase, so this state lasts until an admin
  acts. Copy is `DRAFT_PASSED_LABEL` (`season-copy.ts`) because THREE surfaces
  print that date — and the third, added in the same change that fixed the
  first two, was written without a chip at all. `dashboard-guards.test.ts`
  parses page.tsx and fails on a draft-night `<Countdown>` with no
  `passedLabel`; verified by deleting one.
- **Decide "has passed" on the CLIENT.** The boundary is 3h wide and a parked
  tab crosses it with no re-render, so a server-computed chip would contradict
  the countdown that just vanished beside it.
- **The hero's control slot must address who is actually looking.** A
  signed-up player got `heroAction`'s fallback — "See what you're joining" —
  in the biggest slot on the page. `SignupsAside` replaces it with the current
  ask (`needed` below the minimum, `toNextTeam` above) and `<InviteLink>`, the
  only share control on the site; it copies `window.location.origin`, never a
  server prop, so previews and custom domains copy themselves. Like
  `MyNextMatch` it MUST always render something — `aside` suppresses the
  action column entirely.
- **`phaseSubtitle` moved to `src/lib/season-copy.ts` and takes `canDraft`.**
  As a static string it told a full league "the draft begins once enough
  players have joined" directly under a "Ready to draft" badge. Tested in both
  directions.
- **One Discord CTA in `<main>` at a time.** `DiscordSetupPrompt` sequences the
  invite as "1. Join the server"; the signup card's own button made three
  identical `discord.gg` links on one screen (the footer is the third), so it
  now renders only for viewers that prompt can't cover.
- Headings: the signup card's count line is an `<h2>` and the Discord prompt's
  title is too — the outline was h1 then straight to the h3s of cards further
  down, so heading navigation skipped both things the page exists for.
- `snapshot.teams` is fetched on every dashboard render and was thrown away
  during SIGNUPS; "Captains so far" renders it. "Who's in" names its cap
  ("Latest 12 of 30") rather than silently hiding 18 people.

## Dashboard (done)

- `src/app/page.tsx` renders per phase. Matches are fetched ONCE in `Home()`
  (mid-season+ phases) and passed down; the scenario report is computed once
  in `SeasonView` and shared by the standings clinch marks, the This-week
  stakes chips, and the your-team one-liner.
- Hero meta per phase: signups progress, "Week X of Y + teams + games on
  record" (regular), "N teams still alive + <round> underway" (playoffs),
  champion crest + Relive CTA (complete).
- **This week strip**: the current week's (or open playoff round's) matches
  with kickoff times, standin-aware ✓ check-in counts (shared
  `matchNightRoster` in `availability.ts` — /schedule uses the same helper),
  and a stakes chip via `matchStakes`/`stakesHeadline` (the long
  everything-on-the-line label gets a short chip form).
- **Your team** card: rank/record/points tiles (Record rendered a size down —
  W–L–D wraps at Stat's text-3xl in the narrow column), form strip, stake
  one-liner, next-up tile aligned to the ENGINE's nextMatchId so the "next
  series" guarantee and the tile never point at different matches.
- **League pulse**: latest week's honors + most-picked hero (unknown hero ids
  render the "Hero #N" fallback per /meta's convention).
- COMPLETE: champion card + "How it was won" bracket + archive links.

## Standings & schedule UX (done)

- **StandingsTable** is now a thin server adapter (`page.tsx`) over the
  sortable client `src/components/standings-table.tsx`: clickable
  W/D/L/Diff/Pts headers (`aria-sort`), real league rank kept in the # column,
  viewer's team row highlighted with a You chip, weekly ▲/▼ movement
  (`standingsMovement`), ✓/✗ clinch marks (`clinchStatuses` — conservative
  points-only math, suppressed when everyone makes the bracket). Cut line +
  shading + arrows only render in league order.
- **Tiebreak chain** (`computeStandings`, tested): points → game diff →
  series wins → HEAD-TO-HEAD among the still-tied (a mini-table of the tied
  group's meetings via `headToHeadRanks` — mini points then mini game diff;
  applied as a second GROUP pass, never inside the comparator, because a
  3-way cycle isn't pairwise-transitive) → team id as determinism's last
  resort. Teams with identical mini-records SHARE a rank so H2H never invents
  an order it can't justify. The scenario engine inherits it for free (its
  property test re-derives every leaf via computeStandings); `clinchStatuses`
  stays deliberately points-only and is unaffected.
- **/schedule** during REGULAR_SEASON: "Playoff picture" (projected first
  round via `playoffFirstRound` over live standings) and "Run-in"
  (`remainingSchedule` — rank-tagged remaining-opponent chips, in-cut
  opponents accented).
- **ScheduleWeeks** (`src/components/schedule-weeks.tsx`, client): team filter
  chips, fully-played past weeks collapsed to a header line, current week
  gets `id="this-week"` (dashboard deep-links `/schedule#this-week`), byes
  shown per week (`byeTeamsByWeek`) and kept visible under a team filter.
- **Leaders**: `src/components/leader-board.tsx` — full ranked rows, top-5 +
  show-all toggle, viewer's row highlighted and pinned with real rank when
  outside the top 5.
- **Times are viewer-local**: `<LocalTime>` (`useSyncExternalStore`; server
  string as the hydration snapshot, browser TZ after) + shared
  `formatMatchTime` (`src/lib/match-time.ts`). Server-side `toLocaleString`
  alone is WRONG in prod (UTC host) — always pair a preformatted `initial`
  with the epoch `ts`. `<Countdown>` (`countdownLabel`, tested) ticks
  "in 2d 4h" → "happening now" on the check-in banner.

## Datetime inputs (rule)

- NEVER parse a raw `datetime-local` string server-side (`new Date(raw)` uses
  the SERVER's zone — UTC in prod). Use `<LocalDatetimeField>` (submits a
  browser-computed epoch; prefill via `defaultTs`, never a server-formatted
  string) + `localDate(fd, raw, ts)` in the action. Discord messages carry
  times as `<t:epoch:F>` (reader-local), never formatted strings.
- KNOWN LIMITATION: week math is fixed-ms (`matchNightForWeek`, cascade
  deltas) — seasons spanning a DST transition drift the league night by an
  hour after the switch; per-match Set time corrects it.

## Rescheduling (done)

- **Both demand-a-response events announce to Discord**: a NEW "OUT" RSVP
  (`setAvailability` — reads the prior row first so IN↔OUT flapping can't
  spam; `playerOutMessage`) and a fresh reschedule proposal
  (`proposeReschedule` service now returns `ProposedReschedule` announcement
  data, action sends `rescheduleProposedMessage`). The dashboard's
  `MyNextMatch` also shows a "⏳ … Respond →" strip to the opposing captain
  while a proposal is pending.
- **Accepting a reschedule WIPES every RSVP, and now says so.** The delete is
  deliberate (an old answer about a night nobody is playing), but it used to
  be silent: eight to ten players each believed they had checked in, and the
  captain saw an unstaffed match with no explanation — the site shows an empty
  banner and never mentions why. `respondReschedule` returns `clearedRsvps`
  from the deleteMany count and `rescheduleMessage` reports it. The same
  transaction also DELETES the `weekReminder:<season>:<week>` marker: that
  reminder already went out quoting the OLD kickoff, Discord edits notify
  nobody, so releasing the marker is what lets it re-fire with the right time
  and a fresh (empty) check-in count. Both pinned in `reschedule.itest.ts`,
  including that a DECLINE touches neither.
- **Admin week mover**: `setWeekNight` action — retimes a week's unplayed
  matches from one input; optional cascade shifts later scheduled weeks by
  the same delta. Form lives in the admin Schedule & results card.
- **Captain flow**: `RescheduleRequest` model (PENDING/ACCEPTED/DECLINED/
  CANCELLED, one open per match — newer proposals supersede). Guards live in
  `src/lib/reschedule-service.ts` (draft-service pattern, integration-tested
  in `test/integration/reschedule.itest.ts`); `src/app/actions/reschedule.ts`
  is a thin wrapper that adds auth, toasts, and the best-effort Discord
  `rescheduleMessage` on acceptance. Match page shows the Reschedule card to
  the two captains only; `/schedule` rows show a ⏳ chip (links to the match
  page) while a proposal is open; the admin card lists open proposals with a
  Clear button.

## Verifying UI against a fixture (workflow note)

- `scripts/seed-fixture.ts` seeds a throwaway DB into a demo state:
  `FIXTURE_MODE=regular` (last week open — clinch marks, run-in, byes with
  `FIXTURE_TEAMS=5`), `complete` (champion crowned), default (mid-playoffs
  bracket with a TBD final). It REFUSES any `DATABASE_URL` without "fixture"
  in it — always pass one explicitly; the generated Prisma client's baked
  .env can silently point at dev.db.
- Fixture box scores carry the full modern line shape (durations, kill
  scores, benchmarks for report cards — the first two games ever stay
  legacy-shaped to verify degradation), every match gets its league-night
  `scheduledAt` (so `/api/calendar` has VEVENTs), and completed playoff
  matches get games too.
- The dev server locks its project dir (Next 16) and dev.db may belong to
  another session — never reseed it. To run a second server: copy the repo
  elsewhere (`rsync` minus node_modules/.next/dev.db, then
  `cp -Rc node_modules` — APFS clonefile; a symlink breaks Turbopack), point
  its `.env` at an absolute fixture `DATABASE_URL`, and `next dev -p 3111`
  from the copy.

## Performance (done — keep following these)

- **The admin page's Discord card is streamed** (`DiscordSection`). It is the
  only thing on `/admin` that talks to Discord — `getPingHealth` alone is
  three sequential calls at a 4s timeout, and `getInhouseBoardStatus` drags a
  full-history Elo scan behind it. Awaited inline they blocked the whole page,
  Pause draft and Record result included, and did it worst exactly when
  Discord was down, which is when an admin opens that page.
- **In-page streaming**: the dashboard (`page.tsx`) and the match preview wrap
  their slower async sub-sections in `<Suspense fallback={<CardSkeleton/>}>` so
  the hero/shell paints before the heavy queries resolve. When adding a new
  async card, wrap it too; use `CardSkeleton`/`Skeleton` (`ui.tsx`) for a
  fixed-height fallback (no CLS). The root `loading.tsx` still covers navigation.
- **Cached stat scans**: player attribution lives in each `Game.players` JSON,
  so the leaders/meta/records/hall-of-fame/profile roll-ups must scan the whole
  table. Those scans go through `src/lib/cached-queries.ts` (`unstable_cache`,
  60s TTL, tagged `"games"`) — viewer-independent, shared across requests. Add
  new all-games roll-ups there, not as inline `prisma.game.findMany`. The
  game-import admin actions call `refreshGames()` (`revalidateTag("games")` +
  path revalidate) so stats reflect a new import immediately; the 60s TTL is
  just the backstop. `revalidatePath` alone does NOT clear unstable_cache tags —
  bust the tag from a request scope (an action/route), never from the lib (it
  throws outside a request, breaking the integration tests that call it directly).
- **Live-room clocks**: the draft/inhouse countdowns tick inside leaf
  components via `useSecondsLeft`/`useElapsedMs` (`src/components/room-clock.tsx`)
  so only the clock text re-renders each 250ms — NOT the room + player pool.
  Don't reintroduce a room-level `forceTick`; keep new countdowns in a leaf.
- **Poll health**: both rooms wire `usePollHealth` (`room-clock.tsx`) into
  their poll loops — failures counted in refs, one `disconnected` boolean
  flips at ≥`ROOM_POLL_FAIL_THRESHOLD` (3) consecutive failures (never a
  per-poll re-render). The rule itself is pure `pollHealthAfter`
  (`src/lib/poll-health.ts`, tested); the hook only decides where the counter
  lives. CONSECUTIVE is the load-bearing word: a flaky-but-alive connection
  alternating ok/fail must never lock the room, and any single success clears
  the count outright. While
  disconnected: aria-live danger strip, ALL actions disabled (each room
  derives `pending = reqPending || disconnected`), draft clock banner dimmed
  + "reconnecting" in the sticky bar. A 404 from `/api/draft/tick` is
  terminal ("no active season" card), not a retry loop. Never swallow poll
  failures silently — that's how captains watched a frozen auction sell
  their player.
- **Every room poll fetch carries `AbortSignal.timeout(ROOM_POLL_TIMEOUT_MS)`**
  (`constants.ts`, shared by draft + inhouse — one value on purpose, since the
  two loops are the same code). Both latch `inFlight` and clear it only in the
  awaited call's `finally`, so a request that CONNECTS AND NEVER ANSWERS
  (flaky mobile data, a socket resumed from a suspended tab) used to stop every
  later tick, the `visibilitychange` wake-up included. Nothing settled, so
  `pollFail()` never ran and the paragraph above never fired: stale state,
  `disconnected` FALSE, every control live — the silent freeze the health strip
  exists to catch, walking straight past it. The abort throws into each loop's
  existing `catch`, so the loop heals itself. Pinned for BOTH rooms by
  `e2e/zz3-room-poll-resilience.spec.ts`, which hangs the poll endpoint and
  asserts a SECOND request is attempted — without the timeout the count stays
  at exactly 1 forever. Any new client poll loop needs the same signal.
- **So does every room ACTION fetch** — the same freeze from the other side.
  Both rooms flip `pending` on before the mutation and off in its `finally`,
  so a hung action left EVERY control disabled until reload: a captain locked
  out of bidding under a 30s lot clock, a player locked out of ACCEPT during a
  45s ready check. Three rules, all deliberate: (1) the deadline must clear the
  worst LEGITIMATE latency, because aborting a mutation proves nothing — the
  server kept going and may have committed — so both rooms' catch branches
  BRANCH ON `TimeoutError` and refuse to claim "that didn't go through"
  (inhouse also nudges its poll; the honest answer is the next state payload).
  (2) It is scoped PER ACTION, not one ceiling: `ROOM_ACTION_TIMEOUT_MS` (15s)
  for DB-bound actions, `INHOUSE_SCAN_ACTION_TIMEOUT_MS` (45s) for the two
  OpenDota-bound ones (`INHOUSE_SCAN_ACTIONS` = detect/record, ~25s worst case
  — ten 8s recent-match lookups, six 12s match fetches, a 5s Discord send, no
  retries). Sizing everything to the slow path would leave ACCEPT disabled for
  its entire ready check, i.e. exactly as broken as no deadline. (3)
  `src/components/room-source-guards.test.ts` parses BOTH room files and
  fails if any `fetch(` lacks a `signal:` — the browser spec can only reach
  the call sites that are on screen, and the regression to catch is a deleted
  line.
- **DB indexes**: hot filter/join columns are indexed (`Match.seasonId`/home/
  away, `Game.matchId`, `Registration(seasonId,status,type)`, `TeamMember`
  team/user, `Bid.draftId`, `StandinAssignment.matchId`, `Prediction.userId`).
  Add an `@@index` when a new query filters a non-indexed column; skip it when
  an existing `@@unique` already has that column leftmost.
- **Payload trimming**: queries whose rows serialize into the client (the
  `getSeasonSnapshot` rosters, dashboard signup chips) `select` only the display
  fields (`id/name/avatar/rankTier`) instead of `include: { user: true }`.
  Don't re-add full user rows to snapshot/roster queries — the derived
  `SeasonSnapshot` type makes tsc enforce the narrowed shape.

## Deploy safety & ops (done — keep following these)

- **`scripts/build-db.mjs` gates the build's `prisma db push` to
  `VERCEL_ENV === "production"`** (previews only `prisma generate`) — a
  preview deploy of a WIP branch must never push its schema into the live DB.
  The production push runs `--accept-data-loss`: push-without-history fails
  the build on ANY schema warning otherwise, additive ones included (a new
  nullable unique column blocked a deploy); back up before destructive
  schema changes — that's the safety net, not the flag. Pinned by
  `src/lib/build-db.test.ts` (drives the script in dry-run); don't put a
  bare `prisma db push` back in vercel.json.
- **`npm run db:backup`** (`scripts/backup-db.mjs`): pg_dump for Postgres
  URLs, file-copy for SQLite, timestamped into gitignored `backups/`. README
  documents the prod recipe. Tested end-to-end for the SQLite path.
- **`reactivateSeason`** (`src/lib/season.ts`, integration-tested): archived
  seasons get a "Make active again" button on /seasons — the undo for a
  mis-clicked Create season (previously nothing ever wrote `isActive` back).
- **Failed Discord sends never permanently eat an announcement**
  (announce-retry.itest.ts); no-webhook never burns a marker. Two shapes:
  honors + week reminders DELETE their marker on a failed send (their
  triggers naturally re-fire — later imports / page loads in the window);
  series results instead stamp the marker `failed:<iso>` and the throttled
  `retryFailedAnnouncements` sweep in result-sync-service re-claims exactly
  those (the run whose send failed is the run that COMPLETED the match, so
  no import path would ever re-trigger it — and only rows stamped failed are
  retried, so a deploy can't re-announce history). Keep the matching shape
  when adding claim-then-send announcements.

## Admin panel: safety & honesty (2026-07-29 — read before touching /admin)

A flow audit, then a copy audit, then a safety audit of every admin-reachable
action. The engines were already hardened; the THIN SERVER ACTIONS calling them
were not — nearly every defect found came back with no test coverage at all, in
a repo running a 50-claim mutation ratchet. When adding an admin action, assume
the guard you need is missing rather than present.

**The barrier has two tiers, and the tier is the point.** Ordinary destructive
actions use `<SubmitButton confirm>` (a `window.confirm`). The FIVE with no
in-app undo use `<DangerSubmit>` (`src/components/danger-submit.tsx`), which
requires TYPING the season or team name: delete season, abort draft, reset
playoffs, regenerate schedule, remove captain. `window.confirm` focuses OK by
default — one Enter — and looks identical whether it guards "Rename team" or a
cascade delete of a season, which is exactly the distinction that matters.
Do NOT reach for DangerSubmit on a reversible action; the fatigue it would
rebuild is the thing it exists to break. `danger-submit.test.ts` pins the
wiring, the exact-match rule and the "no magic word" rule (`token` must be a
real name, never "DELETE"); `e2e-mid/danger.spec.ts` proves in a browser that
the form cannot submit until the token matches and that Enter can't complete it.

**Confirms must name the real numbers, read from the database.** `loadSeasonAdminData`
returns `collateral` (check-ins / pick'em picks / standin bookings / open
proposals on regular fixtures) purely so the regenerate and remove-captain
dialogs can state what dies BEFORE the click, not just in the toast afterwards.

**Split a destructive control away from its harmless twin.** Start/Reset
playoffs and Generate/Regenerate schedule were each ONE button whose meaning
flipped with state, in the same pixel — muscle memory aimed at the safe one hit
the other. They are separate controls now; keep them that way.

**Copy that names a control must name a real one.** That class appeared four
times ("Detect games" for a button called "Auto-fetch games", "Add game by match
ID", "Start next season", a "Remove" that only exists on one of three webhook
fields). `src/app/admin/admin-copy-guard.test.ts` parses the admin sources and
fails on any of them, and on copy asserting the draft can't be undone (abortDraft
undoes it) or that the soft MMR limit refuses signups (it doesn't).

**`adminNextStep` (`src/lib/admin-next-step.ts`, pure, tested) is the panel's
roadmap** — one "what do I do next?" line per phase. It exists because several
transitions are silent and fail QUIETLY: the auction finishing does not advance
the phase, a schedule with no kickoff times disables auto-sync/reminders/pick'em
locks for the whole season, nothing prompted "start the playoffs" or "record the
final", and COMPLETE was a dead end whose only exit sat in a collapsed section.

**Two safety nets that did not exist.** `GET /api/admin/season-export` downloads
a whole season as JSON including box scores (the part that cannot be re-fetched
once OpenDota ages them out) — it is the only backup behind `deleteSeason`,
since `npm run db:backup` cannot run against production from a serverless host.
Deliberately an EXPORT, not a restore. And `AdminAction` + `logAdminAction`
(`src/lib/admin-log.ts`) records who did what: append-only, best-effort (a
failed log must NEVER fail the mutation it describes), written from ONE helper
that resolves the actor from the session rather than threading it through
sixteen signatures, and with NO foreign key to Season — the record of a deletion
has to outlive the thing deleted.

**Pre-delete archives must MERGE, never replace.** `createPlayoffBracket` stashes
the deleted playoff games' `dotaMatchId`s so the postseason can be re-imported.
The first version overwrote the row, so the likeliest repair sequence — reset,
re-import one game to check, reset again — left one id and destroyed the rest,
at the exact moment an admin was repairing something. Union by id; it may only
ever grow.

Also here: `removeGame` writes an `importSkip:<seasonId>` memory BEFORE deleting
(both importers decide "already recorded" from the Game rows, so without it
auto-sync re-imported the removed game within a minute — the panel's own repair
path did not work); a standin can fill an EMPTY seat (`replacingUserId: null` +
an explicit `teamId`, guarded on the seat actually being open and one standin
per seat) which is how a short roster gets covered at all; and `clashesAfterRetime`
reports a standin double-booked by a retime, since `standinConflict` is only
checked when cover is arranged and every retime path could move a fixture onto
a night they were already booked for.

## The 2026-07-31 audit and what it changed (read before re-litigating any of it)

A 44-agent trace→verify→refute audit of the whole codebase, then a fix pass.
The audit's own verdict: **a season runs start to finish for every actor** —
the gaps were off-happy-path TOOLING and a family of read-time-only guards.
Ten confirmed majors (each survived an independent refutation attempt) and
three untested destructive guards were closed; the fixes below are load-bearing
and several encode a rule worth keeping.

**The DRAFT trap — the one exit-free state this app had.** `setSeasonPhase`'s
backward-into-DRAFT results refusal used to key on `draft?.status === COMPLETE`,
so a NULL draft row (the hand-run league) or a NOT_STARTED one (post-abort)
walked straight past it — and `startDraft` checked neither phase nor results.
One click then opened a live auction over a played league, and the trap closed:
`abortDraft` refuses over results, and the phase guard refuses to leave DRAFT
mid-auction. Both halves are fixed: the refusal keys on `target === DRAFT`
alone (IN_PROGRESS/PAUSED exempt — that flip is the stranded-auction REPAIR),
and `startDraft` carries the same played/games pair read-time AND re-asserted
in its transaction. **`setSeasonPhase`'s write is now a guarded claim**
(`updateMany` re-asserting the phase the guards judged) — it was the last blind
lifecycle write, and its rivals are real (a concurrent `startDraft`; a
PLAYOFFS→REGULAR_SEASON flip eating the crowning claim).

**Archived seasons are read-only for captains.** `match-report-service`,
`reschedule-service` (propose + ACCEPT; decline/withdraw stay legal as cleanup)
and `setAvailability` now carry the archived-season refusal that only
`standin-service` had, with matching render gates on the match page. Without
it a captain on last season's unplayed fixture could import a game — which runs
`recomputeSeries` → the bracket → every cross-season board.

**Money surface: `voidLastResult` takes an explicit `lobbyId`** and
`/inhouse/history` renders a per-row admin Void. The room button (gated on the
viewer having PLAYED the game, within 10 minutes) meant the documented use case
— players report a wrong auto-import to an admin who wasn't one of the ten —
had no reachable control at all.

**Import correctness, three fixes.** `updateDotaAccount`'s collision check now
matches steam-DERIVED ids (most users have no override, so B pasting A's
Dotabuff URL found nothing), backed by a nullable `@unique` on
`User.dotaAccountId` with a P2002 catch. A PLAYER→STANDIN flip is refused while
the auction runs, and `resolveExpiredNomination` voids a non-PLAYER lot — the
on-the-block player could flip on /me, rendering a headless lot that still
CHARGED the team and minted a rostered STANDIN. And **`syncLeagueGames` buffers
candidates per fixture and runs `pickSeriesGames`** — the clinch-stop protected
only the roster-scan path, while the league feed lists NEWEST FIRST, so a
"one for fun" game after a decided night imported BEFORE the real ones and a
2-0 went into the record as 2-1.

**`advancePlayoffBracket`'s round build is Serializable and re-asserts its
inputs in-transaction** (the round's rows still exist, same winners, season
still PLAYOFFS). Reset deletes the round markers first, so a stale advance's
marker create used to SUCCEED and pair pre-reset winners into the fresh
bracket — a phantom round that `maxRound` then points at forever: no champion,
ever, and the only repair was another reset.

**Stale cover, the reverse direction.** `signFreeAgent` cancels now-redundant
EMPTY-SEAT bookings when the signing fills the last seat (started series kept
and reported — the `releasePlayer` rule), with stand-downs. Left behind, they
made the refilled side compute as teamSize+1 in `matchNightRoster`, the week
reminder AND `gatherTeamAccounts`' import set.

**Dead heats are visible.** `computeStandings` sets `idDecided` on rows whose
order fell to the team-id fallback; the table shows a "tied" chip and the
Start/Reset-playoffs confirms name the tied teams when the heat touches the
seeding. There is still no seed-override tool — the levers are correcting a
result or accepting the flip, and the copy says so.

**Three destructive guards had ZERO coverage** and are now pinned by
sabotage-verified tests: the playoff reset's round-marker cleanup (reset →
advance → champion), `deleteSeason`'s archived-ness re-assert + rollback, and
`generateSchedule`'s results gate (both halves). Two new race-hook seams exist
for them: `admin.deleteSeason.beforeTx` and `admin.generateSchedule.beforeTx`.
`setAvailability` got its first tests at the same time.

## Forfeits, team dropout, double round robin (2026-08-01)

The product gaps the audit named. Each is small and each has a rule:

- **`Match.forfeit` — a ruled score, and the flag is what keeps it honest.**
  Points and W-L count normally; the game scores are EXCLUDED from `gameDiff`
  (and from `headToHeadRanks`' mini-diff, and from `powerRankings`' per-game
  Elo — in the LIB, not a caller's filter). Otherwise an admin's choice of
  default score silently decides the tiebreak and the power rankings. Set by
  `recordResult`'s checkbox, CLEARED by `reopenMatch` (a reopened ruling must
  not survive into the next result) and by re-saving with the box unticked.
  Badged on /schedule ("ff"), the match page, and the admin row; the Discord
  result message says "by forfeit". `MatchLike.forfeit` and
  `RankableMatch.forfeit` are OPTIONAL so hand-built rows and older snapshots
  stay valid.
- **`withdrawTeam` / `reinstateTeam` — the team-dropout tool.** REGULAR_SEASON
  only (pre-season the tool is `removeCaptain`, which deletes the empty team;
  a playoff slot needs an explicit per-match ruling, and the error says which).
  One action forfeits every unplayed REGULAR fixture 0-N to the opponent,
  cancels open proposals on them, and flags `Team.withdrawn`. **The flag is
  what excludes the team from playoff seeding** (`createPlayoffBracket` filters
  it, and the bracket size shrinks with the field) — the standings CAN'T do
  that job, because a team that banked points before dying can out-rank the
  cut, and its played results are real so the table keeps showing it, badged
  "withdrew". Every forfeit leg re-asserts `status: { not: COMPLETED }` in its
  WHERE, so a real result landing mid-click WINS and is counted honestly in
  the toast rather than overwritten. Seam: `admin.withdrawTeam.beforeTx`.
  **That guard's test had to be RACED** — the staged version (complete a match
  before calling) passes against a blind write, because the action's own
  read-time filter excludes it. Verified by sabotage in both directions.
- **Double round robin is finally reachable**: `roundRobin(ids, doubleRound)`
  was built and unit-tested from the start, but no caller ever passed the flag
  — a 4-6 team league was locked to a 3-5 week season. It is a checkbox on
  Generate schedule now, and the toast names the week count. DECIDE BEFORE
  GENERATING: switching later is a full Regenerate, which clears every
  check-in, pick and booking on the old fixtures.
- **Pre-draft standin promotion renders.** `promoteGateError` always blessed
  the window before the auction ("they'll be auctioned normally"), but
  `rosterMovesVisible` hid the card for the whole DRAFT phase until the draft
  was COMPLETE — so the most natural late-joiner timing (registered the week
  before draft night) was undeliverable through any control. The card now shows
  in DRAFT pre-start with ONLY the promote form; sign/release would refuse
  there, and rendering controls that can only error is the class this panel
  keeps getting rebuilt to avoid.
- **Admin MMR edits render until the draft STARTS**, not just during SIGNUPS —
  the DRAFT-pre-start window is exactly when a typo still skews every
  MMR-weighted budget.
- **Standin signups are moderatable**: the admin signups card lists registered
  STANDINs with the same remove form plus an MMR edit that is deliberately NOT
  draft-gated (standins register in every phase). `withdrawSignup` never had a
  type gate — this was a missing render, and it meant a troll standin sat in
  every dropdown all season.

## Pre-draft-night hardening (2026-08-01 — a 28-agent audit of the draft path)

Run because a REAL draft with live players was imminent. 15 findings survived
adversarial verification (1 major, rest minor/notes); the ones a single-admin
draft night could actually hit were fixed, each sabotage-verified:

- **The compact clock bar now attaches for tabs that watched the waiting-room
  → live flip** (the one MAJOR). `useBannerOffscreen` used a plain `useRef` +
  an `[active]`-keyed effect, and the draft room passes `status !== COMPLETE`
  — already true in the waiting room, whose branch renders no banner element.
  So every tab parked on /draft before Start (the documented, encouraged flow)
  ran the effect once against a null ref and NEVER got the sticky bar: on
  phones, captains scrolled into the pool had no clock and no one-tap Bid for
  the whole auction, silently. The hook now tracks the element in state via a
  CALLBACK ref and re-attaches when it appears — the fix covers the inhouse
  callers too. Pinned in zz-admin-draft.spec.ts on exactly a parked-then-
  flipped tab.
- **`nominatePlayer`'s claim re-asserts the TURN it authorized against**
  (nominatorTeamId AND nominationEndsAt — the applyPick/pickEndsAt lesson:
  the rotation can hand the SAME team a fresh turn, so team id alone doesn't
  identify one). The one rival that moves the turn while leaving the lot
  empty is undoLastSale's repoint; a stale in-flight nomination used to land
  out of turn and steal the make-good nomination the undo's toast had just
  promised the refunded buyer. Seam `draft.nominatePlayer.beforeClaim`,
  Postgres-only test in draft.itest.ts.
- **`startDraft`'s one-shot is claimed at the WRITE**: the blind `upsert` is
  now a CREATE (loses on the seasonId unique, P2002) / guarded `updateMany`
  re-asserting NOT_STARTED (the post-abort door) split; either loss throws
  `DraftAlreadyStartedError`, rolling back the budget + phase writes, so two
  overlapping Starts arm the auction once and announce once. Raced tests for
  both doors. Its in-tx results recount ALSO gained the seam it lacked
  (`admin.startDraft.beforeTx`) — it was a ratchet-invisible throw-guard with
  no test, i.e. deletable with every suite green. Same seam treatment for
  `removeCaptain` (`admin.removeCaptain.beforeTx`).
- **`undoLastSale`'s roster delete is a `deleteMany` + count check** — two
  racing Undos (or Undo racing an abort) made the loser die on a raw P2025,
  blowing that admin's panel to the error page mid-dispute. First write in
  the tx, so a zero count safely RETURNS a typed refusal (nothing written).
- **`saveRegistration`'s draft-night lock now covers all three doors** while
  the auction is IN_PROGRESS/PAUSED: type flips (as before), a WITHDRAWN
  PLAYER re-activating by direct POST (the /me UI blocked it; a replayed POST
  didn't — self-serve pool injection between lots), and the MMR field, which
  is FROZEN (not refused — role/hero/note edits stay useful to bidding
  captains) with a toast note, because getDraftState re-reads it every poll
  into the pool sort + resolveStalledNomination's top-MMR auto-pick, and the
  admin Edit-MMR counter-control is deliberately hidden once the draft starts.
- **Coverage debts named by the audit, paid**: withdrawSignup's on-the-block
  refusal (an inline early-return NO test exercised — the pure-gate unit test
  its comment pointed at covers a branch the admin path never runs; comment
  corrected) and the void-lot guard's STATUS half (only the type half was
  pinned; deleting `nomReg.status === "ACTIVE"` passed the whole suite).
- The admin auto-nominate button no longer renders while PAUSED (it could
  only walk the admin through the confirm into "Draft is not live").

**Deferred deliberately — two-admin sub-second races, all recoverable via
abortDraft pre-results, none reachable with one admin driving draft night**
(don't rediscover these as new): captain-management actions (add/remove/
transfer/randomize/setDraftSettings) hold only read-time draft-status locks
against a CONCURRENT startDraft; two concurrent addCaptains can mint a
duplicate draftOrder (the real fix is `@@unique([seasonId, draftOrder])` — a
schema change deliberately not shipped hours before a live draft);
setSeasonPhase's claim can't see a same-value DRAFT rival (startDraft writes
status=DRAFT blindly, so a concurrent flip out of DRAFT still matches its
WHERE); signFreeAgent/releasePlayer check draft-COMPLETE read-time only
against a concurrent undoLastSale reopen.

## Standins & replacement hardening (2026-08-02 — a 35-agent audit, then the fix pass)

An 8-lens audit (captain / admin / the standin themselves / permanent
replacement / phase coverage / integrity / notifications / eligibility) with
adversarial verification: 25 confirmed findings, all fixed or explicitly
deferred below. The rules that came out of it:

- **Assignment now has a PHASE GATE; removal deliberately does not.**
  `assignStandinGuarded` refuses SIGNUPS ("run the draft first"), DRAFT with
  the auction not COMPLETE, and COMPLETE seasons — judged AFTER the
  archived/completed-match refusals so the more specific error wins. The
  DRAFT-with-auction-COMPLETE window stays open (pool-dry short rosters
  arranging week-1 cover). Removal stays legal in EVERY phase and on archived
  seasons: it is cleanup, and a stale booking blocks its standin's own
  withdrawal. Both assign forms (match page + admin card) mirror the gate
  (render/guard pairing) while keeping the assignments list + remove rendered.
- **Every path that kills a booking or its fixture stands the standin down.**
  `withdrawTeam` (filtered to fixtures whose forfeit claim WON — a result
  landing mid-click keeps its booking silently), `recordResult` with the
  forfeit flag on a zero-games match (a played-but-private manual score must
  NOT stand down someone who actually played), and `abortDraft` (deletes every
  season booking in-tx — cover keyed to dissolved rosters is stale by
  definition, and an empty-seat booking surviving into the re-run auction
  inflates a drafted side to six) all send `standinRemovedMessage` +
  `mentionsOf` post-commit. See the count rule in the Discord section.
- **`signFreeAgent` reconciles cover on PARTIAL refills too — by REPORTING.**
  The last-seat case still auto-cancels (every empty-seat booking is
  unambiguously redundant); a partial refill (3/5 → 4/5 under 2 bookings)
  REPORTS the per-match surplus in the toast instead of guessing which
  booking dies (the withdrawGateError refuse-don't-auto-cancel precedent).
  Surplus is per-MATCH: bookings live on matches, seats on the roster.
- **The assign-vs-release write-skew pair is closed on both sides.**
  `releasePlayer` runs Serializable (it was the ONE roster-move transaction
  that didn't) with a claim-first `deleteMany` + typed throw (the undoLastSale
  P2025 lesson), and `assignStandinGuarded` re-reads the REPLACED player's
  TeamMember inside its transaction (":328 said 'EVERY precondition is
  re-read in here' and was wrong about its own transaction"). Raced coverage:
  `test/integration/standins-raced.itest.ts` — same-seat, open-seat-budget,
  same-night, assign-vs-release, assign-vs-leaveLeague; **SQLite runs them
  sequentially, only `npm run test:pg` exercises them** (raceAll's contract).
- **`promoteStandinToPlayer` is a guarded claim** (`updateMany` re-asserting
  ACTIVE+STANDIN; the standin can self-withdraw on /me mid-click) with seam
  `admin.promoteStandin.beforeWrite`. The Start-draft rival (Draft table) is
  deliberately not closed — a promote at auction-second-zero is materially
  the pre-start promote the gate blesses.
- **`withdrawGateError` takes `audience`** — "admin" (default, byte-identical
  strings) vs "self" (second person, prescribes only actions the player can
  take: "ask that team's captain or an admin"). leaveLeague passes "self".
  Extend the same way if a new surface shows gate errors to players.
- **MMR advisory, never a block**: `standinMmrNote` (`standin.ts`, tested) —
  named cover flags a ≥`STANDIN_MMR_FLAG_GAP` (500) gap over the REPLACED
  player's registration MMR; empty seats compare against `Season.maxMmr`
  (0 = silent); unknown (0) MMR never flags. Toast-only by design.
- **Withdrawn teams**: excluded from the short-team alarm, the sign form and
  `rosterMovesVisible`'s short/canSign clauses (their "short" is permanent —
  the alarm would cry wolf all season); `signFreeAgent` refuses them
  read-time; releasing their players stays available (it's the documented
  cleanup — the withdrawTeam toast now says so, since their players are the
  league's most natural standin pool and rostered players can't stand in).
- **Notification parity for permanent moves**: `freeAgentSignedMessage`
  mentions the signed player and ends naming their next move (check in,
  /schedule link); the sign toast carries `reachabilityNote`. A reschedule
  ACCEPT mentions the match's booked standins alongside the proposer (their
  assignment ping quoted the OLD kickoff — this is the send that corrects
  it); `AcceptedReschedule.standinUserIds` carries the ids. `playerOutMessage`
  and `standinAssignedMessage` carry `<site>/matches/<id>` deep links (the
  week-reminder shape — angle-bracketed, no unfurl).
- **Visibility**: the admin standin card renders pairwise double-booking
  clashes recomputed from live data (retimes made the toast-only report
  vanish on the wrong person) and alerts on an assigned standin who RSVPs
  OUT (the roster filter deliberately excludes them, so the seat read as
  covered while the cover had quit); the captain's match-page card opens with
  "✗ Out and uncovered" for their own roster; the picker options carry
  roles + "no Discord"; /players' standin cards show contact (signed-in
  gated); /me's cover card keys on ACTIVE+unrostered, not type (undrafted
  PLAYER free agents are legal cover), with the bare card still standin-only;
  profiles get a "Stood in — N matches covered" season line (COMPLETED
  matches only — recognition is the cheapest standin-recruitment tool).
- **Honest dead-end copy**: a mid-series swap is impossible by design (remove
  refuses once games import; the seat conflict error says "can't be swapped —
  the remaining games record whoever actually plays" instead of pointing at
  the refusing control; releasePlayer's kept-cover note matches). The
  first-import race window in `removeStandinGuarded` is DOCUMENTED beside the
  WHERE rather than implied closed (closing it needs the import side to
  re-assert the assignment set — do that there if it ever matters).

**Deferred deliberately** (don't rediscover as new): a mid-series standin
SWAP tool (the copy now tells the truth instead; build it only if a real
season hits the emergency twice); relaxing "rostered players can't stand in"
for withdrawn-team members (reinstateTeam would resurrect the double-agent
hazard — release is the path, and the toast points at it); MMR advisory in
the Discord announcement (toast-only for now); auto-cancelling surplus
partial-refill bookings (report-only, captain owns the choice).

## Good next steps

- **Open product decisions** (the audit named them; each needs a call, not
  code-first): an exclusion/ban layer (inhouse `joinQueue` has no ban concept
  and no points-dock tool exists — deliberately deferred until the league
  actually has a griefer, since standin removal, the acute case, is fixed); a
  captain-initiated forfeit claim (the flag exists, the captain path doesn't);
  archiving each season's fantasy and pick'em WINNERS (both pages are keyed to
  the active season with no `?season=`, so those two side-games conclude with
  no recorded winner anywhere once N+1 is created); a player-visible
  rules/settings page.
- **Known minors worth a sweep** (full list in the audit's findings doc —
  three earlier entries here were already FIXED and kept being re-cited, so
  this list is now only what's actually open): the champion announcement has
  no failure retry (series results do); a late-arriving Divine medal
  permanently locks an admitted player's /me form; `seasonScenarioReport`
  recomputes uncached on four hot pages. Fixed and struck: declined
  reschedules announce (`rescheduleDeclinedMessage`), released players are
  @-mentioned, and `removeGame`/`reopenMatch` both bump the result cursor.
- Production deploy config (swap SQLite → Postgres, real Steam key).
- Optional: sync from a Valve `leagueid` (field exists on `Season`) if the
  league ever gets ticketed — `/leagues/{id}/matches` + `classifyGame`.
