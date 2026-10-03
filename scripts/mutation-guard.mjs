// Mutation guard — a RATCHET over the repo's guarded claims.
//
// A "guarded claim" is an `updateMany({ where: … })` whose WHERE carries a
// STATE predicate (a status, a null-check, a timestamp) on top of the identity
// keys. That predicate IS the concurrency guard: strip it and the claim becomes
// a blind write, which is this codebase's dominant bug class (see CLAUDE.md's
// "Concurrency: the two rules").
// claimThrottle expresses the same guard in a conditional SQL upsert; its
// narrow companion scanner keeps that existing claim in this same ratchet.
//
// The problem it solves: those guards are almost invisible to the test suite.
// SQLite serializes writers, so most races cannot even be produced there, and a
// test that merely exercises the happy path passes just as well with the guard
// deleted. Measured, only a handful of claims had any test that would notice.
//
// So this does the only honest check available: DELETE each guard and see
// whether the suite complains.
//
//   node scripts/mutation-guard.mjs --discover   # full sweep, rewrites the baseline
//   node scripts/mutation-guard.mjs --discover --only ID_SUBSTRING
//   node scripts/mutation-guard.mjs              # verify the baseline (what CI runs)
//   node scripts/mutation-guard.mjs --static     # inventory + baseline only, no Postgres
//
// Verify mode first requires EVERY live claim to appear exactly once in the
// baseline as either PROTECTED or a reviewed EQUIVALENT. It then re-mutates
// only the protected claims, so it costs ~1 suite run each rather than one per
// claim in the repo. A protected claim whose baseline `killers` entry names
// the test file that failed in the last full --discover runs that ONE file
// first; only when it does not fail does the whole suite run (see
// trustedKiller and measureMutant in ./mutation-claims.mjs). It fails when:
//   * a protected claim is no longer caught  → a test that protected it regressed
//   * a protected claim has DISAPPEARED      → the guard itself was removed
//   * a live claim is absent from the baseline → discovery was not reviewed
//   * the baseline is malformed, duplicated, stale, or only partly classified
// Raise the ratchet by writing a test and re-running --discover. A guard that
// only MOVED (its function renamed or moved to another file) keeps its
// classification through a baseline `renames` entry, see resolveRenames in
// ./mutation-claims.mjs, which also holds the claim-id rules.
//
// MUST run against Postgres (PG_TEST_URL). Several of these claims are only
// caught by RACED tests, and on SQLite those race calls serialize — the mutant
// survives and the ratchet would silently measure nothing.
//
// SAFETY: the runner mutates guarded source files in place and restores each
// from its opening snapshot. It must have exclusive ownership of every FILES
// entry while running and must not be interrupted. SIGKILL, power loss, or a
// concurrent edit can bypass/lose restoration; after any abnormal termination,
// inspect the exact source diff before resuming work.
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { assertPostgresTestUrl } from "./test-db-safety.mjs";
import {
  discoverClaims,
  failedTestsFromReport,
  killerFromReport,
  measureMutant,
  resolveKillers,
  resolveRenames,
  trustedKiller,
} from "./mutation-claims.mjs";

const BASELINE = "test/mutation-baseline.json";

/**
 * EQUIVALENT MUTANTS — claims whose predicate can be deleted without changing
 * the end state, so no test can ever kill them. Listing them keeps the score
 * honest: they are not gaps waiting for a test, they are guards that happen to
 * be redundant.
 *
 * Every entry needs a REASON that someone can re-check, because "equivalent"
 * is also what an untested gap looks like from here.
 */
const EQUIVALENT = new Set([
  // createSeason's broad archive runs after the transaction has read the full
  // active set. Dropping `isActive: true` merely writes false over rows already
  // archived; its one newly created row does not exist until the next statement.
  "src/app/actions/admin-season.ts::createSeason::isActive#1",
  // importGameForMatch reads Season.fantasyLockedAt through the fresh Match
  // graph and stamps that same Season row in its SERIALIZABLE import. A rival
  // lock either precedes the snapshot or forces P2034, so the null predicate
  // is a defense-in-depth statement of the one-way transition.
  "src/lib/match-import.ts::importGameForMatch::fantasyLockedAt#1",
  // startDraft reads the singleton Draft row and then claims that same row in
  // one SERIALIZABLE transaction. Two Starts that both observe NOT_STARTED
  // cannot both commit on Postgres: once one updates the row, the other's
  // write is aborted with P2034 even if `status: NOT_STARTED` is removed. The
  // guarded WHERE stays as defense in depth and documents the transition; the
  // two-start test (including the existing-row/after-abort branch) pins the
  // actual one-winner invariant and its one Discord announcement.
  "src/app/actions/admin-captains-draft.ts::startDraft::status#1",
  // undoLastSale reads Draft.status and nominatedUserId, performs its refund,
  // and reopens that same Draft row inside one SERIALIZABLE transaction. A
  // poller opening a lot in the gap changes the row and forces Undo to abort
  // with P2034, rolling the refund and roster deletion back, even if both
  // copied predicates are removed. The Postgres race test asserts the
  // no-live-lot-plus-nomination-clock invariant and all-or-nothing refund.
  "src/lib/draft-service.ts::undoLastSale::nominatedUserId+status#1",
  // Stage 3: voidCurrentLot reads and claims the same Draft row inside one
  // SERIALIZABLE transaction. Removing its copied state/lot fields still
  // cannot commit over a concurrent draft change; the write itself remains.
  // The renamed mutant survived the full PostgreSQL suite before review.
  "src/lib/draft-service.ts::voidCurrentLot::currentBid+currentBidTeamId+currentLotId+nominatedUserId+status+updatedAt#1",
  // All current draft-history writers run after the operational command has
  // claimed the singleton Draft, holding its row lock until commit. The legacy
  // undo bootstrap is SERIALIZABLE and performs a lock-only Draft write before
  // allocating the run number. These mutants KEEP those writes: deleting the
  // fields is equivalent, deleting the write would not be. Receipt/run/lot
  // transitions cannot interleave while that lock is held; settle and void
  // additionally validate the OPEN lot before writing. Each new predicate was
  // sabotaged against PostgreSQL before classification. Do not extend this to
  // abortDraftHistory's bulk membership filters: those select historical rows
  // semantically and have a protected released-sale regression.
  "src/lib/draft-history.ts::ensureDraftRun::activeRunId+updatedAt#1",
  "src/lib/draft-history.ts::openDraftLot::nextLotSequence+status#1",
  "src/lib/draft-history.ts::appendAcceptedDraftBid::acceptedBidsSnapshot+status#1",
  "src/lib/draft-history.ts::preserveUnrecordedOpenBids::acceptedBidsSnapshot+status#1",
  "src/lib/draft-history.ts::settleDraftLot::status#1",
  "src/lib/draft-history.ts::voidDraftLot::status#1",
  // Tenure closure follows the winning membership deletion/claim (or the
  // SERIALIZABLE abort), so no compliant second closer can reach this write.
  // Reconciliation freshly reads and writes the same tenure in SERIALIZABLE;
  // a competing close conflicts, while an already-closed row fails preflight.
  // These guards still document intent and defend inconsistent external data.
  "src/lib/roster-history.ts::closeRosterTenure::closedAt#1",
  "src/lib/roster-history.ts::backfillRosterTenures::closedAt+openKey#1",
  // Identity correction, its fresh administrator claim, provider-failure
  // bookkeeping and import-progress commands read the exact row before their
  // same-row write in SERIALIZABLE. Concurrent source/role/revision changes
  // therefore force rollback without the copied predicates.
  // Their write locks and fresh reads remain essential. In contrast, detached
  // provider success/decision snapshots and participant backfill source checks
  // are independently protected predicates, not covered by this equivalence.
  "src/lib/game-identity-correction.ts::correctGameIdentity::players#1",
  "src/lib/participant-admin.ts::claimParticipantAdmin::role#1",
  "src/lib/import-candidates.ts::recordImportFetchFailure::revision#1",
  "src/app/actions/import-progress.ts::changeImportCandidate::isActive+status#1",
  "src/app/actions/import-progress.ts::changeImportCandidate::attempts+payload+revision+status#1",
  // abortDraft likewise reads Draft (including updatedAt) and claims that
  // singleton row in one SERIALIZABLE transaction. A concurrent draft write
  // makes one abort fail serialization before either teardown can double-land,
  // even when the copied status/version predicates are removed. Its Postgres
  // N-way abort test requires one winner and one budget restoration.
  "src/lib/draft-service.ts::abortDraft::status+updatedAt#1",
  // Abort also reads and resets the same Season row inside that SERIALIZABLE
  // command. A phase/activation change conflicts and rolls the teardown back
  // even without the copied predicates, which remain defense in depth.
  "src/lib/draft-service.ts::abortDraft::isActive+status#1",
  // nominatePlayer now reads and claims Draft in one SERIALIZABLE transaction.
  // A rival nomination/turn change therefore aborts one writer even with the
  // copied status, lot, turn, clock and version predicates removed. Existing
  // nomination-vs-undo and N-way nomination tests pin the state-machine result.
  "src/lib/draft-service.ts::nominatePlayer::nominatedUserId+nominationEndsAt+nominatorTeamId+status+updatedAt#1",
  // joinScrim reads the exact OPEN offer (including opponentTeamId) and then
  // writes that same Scrim row inside one SERIALIZABLE transaction. A rival
  // join either wins before the snapshot and fails the fresh checks, or writes
  // after the read and forces P2034 even without the copied predicates. The
  // Postgres N-way join test pins one winner, one opponent, and one lineup.
  // Keeping both fields in production still documents the OPEN -> SCHEDULED
  // transition and adds defense in depth.
  "src/lib/scrim-service.ts::joinScrim::opponentTeamId+status#1",
  // cancelScrim likewise reads and authorizes the exact Scrim row before its
  // same-row write in a SERIALIZABLE transaction. A terminal/live change is
  // either visible to that fresh read or creates a serialization failure, so
  // deleting the copied status predicate cannot make a stale cancellation
  // commit. The predicate remains explicit state-machine documentation.
  "src/lib/scrim-service.ts::cancelScrim::status#1",
  // yieldScrimsToOfficialFixture runs inside the playoff build's SERIALIZABLE
  // transaction and cancels exactly the ids it just read as SCHEDULED there.
  // A rival that moves one of them (a game import making it LIVE, a captain
  // cancelling) either commits before the snapshot, so the read never selects
  // it, or after it, so the UPDATE of that row fails with P2034 whether or not
  // it carries the status predicate. SQLite serializes the whole transaction.
  // The count check stays as the explicit rollback if that ever changes.
  "src/lib/scrim-service.ts::yieldScrimsToOfficialFixture::status#1",
  // respondReschedule and cancelReschedule now read the PENDING request and
  // conditionally write that same row inside one SERIALIZABLE transaction.
  // Their same-row write conflicts make the copied `status: PENDING` WHERE
  // predicates redundant on Postgres: concurrent accept/decline/withdraw
  // attempts cannot both commit without them. Accept also reads and writes
  // Match in the same transaction, so the copied SCHEDULED predicate is
  // redundant against a concurrent result. The PG contention tests pin all
  // four one-winner / result-vs-retime invariants. These predicates remain in
  // production as executable state-machine documentation and defense in depth.
  "src/lib/reschedule-service.ts::cancelReschedule::status#1",
  "src/lib/reschedule-service.ts::respondReschedule::status#1",
  "src/lib/reschedule-service.ts::respondReschedule::status#2",
  "src/lib/reschedule-service.ts::respondReschedule::status#3",
  // These admin correction/phase claims were expanded while their authority
  // reads moved into SERIALIZABLE transactions. In every case the transaction
  // reads the same Season or Match row before writing it, so a concurrent
  // change forces P2034 even when the copied WHERE fields are removed. Their
  // deterministic seam/race tests assert rollback and the final state; keeping
  // the predicates in production still documents the exact transition.
  "src/app/actions/admin-schedule-results.ts::recordResult::awayScore+forfeit+homeScore+status+winnerTeamId#1",
  "src/app/actions/admin-schedule-results.ts::reopenMatch::games+season+status#1",
  "src/app/actions/admin-season.ts::setSeasonPhase::isActive+status#1",
  "src/app/actions/admin-schedule-results.ts::setWeekNight::scheduledAt+status#1",
  // These actions likewise read the authoritative Season, Match, Registration
  // or Team rows and write those same rows inside SERIALIZABLE transactions.
  // Pre-snapshot changes fail the fresh checks; post-read changes force P2034,
  // so copied state fields cannot change a committed outcome. Count checks
  // still detect missing identity rows. The predicates remain useful
  // transition documentation and defense in depth.
  "src/app/actions/admin-roster.ts::reinstateSignup::status+type#1",
  "src/app/actions/admin-roster.ts::setRegistrationMmr::status+type#1",
  "src/app/actions/admin-captains-draft.ts::randomizeDraftOrder::draftOrder#1",
  "src/app/actions/admin-captains-draft.ts::startDraft::captainId+draftOrder#1",
  "src/app/actions/admin-captains-draft.ts::startDraft::isActive+status#1",
  "src/app/actions/admin-schedule-results.ts::generateSchedule::isActive#1",
  "src/app/actions/admin-schedule-results.ts::reopenMatch::championTeamId+isActive+status#1",
  "src/app/actions/admin-schedule-results.ts::setWeekNight::isActive#1",
  "src/app/actions/admin-schedule-results.ts::setMatchTime::scheduledAt+status#1",
  "src/app/actions/admin-season.ts::setDraftSettings::isActive+status+updatedAt#1",
  "src/app/actions/admin-captains-draft.ts::setDraftNight::isActive+status#1",
  // changeCaptain re-reads the Team, Season and Draft inside its SERIALIZABLE
  // transaction before this write (seam test in change-captain.itest.ts), so a
  // rival Start draft or captain change either fails those fresh checks or
  // forces a serialization failure. The WHERE is defense in depth.
  "src/app/actions/admin-captains-draft.ts::changeCaptain::captainId+season#1",
  // transferCaptaincy's Team captain predicate has the same same-row
  // SERIALIZABLE protection. Its first flag write merely writes false over
  // already-false members (the count is discarded and TeamMember has no
  // updatedAt); its second re-asserts the false state established immediately
  // beforehand. All three predicates remain as repair intent/defense in depth.
  "src/app/actions/admin-captains-draft.ts::transferCaptaincy::captainId#1",
  "src/app/actions/admin-captains-draft.ts::transferCaptaincy::isCaptain#1",
  "src/app/actions/admin-captains-draft.ts::transferCaptaincy::isCaptain#2",
  // removeGame reads Season (including fantasy/champion state) through the
  // fresh Game graph and writes that same Season row in its SERIALIZABLE
  // transaction. Repeat mutation verification proved discovery's apparent
  // kills were incidental: both mutants survive without weakening the actual
  // correction/uncrown invariants. The predicates remain defense in depth.
  "src/app/actions/admin-schedule-results.ts::removeGame::fantasyLockedAt#1",
  "src/app/actions/admin-schedule-results.ts::removeGame::championTeamId+isActive+status#1",
  // These completion/offseason claims all read the same Season row and then
  // write it inside one SERIALIZABLE transaction. A pre-snapshot lifecycle
  // change fails the fresh checks; a post-read change forces P2034 even if the
  // copied fields are removed. Their guards remain explicit state-machine
  // documentation. Separate tests pin cancellation-vs-Resume, cancellation-
  // vs-bracket-build/crown, one-winner reactivation, and completed handoffs.
  "src/app/actions/admin-season.ts::archiveIncompleteSeasonAction::isActive+status+updatedAt#1",
  "src/lib/season.ts::archiveCompletedSeason::championTeamId+isActive+status#1",
  "src/lib/season.ts::reactivateSeason::isActive+updatedAt#1",
  // advancePlayoffBracket's crown likewise performs a fresh Season read plus
  // same-row write in one SERIALIZABLE transaction. The beforeCrown seam test
  // pins the one-crown result independently.
  "src/lib/playoff-service.ts::advancePlayoffBracket::isActive+status#1",
  // Bracket creation and return-to-regular both read then phase-write the same
  // Season row in their SERIALIZABLE teardown/build transaction. A concurrent
  // activation or phase change forces rollback without the copied fields;
  // keeping them documents the authorized transition and adds defense in depth.
  "src/lib/playoff-service.ts::createPlayoffBracket::isActive+status#1",
  "src/lib/playoff-service.ts::returnToRegularSeason::isActive+status#1",
  // Both outbox completion writes retain the lease's exact random claimToken
  // when this modeled mutant removes only `status: SENDING` (shorthand object
  // keys are not mutation targets). The claim transition creates that token
  // and SENDING state atomically; every success, retry, cancellation, and lease
  // recovery transition clears or replaces the token. No application path can
  // therefore match `(id, claimToken)` in another status. Two complete PG
  // mutation probes confirmed both status-only mutants survive, while the
  // separate lobby-state lease guard is killed by its stale-candidate test.
  // Keeping status in production documents the lease state and protects
  // against manual database corruption, but cannot change an application end
  // state while the capability token invariant holds.
  "src/lib/inhouse-announcement-outbox.ts::deliverInhouseAnnouncements::status#1",
  "src/lib/inhouse-announcement-outbox.ts::deliverInhouseAnnouncements::status#2",
  // reconcileOneResult reads the exact InhouseLobby source and performs this
  // claim in one SERIALIZABLE transaction. Any change to the copied result,
  // completion or box-score fields is either visible to the fresh preflight or
  // creates a same-row write conflict and P2034; the retry then re-reads and
  // skips or rebuilds. Removing these copied predicates therefore cannot
  // commit stale Elo or content. The separate RESULT-row claim is NOT
  // equivalent: an already-SENDING row is valid at a fresh snapshot, and its
  // PENDING guard is what keeps the leased payload immutable.
  "src/lib/inhouse-announcement-outbox.ts::reconcileOneResult::boxScore+completedAt+direScore+durationSecs+radiantScore+radiantTeam+status+winnerTeam#1",
  // Every league-outbox transition below retains the exact random claimToken
  // created atomically with SENDING. Success, retry, source cancellation and
  // lease recovery always clear or replace that token; no reachable row in a
  // different status can still match `(id, claimToken)`. These predicates are
  // useful state-machine documentation and corruption defense, but the token
  // alone fences a stale worker in all five transitions.
  "src/lib/league-announcement-outbox.ts::deliverLeagueAnnouncements::status#1",
  "src/lib/league-announcement-outbox.ts::deliverLeagueAnnouncements::status#2",
  "src/lib/league-announcement-outbox.ts::deliverLeagueAnnouncements::status#3",
  "src/lib/league-announcement-outbox.ts::deliverLeagueAnnouncements::status#4",
  "src/lib/league-announcement-outbox.ts::deliverLeagueAnnouncements::status#5",
  // resumeLeagueAnnouncements makes waiting posts due now after an admin saves
  // a webhook. availableAt is read only for PENDING rows (the outbox's
  // eligibility and the automation gate's wake time); a SENDING row is timed
  // by claimedAt and a terminal row is never read again. Stamping availableAt
  // onto those rows with the predicate deleted therefore changes nothing.
  "src/lib/league-announcement-outbox.ts::resumeLeagueAnnouncements::status#1",
  // applyPick's ADVANCE claim re-asserts `status: DRAFTING`. It cannot be
  // falsified: the TURN claim a few statements earlier UPDATEs the same lobby
  // row inside the same interactive transaction, so Postgres holds that row's
  // lock until commit and no rival can move the status before the advance —
  // an admin cancel BLOCKS there and re-evaluates its own guard against the
  // committed result. Deleting the predicate therefore writes the same data to
  // the same row and returns the same value. The lock is not taken on trust:
  // "the DRAFTING re-assert cannot be falsified" in inhouse.itest.ts holds the
  // seam open and shows a second connection refused the row (FOR UPDATE
  // NOWAIT), with a positive control so a malformed query can't fake it. If
  // that test ever goes red this entry has expired — the claim is a real gap
  // again and needs a real test.
  "src/lib/inhouse-service.ts::applyPick::status#1",
]);

// Every production file that holds a guarded updateMany claim. A read-only
// source sweep below rejects omissions, so adding a claim in a new module
// cannot silently leave it outside the ratchet again.
const FILES = [
  "src/app/api/dota-lobby/route.ts",
  "src/lib/dota-account-service.ts",
  "src/lib/draft-service.ts",
  "src/lib/draft-history.ts",
  "src/lib/roster-history.ts",
  "src/lib/game-participants.ts",
  "src/lib/game-identity-correction.ts",
  "src/lib/participant-admin.ts",
  "src/lib/import-candidates.ts",
  "src/lib/inhouse-service.ts",
  "src/lib/match-import.ts",
  "src/lib/reschedule-service.ts",
  "src/lib/scrim-service.ts",
  "src/lib/standin-service.ts",
  "src/lib/playoff-service.ts",
  "src/lib/result-sync-service.ts",
  "src/lib/inhouse-board-service.ts",
  "src/lib/settings.ts",
  "src/lib/season.ts",
  "src/app/actions/admin-season.ts",
  "src/app/actions/admin-captains-draft.ts",
  "src/app/actions/admin-roster.ts",
  "src/app/actions/admin-schedule-results.ts",
  "src/app/actions/import-progress.ts",
  "src/app/actions/news.ts",
  "src/lib/news-rollover.ts",
  "src/app/actions/registration.ts",
  "src/lib/honors-service.ts",
  "src/lib/announcement-marker.ts",
  "src/lib/automation-service.ts",
  "src/lib/inhouse-announcement-outbox.ts",
  "src/lib/league-announcement-outbox.ts",
  "src/lib/side-game-claims.ts",
  "src/lib/team-identity-service.ts",
  "src/lib/users.ts",
  "src/lib/player-data-refresh.ts",
];

/** Every guarded claim in one source file, plus its source text. */
function discoverFile(file) {
  const src = readFileSync(file, "utf8");
  return { src, found: discoverClaims(file, src) };
}

function discoverAll() {
  const claims = [];
  for (const f of FILES) {
    if (!existsSync(f)) continue;
    claims.push(...discoverFile(f).found);
  }
  return claims;
}

/** Production TS/TSX sources whose claim-bearing files must be in FILES. */
function productionSources(dir = "src") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...productionSources(path));
    } else if (
      entry.isFile() &&
      /\.tsx?$/.test(entry.name) &&
      !/\.(?:test|itest)\.tsx?$/.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

/** Fail closed when the manually mutation-owned file set is incomplete. */
function validateSourceInventory() {
  const problems = [];
  for (const file of duplicates(FILES)) {
    problems.push(`FILES contains a duplicate: ${file}`);
  }
  for (const file of FILES.filter((candidate) => !existsSync(candidate))) {
    problems.push(`FILES references a missing source: ${file}`);
  }
  const tracked = new Set(FILES);
  for (const file of productionSources().sort()) {
    if (!tracked.has(file) && discoverFile(file).found.length > 0) {
      problems.push(`claim-bearing source is absent from FILES: ${file}`);
    }
  }
  return problems;
}

function sorted(values) {
  return values.every(
    (value, index) => index === 0 || values[index - 1] <= value,
  );
}

/**
 * Validate the baseline as a closed inventory, not a best-effort scorecard.
 * Every live claim must have exactly one classification; every recorded id
 * must still be live; and "equivalent" must match the reviewed source list.
 * The checks after the shape checks judge the lists with any `renames`
 * applied (see resolveRenames).
 */
function validateBaseline(base, liveClaims) {
  const problems = [];
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    return [`${BASELINE} must contain a JSON object`];
  }
  if (typeof base.note !== "string" || base.note.trim() === "") {
    problems.push("note must be a non-empty string");
  }
  if (!Number.isSafeInteger(base.totalClaims) || base.totalClaims < 0) {
    problems.push("totalClaims must be a non-negative safe integer");
  }
  for (const field of ["protected", "equivalent"]) {
    const values = base[field];
    if (!Array.isArray(values) || values.some((id) => typeof id !== "string")) {
      problems.push(`${field} must be an array of claim-id strings`);
    }
  }
  if (
    !Array.isArray(base.protected) ||
    base.protected.some((id) => typeof id !== "string") ||
    !Array.isArray(base.equivalent) ||
    base.equivalent.some((id) => typeof id !== "string")
  ) {
    return problems;
  }

  const liveIds = liveClaims.map((claim) => claim.id);
  const renamed = resolveRenames(base, liveIds);
  problems.push(...renamed.problems);
  const protectedIds = renamed.protected;
  const equivalentIds = renamed.equivalent;
  for (const id of duplicates(protectedIds)) {
    problems.push(`protected contains a duplicate: ${id}`);
  }
  for (const id of duplicates(equivalentIds)) {
    problems.push(`equivalent contains a duplicate: ${id}`);
  }
  if (!sorted(base.protected)) problems.push("protected IDs are not sorted");
  if (!sorted(base.equivalent)) problems.push("equivalent IDs are not sorted");

  const duplicateLive = duplicates(liveIds);
  for (const id of duplicateLive) {
    problems.push(`live discovery produced a duplicate ID: ${id}`);
  }
  const liveSet = new Set(liveIds);
  const protectedSet = new Set(protectedIds);
  const equivalentSet = new Set(equivalentIds);
  const reviewedEquivalent = [...EQUIVALENT].sort();
  const reviewedSet = new Set(reviewedEquivalent);

  for (const id of protectedIds.filter((candidate) => equivalentSet.has(candidate))) {
    problems.push(`claim is both protected and equivalent: ${id}`);
  }
  for (const id of liveIds) {
    const classifications =
      Number(protectedSet.has(id)) + Number(equivalentSet.has(id));
    if (classifications === 0) problems.push(`live claim is unclassified: ${id}`);
    if (classifications > 1) problems.push(`live claim is multiply classified: ${id}`);
  }
  for (const id of [...protectedIds, ...equivalentIds]) {
    if (!liveSet.has(id)) problems.push(`baseline claim is no longer live: ${id}`);
  }
  for (const id of equivalentIds) {
    if (!reviewedSet.has(id)) problems.push(`equivalent is not reviewed in source: ${id}`);
  }
  for (const id of reviewedEquivalent) {
    if (!equivalentSet.has(id)) problems.push(`reviewed equivalent is absent from baseline: ${id}`);
  }
  if (base.totalClaims !== liveIds.length) {
    problems.push(
      `totalClaims=${base.totalClaims} but discovery found ${liveIds.length}`,
    );
  }
  if (base.totalClaims !== protectedIds.length + equivalentIds.length) {
    problems.push(
      `totalClaims=${base.totalClaims} but the classification arrays contain ` +
        `${protectedIds.length + equivalentIds.length} entries`,
    );
  }
  problems.push(...resolveKillers(base, protectedIds).problems);
  return problems;
}

/** Source with this claim's state predicates deleted — a blind write. */
function mutate(src, claim) {
  let out = src;
  for (const [s, e] of [...claim.drop].sort((a, b) => b[0] - a[0])) {
    let end = e;
    while (end < out.length && /[\s,]/.test(out[end]) && out[end] !== "\n")
      end++;
    out = out.slice(0, s) + out.slice(end);
  }
  return out;
}

const VITEST = "node_modules/vitest/vitest.mjs";
const SUITE_TIMEOUT_MS = 900_000;
const SUITE_MAX_BUFFER = 16 * 1024 * 1024;

function outputTail(result) {
  const output = [result.stdout, result.stderr, result.error?.stack]
    .filter(Boolean)
    .join("\n")
    .trim();
  return output ? output.slice(-4_000) : "(runner produced no output)";
}

function vitestReport(result) {
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Run Vitest without a shell so process failures cannot masquerade as kills.
 * `files` narrows the run to those test files; empty runs the whole suite.
 */
function runSuite({ bail = false, files = [] } = {}) {
  const result = spawnSync(
    process.execPath,
    [
      VITEST,
      "run",
      ...files,
      "--config",
      "vitest.pg.config.mts",
      ...(bail ? ["--bail=1"] : []),
      "--silent",
      "--reporter=json",
    ],
    {
      encoding: "utf8",
      timeout: SUITE_TIMEOUT_MS,
      maxBuffer: SUITE_MAX_BUFFER,
      env: process.env,
    },
  );
  if (result.error || result.signal) {
    return { kind: "infrastructure", result, report: null };
  }
  const report = vitestReport(result);
  if (
    result.status === 0 &&
    report?.success === true &&
    report.numFailedTests === 0 &&
    report.numTotalTests > 0
  ) {
    return { kind: "pass", result, report };
  }
  // Vitest also exits 1 for transform/import/configuration failures. Only an
  // actual failed test is behavioral evidence that the suite killed a mutant.
  if (result.status === 1 && report && report.numFailedTests > 0) {
    return { kind: "test-failure", result, report };
  }
  return { kind: "infrastructure", result, report };
}

function stopForInfrastructure(context, run) {
  console.error(
    `\nMutation guard infrastructure failure while ${context}. ` +
      "This is not evidence that a test caught the mutant.",
  );
  console.error(outputTail(run.result));
  process.exit(2);
}

function mutationSyntaxErrors(file, source) {
  const diagnostics =
    ts.transpileModule(source, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).diagnostics ?? [];
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length === 0) return null;
  return ts.formatDiagnostics(errors, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  });
}

function stopForInvalidMutant(claim, diagnostics) {
  console.error(
    `\nMutation guard generated invalid TypeScript for ${claim.id}. ` +
      "A parse failure is infrastructure, not evidence that a test protects the guard.",
  );
  console.error(diagnostics);
  process.exit(2);
}

/**
 * Whether the suite NOTICED the mutation (i.e. the guard is protected), and
 * which test file killed it. `killer` (verify mode only) is the claim's
 * recorded killer, run first; see measureMutant.
 */
function suiteCatches(claim, killer = null) {
  const original = readFileSync(claim.file, "utf8");
  const { found } = discoverFile(claim.file);
  const live = found.find((c) => c.id === claim.id);
  const outcome = {
    caught: false,
    missing: false,
    infrastructure: null,
    invalidMutation: null,
    killer: null,
    via: null,
    fallback: null,
  };
  if (!live) return { ...outcome, missing: true };
  const mutant = mutate(original, live);
  const invalidMutation = mutationSyntaxErrors(claim.file, mutant);
  if (invalidMutation) return { ...outcome, invalidMutation };
  writeFileSync(claim.file, mutant);
  try {
    const measured = measureMutant(killer, {
      run: (files) => runSuite({ bail: true, files }),
      exists: existsSync,
    });
    const { run, via, fallback } = measured;
    if (run.kind === "infrastructure") {
      return { ...outcome, infrastructure: run, via, fallback };
    }
    const caught = run.kind === "test-failure";
    return {
      ...outcome,
      caught,
      killer: caught ? killerFromReport(run.report, process.cwd()) : null,
      via,
      fallback,
    };
  } finally {
    writeFileSync(claim.file, original);
  }
}

// Why verify had to run the whole suite after a recorded killer.
const FALLBACK_NOTES = {
  missing: "is no longer on disk",
  survived: "no longer fails with this guard deleted",
  infrastructure: "did not finish cleanly on its own",
};

// ---------------------------------------------------------------------------
const discover = process.argv.includes("--discover");
// `--only <substring>` narrows to matching claim ids — a full sweep is one
// suite run per claim, which is far too slow a loop while writing the tests
// that close them.
const onlyArg = process.argv.indexOf("--only");
let only = null;
if (onlyArg !== -1) {
  only = process.argv[onlyArg + 1];
  if (!only || only.startsWith("--")) {
    console.error("--only requires a non-empty claim-id substring");
    process.exit(2);
  }
  if (!discover) {
    console.error(
      "--only is a discovery probe; use --discover --only <substring>",
    );
    process.exit(2);
  }
}

// `--shard i/n` verifies a deterministic slice of the baseline. Every mutant
// costs a full suite run, so the job grows linearly with the protected-claim
// count. Shards run as a matrix and the slices are disjoint, so coverage per
// push is unchanged; only the wall clock moves.
const shardArg = process.argv.indexOf("--shard");
let shard = null;
if (shardArg !== -1) {
  const m = /^(\d+)\/(\d+)$/.exec(process.argv[shardArg + 1] ?? "");
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
    console.error("--shard expects i/n with 1 <= i <= n (e.g. --shard 2/4)");
    process.exit(2);
  }
  shard = { i: Number(m[1]), n: Number(m[2]) };
}
if (discover && shard) {
  console.error("--shard is a verify-mode option and cannot be combined with --discover");
  process.exit(2);
}
// `--static` stops after the source-inventory and baseline checks, which need
// no database. CI's always-required test job runs it, because the mutation
// shards skip themselves when the release classifier reports
// needs_mutation=false, and a claim added to a page would otherwise go
// unnoticed until the nightly verify.
const staticOnly = process.argv.includes("--static");
if (staticOnly && (discover || shard)) {
  console.error("--static checks the committed baseline and takes no other mode");
  process.exit(2);
}

const inventoryProblems = validateSourceInventory();
const allClaims = discoverAll();
for (const id of duplicates(allClaims.map((claim) => claim.id))) {
  inventoryProblems.push(`live discovery produced a duplicate ID: ${id}`);
}
const allLiveIds = new Set(allClaims.map((claim) => claim.id));
for (const id of [...EQUIVALENT].sort()) {
  if (!allLiveIds.has(id)) {
    inventoryProblems.push(`reviewed equivalent is no longer a live claim: ${id}`);
  }
}
if (inventoryProblems.length > 0) {
  console.error("Mutation source inventory is invalid:");
  for (const problem of inventoryProblems) console.error(`  - ${problem}`);
  process.exit(2);
}

const claims = allClaims.filter((c) => !only || c.id.includes(only));
if (only && claims.length === 0) {
  console.error(`--only matched no guarded claims: ${only}`);
  process.exit(2);
}

let base = null;
if (!discover) {
  if (!existsSync(BASELINE)) {
    console.error(`No ${BASELINE}. Run with --discover first.`);
    process.exit(2);
  }
  try {
    base = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch (error) {
    console.error(
      `${BASELINE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
  const baselineProblems = validateBaseline(base, allClaims);
  if (baselineProblems.length > 0) {
    console.error(`${BASELINE} is not an exact guarded-claim inventory:`);
    for (const problem of baselineProblems) console.error(`  - ${problem}`);
    console.error(
      "Review every new or changed classification, then run a full --discover.\n" +
        "A guard that only MOVED (its function was renamed or moved to another\n" +
        'file) can carry its classification with a "renames" entry instead:\n' +
        '  "renames": { "<old id>": "<new id>" }',
    );
    process.exit(2);
  }
  // From here on the protected/equivalent lists name live ids only: every
  // rename is applied, so verify re-mutates each moved guard at its new home.
  const effective = resolveRenames(base, [...allLiveIds]);
  base = {
    ...base,
    protected: effective.protected,
    equivalent: effective.equivalent,
    killers: resolveKillers(base, effective.protected).killers,
  };
}

if (staticOnly) {
  console.log(
    `✔ ${allClaims.length} live claims in ${FILES.length} files match ${BASELINE}: ` +
      `${base.protected.length} protected (${base.killers.size} with a recorded killer), ` +
      `${base.equivalent.length} reviewed equivalent.`,
  );
  process.exit(0);
}

try {
  assertPostgresTestUrl(process.env.PG_TEST_URL);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unsafe PG_TEST_URL");
  process.exit(2);
}

// A mutant is "caught" when the suite FAILS — which is also what happens if
// the suite is broken for any other reason. Prove the unmutated baseline is
// green first, and distinguish ordinary test failures from runner failures.
const preflight = runSuite();
if (preflight.kind === "infrastructure") {
  stopForInfrastructure("checking unmutated source", preflight);
}
if (preflight.kind === "test-failure") {
  console.error(
    "The tests fail on UNMUTATED source, so every mutant would look\n" +
      "caught and the result would be meaningless. Fix the suite first:\n" +
      "  npm run test:pg",
  );
  const failed = failedTestsFromReport(preflight.report, process.cwd());
  if (failed.length > 0) {
    console.error("\nFailed on unmutated source:");
    for (const line of failed) console.error(`  - ${line}`);
  }
  process.exit(2);
}

if (discover) {
  console.log(
    `Sweeping ${claims.length} guarded claims (one suite run each)…\n`,
  );
  const protectedIds = [];
  const killerById = new Map();
  let previousProtected = new Set();
  if (existsSync(BASELINE)) {
    try {
      const previous = JSON.parse(readFileSync(BASELINE, "utf8"));
      if (Array.isArray(previous.protected)) {
        previousProtected = new Set(previous.protected);
        // A guard that only moved keeps its protected status: its renamed id
        // is not "newly caught" and needs no second confirming run. Invalid
        // renames are ignored rather than trusted.
        const renamed = Array.isArray(previous.equivalent)
          ? resolveRenames(previous, [...allLiveIds])
          : null;
        if (renamed && renamed.problems.length === 0) {
          previousProtected = new Set(renamed.protected);
        }
      }
    } catch {
      // Discovery is the repair path for a stale or malformed baseline. With
      // no trustworthy prior ratchet, confirm every apparent kill below.
    }
  }
  for (const [i, c] of claims.entries()) {
    if (EQUIVALENT.has(c.id)) {
      console.log(`  [equivalent ] (${i + 1}/${claims.length}) ${c.id}`);
      continue;
    }
    const first = suiteCatches(c);
    if (first.invalidMutation) {
      stopForInvalidMutant(c, first.invalidMutation);
    }
    if (first.infrastructure) {
      stopForInfrastructure(`testing ${c.id}`, first.infrastructure);
    }
    let caught = first.caught;
    let rechecked = false;
    if (caught && !previousProtected.has(c.id)) {
      rechecked = true;
      const second = suiteCatches(c);
      if (second.invalidMutation) {
        stopForInvalidMutant(c, second.invalidMutation);
      }
      if (second.infrastructure) {
        stopForInfrastructure(
          `confirming new protection for ${c.id}`,
          second.infrastructure,
        );
      }
      if (!second.caught) caught = false;
    }
    console.log(
      `  [${caught ? "PROTECTED  " : "unprotected"}] (${i + 1}/${claims.length}) ${c.id}  (${c.file}:${c.line})${caught && rechecked ? " (confirmed twice)" : ""}` +
        (caught && first.killer ? `  killed by ${first.killer}` : ""),
    );
    if (rechecked && !caught) {
      console.log(
        "    [FLAKY KILL] first run failed but the mutant survived confirmation; not promoted",
      );
    }
    if (caught) {
      protectedIds.push(c.id);
      if (first.killer) killerById.set(c.id, first.killer);
    }
  }
  const equivalentCount = claims.filter((c) => EQUIVALENT.has(c.id)).length;
  const unprotectedCount =
    claims.length - equivalentCount - protectedIds.length;
  if (only) {
    // A filtered sweep has only seen part of the repo, so writing the baseline
    // from it would silently DROP every claim it didn't look at — turning the
    // ratchet off for them. `--only` is a probe; the baseline comes from a
    // full run.
    console.log(
      `\n${protectedIds.length} protected; ${equivalentCount} equivalent; ` +
        `${unprotectedCount} unprotected; ${claims.length} total in this slice — ` +
        `baseline NOT written (--only is a probe; run a full --discover to update it).`,
    );
    process.exit(0);
  }
  if (unprotectedCount > 0) {
    console.error(
      `\n${unprotectedCount} live claim${unprotectedCount === 1 ? " is" : "s are"} neither protected nor reviewed equivalent.`,
    );
    console.error(
      `${BASELINE} was NOT replaced. Add a real test for each behavioral guard, ` +
        "or document a genuinely equivalent mutant in EQUIVALENT, then run the full sweep again.",
    );
    process.exit(1);
  }
  protectedIds.sort();
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note:
          "Guarded claims that a test actually protects. Generated by " +
          "`node scripts/mutation-guard.mjs --discover` (needs PG_TEST_URL). " +
          "CI requires every live claim to be exactly classified, re-mutates " +
          "every protected claim, and fails if one regresses or disappears. " +
          "`killers` names the test file that failed first for each protected " +
          "claim; verify runs it before the whole suite. " +
          "Raise the ratchet by writing a race test and re-running.",
        totalClaims: claims.length,
        equivalent: [...EQUIVALENT].sort(),
        protected: protectedIds,
        killers: Object.fromEntries(
          protectedIds
            .filter((id) => killerById.has(id))
            .map((id) => [id, killerById.get(id)]),
        ),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `\n${protectedIds.length} protected; ${equivalentCount} equivalent; ` +
      `${unprotectedCount} unprotected; ${claims.length} total — ` +
      `baseline written to ${BASELINE}`,
  );
  process.exit(0);
}

const byId = new Map(claims.map((c) => [c.id, c]));
const failures = [];

// Round-robin over the SORTED baseline, so a claim's shard is stable between
// runs and every shard gets a similar mix of fast and slow suites.
const mine = base.protected.filter(
  (_, k) => !shard || (k % shard.n) + 1 === shard.i,
);
console.log(
  shard
    ? `Verifying shard ${shard.i}/${shard.n}: ${mine.length} of ${base.protected.length} protected claims…\n`
    : `Verifying ${mine.length} protected claims (of ${claims.length} found; baseline saw ${base.totalClaims})…\n`,
);
let decidedByKiller = 0;
const killerAlone = new Map();
for (const id of mine) {
  const claim = byId.get(id);
  if (!claim) {
    console.log(`  [GONE       ] ${id}`);
    failures.push(
      `${id} — the guard no longer exists (removed, or its WHERE was weakened)`,
    );
    continue;
  }
  const recorded = base.killers.get(id) ?? null;
  // Runs before the mutant is written: the proof is on unmutated source.
  const { killer, untrusted } = trustedKiller(recorded, {
    run: (files) => runSuite({ bail: true, files }),
    exists: existsSync,
    cache: killerAlone,
  });
  const measured = suiteCatches(claim, killer);
  const fallbackNote = untrusted
    ? `    [killer untrusted] ${recorded} ${untrusted === "test-failure" ? "fails" : "does not finish cleanly"} ` +
      "on its own against unmutated source, so the whole suite decided"
    : measured.fallback
      ? `    [killer ${measured.fallback}] ${killer} ${FALLBACK_NOTES[measured.fallback]}, ` +
        "so the whole suite decided (a full --discover refreshes killers)"
      : null;
  if (measured.invalidMutation) {
    stopForInvalidMutant(claim, measured.invalidMutation);
  }
  if (measured.infrastructure) {
    if (fallbackNote) console.log(fallbackNote);
    stopForInfrastructure(`verifying ${id}`, measured.infrastructure);
  }
  const { caught } = measured;
  if (measured.via === "killer") decidedByKiller++;
  console.log(
    `  [${caught ? "ok         " : "REGRESSED  "}] ${id}  (${claim.file}:${claim.line})` +
      (caught && measured.killer ? `  killed by ${measured.killer}` : ""),
  );
  if (fallbackNote) console.log(fallbackNote);
  if (!caught) {
    failures.push(
      `${id} (${claim.file}:${claim.line}) — deleting its guard no longer fails any test`,
    );
  }
}

const protectedSet = new Set(base.protected);
const equivalentCount = claims.filter((c) => EQUIVALENT.has(c.id)).length;
const protectedCount = claims.filter(
  (c) => !EQUIVALENT.has(c.id) && protectedSet.has(c.id),
).length;
const unprotectedCount = claims.length - equivalentCount - protectedCount;
console.log(
  `\n${protectedCount} protected; ${equivalentCount} equivalent; ` +
    `${unprotectedCount} unprotected; ${claims.length} total` +
    (shard
      ? ` — this shard verified ${mine.length}/${base.protected.length} protected claims.`
      : ".") +
    ` ${decidedByKiller} of ${mine.length} were decided by their recorded killer alone.`,
);

if (failures.length) {
  console.error(`\n✖ mutation guard FAILED (${failures.length}):`);
  for (const f of failures) console.error(`   • ${f}`);
  console.error(
    "\nA guard this repo relies on is no longer covered. Either restore the test\n" +
      "that protected it, or — if the guard was deliberately removed — re-run\n" +
      "`node scripts/mutation-guard.mjs --discover` and commit the new baseline.",
  );
  process.exit(1);
}
console.log(
  shard
    ? `\n✔ shard ${shard.i}/${shard.n}: every claim in this slice is still protected.`
    : "\n✔ every protected claim is still protected.",
);
