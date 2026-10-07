# Concurrency guards, race tests and the mutation ratchet

How GGD2L keeps concurrent writes safe on Postgres, how to test a guard so the
test fails without it, and the mutation ratchet CI uses to keep those tests
honest. Main files: `scripts/mutation-guard.mjs` (ratchet, `FILES`, `EQUIVALENT`),
`scripts/mutation-claims.mjs` (claim ids, renames, killers),
`test/mutation-baseline.json`, `src/lib/race-hook.ts` and
`test/integration/factories.ts` (`ON_POSTGRES`, `raceAll`, `raceN`).

## The two rules

Production is Postgres; dev, integration tests and e2e are SQLite, which
serializes writers and hides every race here.

- **Re-assert a read-time precondition in the WHERE of the write.** READ
  COMMITTED re-snapshots per statement, so a checked fact can be false when the
  write lands. Write `updateMany({ where: { id, ...what you checked } })` and
  handle `count === 0`. For a precondition in another table (a write-skew pair),
  re-read it inside a `Serializable` transaction on BOTH sides; SSI only sees the
  cycle when each side reads the other's table.
- **After the first write, throw; never return.** A resolved interactive
  transaction callback commits, so `return { ok: false }` persists the half-done
  state. Throw a typed error and catch it outside the callback (on Postgres a
  query error has already poisoned the transaction anyway).
- **Use a relation filter for a fact about a related row.** `acceptMatch` claims
  with `lobby: { status: READY_CHECK }`, `reopenMatch` with `games: { none: {} }`.
  Without the latter, a game imported mid-reopen leaves a SCHEDULED 0-0 match
  with a Game row that nothing repairs (`importGameForMatch` dedupes on
  `dotaMatchId`, so `recomputeSeries` never runs again).
- **Never report success on a lost claim.** `leaveLeague` throws `NOT_ACTIVE` when
  its claim loses, so a player removed mid-withdrawal is not told "Withdrawn".
- **Wait before retrying a Serializable abort.** Postgres often cancels the
  loser while the winner is still committing. A retry whose snapshot starts
  before that commit lands reads the winner's rows as in flight and is
  cancelled against the same pivot again ("Canceled on conflict out to pivot
  …, during read"). The ready check's last two answers lost three immediate
  retries in a row that way in CI. `retrySerializable`
  (`src/lib/serializable-retry.ts`) waits a jittered, doubling interval (5–10
  ms, then 10–20, …) and rethrows the last conflict for the caller's "reload
  and try again". Use it for a new retry; `grep -rn "retrySerializable(" src`
  lists the callers.

Worked examples, with the damage each guard prevents: `applyPick` (frozen
inhouse draft), `undoLastSale` (live lot and nomination clock at once),
`advancePlayoffBracket` (round built twice, so no champion), `recomputeSeries`
(stale caller reverts a completed series), `recordResult` (manual score over an
auto-import), `assignStandinGuarded` (double-covered seat), and `deleteSeason`
(`admin-season.ts`) / `generateSchedule` (`admin-schedule-results.ts`)
(destructive work past a stale safety check).

## Race tests and seams

- **Race the calls; never stage the conflict.** A pre-created conflicting row is
  caught by the function's own read-time check, so the test passes against broken
  code. Use `raceAll` / `raceN`, loop when the losing order is rare, and assert
  the invariant. `raceAll` is concurrent only on Postgres (SQLite pins one
  connection and would queue or time out), so `npm run test:pg` is the real run.
- **When either order is legitimate, a raced test can only check that each
  outcome is whole.** An accept that commits before a result is a real
  retime-then-play, so the end state cannot tell it from a stale accept; the
  reschedule race test assumed it could and failed about once in 150 rounds.
  Pin the stale order with a seam (`reschedule.respondReschedule.beforeAccept`).
- **Use a seam when racing cannot hit the interleaving.** The service awaits
  `raceHook("area.function.point")` between its read and its guarded write; the
  test installs `setRaceHook(onceAt(label, rival))` and clears it in `afterEach`.
  `setRaceHook` throws outside `NODE_ENV=test`; `src/lib/race-hook.test.ts` pins
  that, the no-hook no-op and `onceAt` firing once for its label.
- **Assert a `fired` flag.** A drifted label otherwise leaves a test that passes
  while measuring nothing.
- **Never let the rival touch a row the open transaction already wrote.** It runs
  on another connection and blocks on that lock while the transaction waits on the
  hook: a hang, not a failure.
- **Keep in-transaction seams Postgres-only** (`describe.skipIf(!ON_POSTGRES)`);
  on SQLite any rival write there hangs. Pre-transaction seams run on both
  providers (`registration.leaveLeague.beforeWithdraw`,
  `resultSync.syncDueMatches.beforeMatchClaim`).
- **Fire the seam before a Serializable transaction when the rival writes the same
  row.** A rival after the snapshot makes guarded and blind versions both fail
  with P2034, so the predicate is unobservable. `leaveLeague` hooks before its
  `$transaction` for this reason; its rival is an admin removal, which a blind
  write would turn from REMOVED into a WITHDRAWN the player can re-register from.

## Lessons for closing a guard gap

- **"Something upstream serializes this" only covers rivals from the SAME path.**
  List rivals from other paths first. `syncDueMatches`' `rosterAutoSyncAt`
  throttle serializes auto-sync runs, but an admin forfeit, a captain import or
  the league feed can decide the series between its `due` read and its claim, and
  `autoDetectGamesForMatch` has no completed check of its own. The seam test's
  decisive assertion is that OpenDota was never called.
- **Across a network round trip, read-time checks go stale; the CAS enforces.**
  `claimBoardRow` and `swapState` (`src/lib/inhouse-board-service.ts`) span a
  Discord call, so the compare-and-swap on the exact previous row value is the
  only write-time re-assertion.
- **Pick a rival that leaves a row the blind write can match.**
  `setSetting(key, "")` DELETES the row (`src/lib/settings.ts`) and an
  `updateMany` cannot resurrect it, so a plain board Remove is the one rival a
  blind write survives. Remove AND re-post exposes it (the blind write points the
  new row at a deleted message). The takeover rival is a second admin's post
  completing in the gap (`inhouseBoard.claimBoardRow.beforeTakeover`). Both tests
  assert the POST COUNT, since an orphan is one extra post.
- **Delete a redundant read-time check so the claim is the enforcement point.** An
  `if` that repeats the WHERE stops every test before the claim, so the test passes
  with the WHERE deleted. `saveRegistration`'s `status: { not: REMOVED }` is the
  model: one enforcement point, a deterministic test, no seam, runs on SQLite. If
  you keep the check for a clearer error (as `reopenMatch` does), put a seam
  between it and the write.
- **A belt-and-braces half of a claim needs no test of its own.** The ratchet
  deletes all of a claim's state keys together, so `syncDueMatches`' `OR` on
  `autoSyncedAt` rides on the `status` half's test.
- **Name the rival in each seam test.** `recomputeSeries`
  (`match-import.recomputeSeries.beforeSwap`): a rival imports the clinching game;
  the stale caller must not revert a COMPLETED 2-0 to LIVE 1-0.
  `startCaptainVote` (`inhouse.startCaptainVote.beforeFlip`): a decline cancels the
  ready check; a blind flip resurrects the lobby while its ten are queued.

## Proving a claim equivalent

- **Give every equivalent claim a checkable reason in `EQUIVALENT`.** Its predicate
  can be deleted without changing any committed end state, so no test can kill it,
  and that looks exactly like an untested gap. Keep the predicate in the code as
  defense in depth.
- **Common reasons:** the same row is read then written in one `Serializable`
  transaction (a rival fails the fresh check or forces P2034; a race test still
  pins the one-winner result); an earlier write in the transaction already holds
  the row lock; a random `claimToken` set with SENDING fences a stale outbox worker.
- **Pin the argument with a test.** `applyPick::status#1` is equivalent because the
  turn claim earlier in the transaction holds the lobby row lock. "the DRAFTING
  re-assert cannot be falsified" (`test/integration/inhouse.itest.ts`) proves it;
  copy its parts: `SELECT ... FOR UPDATE NOWAIT` turns "would block" into an
  instant `55P03` (a plain rival UPDATE would hang the suite); a positive control
  runs the statement outside the seam first (else a typo'd table name reads as a
  lock); a `fired` flag and a check for the lock error. If it goes red, the claim
  is a real gap again.

## The mutation ratchet

- **What it checks.** It deletes each protected guard and requires the Postgres
  suite to fail. It fails on a protected claim no longer caught, a protected claim
  that DISAPPEARED, an unclassified live claim, or a malformed, unsorted or stale
  baseline (including `totalClaims`).
- **What a claim is.** An `updateMany({ where })` with a top-level WHERE key outside
  `IDENTITY` (`id`, `seasonId`, `userId`, `key`, ...); the mutant drops all those
  keys. The one other shape is `claimThrottle`'s conditional SQL
  (`scripts/mutation-sql-claims.mjs`).
- **Sabotage-test every other guard shape by hand.** An early `return { error }`,
  a count-then-`throw` in a transaction, a `deleteMany` claim or a unique
  constraint are invisible to it. Delete the guard and confirm the integration
  test goes red. "Every claim protected" is not "every guard gated".
- **Ids are `file::topLevelFunction::sortedStateKeys#ordinal`,** anchored on the
  TypeScript syntax tree so comments and inner helpers never anchor (pinned by
  `scripts/mutation-claims.test.mjs`, in `npm run test:scripts`). Never use
  positional ids: a deleted guard's id re-binds to the next claim and hides it.
- **Record a moved or renamed guarded function in `renames`** (`{ "<old id>":
  "<new id>" }`) instead of a full `--discover`. It carries the classification,
  not the evidence; verify still mutates the new home. Only the file and function
  may change (a new signature or ordinal is a weakened guard). Rename a moved
  equivalent in `EQUIVALENT` too. The next full `--discover` folds renames in.
- **List every claim-bearing file in `FILES`;** a source sweep fails otherwise.
- **Classify a new claim before it lands.** Kill it with a race or seam test, or
  justify it in `EQUIVALENT`, then run a full `--discover` on Postgres. Discover
  confirms a new kill twice and will not write the baseline while any claim is
  unprotected. Removing a guard fails verify until the baseline changes.
- **Killers change the order, not the verdict.** Discover records each protected
  claim's first failing test file; verify runs it alone with `--bail` (after it
  passes alone unmutated) and falls back to the whole suite if it does not fail.
  A preflight first proves the unmutated suite green, and each mutant is a fresh
  `vitest run`, which is why a full sweep is slow. When the preflight fails, the
  runner lists each failed test and the first line of its failure (the suite
  runs `--silent`), so a flake that does not repeat still names its test.
- **Read counts from the source.** `node scripts/mutation-guard.mjs --static`
  checks the inventory without Postgres and prints the counts.
- **CI.** The test job always runs `--static`. The four `mutation guard N/4`
  shards (`ci.yml`) skip only when the trusted classifier reports
  `needs_mutation: false`. `release:both` accepts that skip only on the trusted
  production classification or an earlier main commit's passing shards for a
  mutation-neutral delta (README has the recovery). `mutation-nightly.yml` verifies
  everything daily at 07:00 UTC. Keep the job names; `release:both` reads them.
- **The runner owns guarded files while it runs.** It mutates them in place; do
  not edit or interrupt it, and inspect the diff after any abnormal end.
- **`--only` is a probe.** It never writes the baseline and is refused in verify
  mode. Only a full `--discover` rewrites it. Verify is the longest run; shard it
  with `--shard i/n`.

## Running Postgres tests locally

The provider switch is a footgun if you forget to switch back. (Database names
keep the old `ld2l_` prefix.)

    npm run pg:up            # create the DB, switch provider, migrate, generate
    export PG_TEST_URL="postgresql://$USER@localhost:5432/ld2l_pgtest"
    npm run test:pg                          # the integration suite on Postgres
    npm run test:mutation                    # verify the whole baseline
    npm run test:mutation -- --shard 2/4     # one CI shard
    npm run test:mutation -- --discover --only acceptMatch   # probe one claim
    npm run pg:down          # back to SQLite and drop the DB; never skip this
    unset PG_TEST_URL

- **Always run `pg:down`.** Otherwise `prisma/schema.prisma` stays on postgresql,
  the SQLite suites break, and `git add -A` commits it. Check `git status --short`.
- **Point `PG_TEST_URL` only at a disposable local database.** The suite wipes
  every table. `assertPostgresTestUrl` accepts only `ld2l_test` or `ld2l_pgtest`,
  and `pg:up`/`pg:down` require localhost. Never use a production or shared URL,
  and never paste a credential-bearing URL into a command line or shell history.
- **Slow the commits to flush out a retry flake.** A CI runner's disk can
  hold a commit open far longer than a laptop's. `psql -d postgres -c "ALTER
  DATABASE ld2l_pgtest SET commit_delay = 20000" -c "ALTER DATABASE
  ld2l_pgtest SET commit_siblings = 0"` (superuser) makes every commit wait
  before it flushes (on macOS each COMMIT then takes 20–100 ms); `pg:down`
  drops the setting with the database. With it, the ready check's contention
  test failed 10 of 10 runs with three immediate retries and passed 30 of 30
  with `retrySerializable`.
