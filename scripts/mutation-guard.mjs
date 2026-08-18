// Mutation guard — a RATCHET over the repo's guarded claims.
//
// A "guarded claim" is an `updateMany({ where: … })` whose WHERE carries a
// STATE predicate (a status, a null-check, a timestamp) on top of the identity
// keys. That predicate IS the concurrency guard: strip it and the claim becomes
// a blind write, which is this codebase's dominant bug class (see CLAUDE.md's
// "Concurrency: the two rules").
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
//
// Verify mode first requires EVERY live claim to appear exactly once in the
// baseline as either PROTECTED or a reviewed EQUIVALENT. It then re-mutates
// only the protected claims, so it costs ~1 suite run each rather than one per
// claim in the repo. It fails when:
//   * a protected claim is no longer caught  → a test that protected it regressed
//   * a protected claim has DISAPPEARED      → the guard itself was removed
//   * a live claim is absent from the baseline → discovery was not reviewed
//   * the baseline is malformed, duplicated, stale, or only partly classified
// Raise the ratchet by writing a test and re-running --discover.
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
  "src/app/actions/admin.ts::createSeason::isActive#1",
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
  "src/app/actions/admin.ts::startDraft::status#1",
  // voidCurrentLot reads and writes the singleton Draft row in one
  // SERIALIZABLE transaction. A rival lot mutation therefore forces P2034
  // even without the copied lot/version fields; the WHERE remains as explicit
  // state-machine documentation and defense in depth.
  "src/lib/draft-service.ts::voidCurrentLot::currentBid+currentBidTeamId+nominatedUserId+status+updatedAt#1",
  // undoLastSale reads Draft.status and nominatedUserId, performs its refund,
  // and reopens that same Draft row inside one SERIALIZABLE transaction. A
  // poller opening a lot in the gap changes the row and forces Undo to abort
  // with P2034, rolling the refund and roster deletion back, even if both
  // copied predicates are removed. The Postgres race test asserts the
  // no-live-lot-plus-nomination-clock invariant and all-or-nothing refund.
  "src/lib/draft-service.ts::undoLastSale::nominatedUserId+status#1",
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
  "src/app/actions/admin.ts::recordResult::awayScore+forfeit+homeScore+status+winnerTeamId#1",
  "src/app/actions/admin.ts::reopenMatch::games+season+status#1",
  "src/app/actions/admin.ts::setSeasonPhase::isActive+status#1",
  "src/app/actions/admin.ts::setWeekNight::scheduledAt+status#1",
  // These actions likewise read the authoritative Season, Match, Registration
  // or Team rows and write those same rows inside SERIALIZABLE transactions.
  // Pre-snapshot changes fail the fresh checks; post-read changes force P2034,
  // so copied state fields cannot change a committed outcome. Count checks
  // still detect missing identity rows. The predicates remain useful
  // transition documentation and defense in depth.
  "src/app/actions/admin.ts::reinstateSignup::status+type#1",
  "src/app/actions/admin.ts::setRegistrationMmr::status+type#1",
  "src/app/actions/admin.ts::randomizeDraftOrder::draftOrder#1",
  "src/app/actions/admin.ts::startDraft::captainId+draftOrder#1",
  "src/app/actions/admin.ts::startDraft::isActive+status#1",
  "src/app/actions/admin.ts::generateSchedule::isActive#1",
  "src/app/actions/admin.ts::reopenMatch::championTeamId+isActive+status#1",
  "src/app/actions/admin.ts::setWeekNight::isActive#1",
  "src/app/actions/admin.ts::setMatchTime::scheduledAt+status#1",
  "src/app/actions/admin.ts::setDraftSettings::isActive+status+updatedAt#1",
  "src/app/actions/admin.ts::setDraftNight::isActive+status#1",
  // transferCaptaincy's Team captain predicate has the same same-row
  // SERIALIZABLE protection. Its first flag write merely writes false over
  // already-false members (the count is discarded and TeamMember has no
  // updatedAt); its second re-asserts the false state established immediately
  // beforehand. All three predicates remain as repair intent/defense in depth.
  "src/app/actions/admin.ts::transferCaptaincy::captainId#1",
  "src/app/actions/admin.ts::transferCaptaincy::isCaptain#1",
  "src/app/actions/admin.ts::transferCaptaincy::isCaptain#2",
  // removeGame reads Season (including fantasy/champion state) through the
  // fresh Game graph and writes that same Season row in its SERIALIZABLE
  // transaction. Repeat mutation verification proved discovery's apparent
  // kills were incidental: both mutants survive without weakening the actual
  // correction/uncrown invariants. The predicates remain defense in depth.
  "src/app/actions/admin.ts::removeGame::fantasyLockedAt#1",
  "src/app/actions/admin.ts::removeGame::championTeamId+isActive+status#1",
  // These completion/offseason claims all read the same Season row and then
  // write it inside one SERIALIZABLE transaction. A pre-snapshot lifecycle
  // change fails the fresh checks; a post-read change forces P2034 even if the
  // copied fields are removed. Their guards remain explicit state-machine
  // documentation. Separate tests pin cancellation-vs-Resume, cancellation-
  // vs-bracket-build/crown, one-winner reactivation, and completed handoffs.
  "src/app/actions/admin.ts::archiveIncompleteSeasonAction::isActive+status+updatedAt#1",
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
  // completion, box-score or settlement fields is either visible to the fresh
  // preflight or creates a same-row write conflict and P2034; the retry then
  // re-reads and skips or rebuilds. Removing these copied predicates therefore
  // cannot commit stale Elo or content. The separate RESULT-row claim is NOT
  // equivalent: an already-SENDING row is valid at a fresh snapshot, and its
  // PENDING guard is what keeps the leased payload immutable.
  "src/lib/inhouse-announcement-outbox.ts::reconcileOneResult::betSettlement+boxScore+completedAt+direScore+durationSecs+radiantScore+radiantTeam+status+winnerTeam#1",
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
  // placeInhouseBet's WRITE 4 arms the sweeper with
  // `where: { id, betSettlement: null }`. Deleting `betSettlement: null`
  // cannot be observed, because WRITE 4 is UNREACHABLE unless WRITE 3 — the
  // confirm claim, three statements earlier — matched, and WRITE 3 requires
  // `status: { in: [READY, IN_PROGRESS] }`. That excludes every value the
  // column could hold besides null and PENDING: SETTLED is only written for a
  // COMPLETED lobby, REFUNDED/REVERSED only for a CANCELLED one, and both
  // statuses make WRITE 3 match zero rows and THROW. So the blind write is
  // either PENDING over null (identical) or PENDING over PENDING (a no-op).
  //
  // The one interleaving worth ruling out explicitly, since Postgres
  // re-snapshots per statement even inside one transaction and WRITE 3 locks
  // the BET row, not the lobby: an admin cancel committing between WRITE 3 and
  // WRITE 4, followed by the sweeper stamping REFUNDED. It cannot happen —
  // the sweeper only touches lobbies already at PENDING, which is the very
  // thing WRITE 4 sets, and if an EARLIER bettor had armed it then this
  // bettor's WRITE 3 would have failed on the CANCELLED status first.
  //
  // Unlike applyPick::status#1 this rests on static control flow rather than a
  // lock, so it needs no pinning test — but if WRITE 3's status filter is ever
  // widened, this entry has expired and the claim is a real gap again.
  "src/lib/inhouse-bet-service.ts::placeInhouseBet::betSettlement#1",
]);

// Every production file that holds a guarded updateMany claim. A read-only
// source sweep below rejects omissions, so adding a claim in a new module
// cannot silently leave it outside the ratchet again.
const FILES = [
  "src/lib/dota-account-service.ts",
  "src/lib/draft-service.ts",
  "src/lib/inhouse-service.ts",
  "src/lib/match-import.ts",
  "src/lib/reschedule-service.ts",
  "src/lib/scrim-service.ts",
  "src/lib/standin-service.ts",
  "src/lib/playoff-service.ts",
  "src/lib/result-sync-service.ts",
  "src/lib/inhouse-board-service.ts",
  "src/lib/inhouse-bet-service.ts",
  "src/lib/settings.ts",
  "src/lib/season.ts",
  "src/app/actions/admin.ts",
  "src/app/actions/news.ts",
  "src/app/actions/registration.ts",
  "src/lib/honors-service.ts",
  "src/lib/announcement-marker.ts",
  "src/lib/automation-service.ts",
  "src/lib/inhouse-announcement-outbox.ts",
  "src/lib/league-announcement-outbox.ts",
  "src/lib/side-game-claims.ts",
  "src/lib/users.ts",
];

// Keys that merely IDENTIFY the row. Everything else in a WHERE is state, and
// state is what makes the write a claim.
const IDENTITY = new Set([
  "id",
  "seasonId",
  "lobbyId",
  "userId",
  "matchId",
  "teamId",
  "key",
  "draftId",
  "gameId",
  "dotaMatchId",
  "registrationId",
  "steamId",
  "discordId",
]);

/**
 * Skip a `//` or block comment starting at `i`, returning the index to resume
 * scanning from (or `i` when there is no comment there).
 *
 * BOTH scanners below need this and neither had it, which cost a red CI and a
 * long diagnosis. They treat `'` as a string delimiter, so an ordinary prose
 * comment inside a claim's object literal — "the lobby's", "don't", "the
 * bettor's" — put an ODD number of apostrophes in their path, opened a phantom
 * string, and desynced brace matching. The claim did not read as weakened: it
 * vanished from discovery entirely, tripping the "a protected claim has
 * DISAPPEARED" alarm against a baseline that still listed it.
 *
 * That failure mode is worse than it sounds, because it is SILENT in the other
 * direction too. A `--discover` run after such an edit simply records the
 * smaller claim set and reports all-clear, so the guard a comment happened to
 * hide is dropped from the ratchet with nothing to say so. Comments in this
 * repo are deliberately long and prose-heavy, so this was going to recur.
 */
function skipComment(src, i) {
  if (src[i] !== "/") return i;
  if (src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl === -1 ? src.length : nl;
  }
  if (src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end === -1 ? src.length : end + 1;
  }
  return i;
}

/** The balanced {...} beginning at `open`. */
function block(src, open) {
  let d = 0,
    inStr = null,
    esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    const j = skipComment(src, i);
    if (j !== i) {
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") d++;
    else if (c === "}") {
      d--;
      if (d === 0) return [open, i + 1];
    }
  }
  return null;
}

/** Top-level `key: value` spans inside an object literal. */
function topKeys(src, s, e) {
  const out = [];
  let d = 0,
    inStr = null,
    esc = false;
  for (let i = s + 1; i < e - 1; i++) {
    const c = src[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    // Same reason as in `block` — and this scanner ALSO mis-read key names out
    // of comment prose, which is how `refundLobbyBets`' signature acquired a
    // phantom `write` key that no WHERE ever contained.
    const j = skipComment(src, i);
    if (j !== i) {
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") d++;
    else if (c === "}" || c === "]" || c === ")") d--;
    else if (d === 0) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i, i + 40));
      if (m && (i === s + 1 || /[\s,{]/.test(src[i - 1]))) {
        let j = i + m[0].length,
          dd = 0,
          st = null,
          es = false;
        for (; j < e - 1; j++) {
          const cc = src[j];
          if (es) {
            es = false;
            continue;
          }
          if (st) {
            if (cc === "\\") es = true;
            else if (cc === st) st = null;
            continue;
          }
          // Third scanner, same fix — and the most dangerous of the three to
          // leave broken: this one decides where a predicate's value ENDS, i.e.
          // the `drop` span `mutate()` physically deletes. A desync here cuts
          // the wrong source text, so the "mutant" tested is not the mutant the
          // report names.
          const jj = skipComment(src, j);
          if (jj !== j) {
            j = jj;
            continue;
          }
          if (cc === '"' || cc === "'" || cc === "`") {
            st = cc;
            continue;
          }
          if (cc === "{" || cc === "[" || cc === "(") dd++;
          else if (cc === "}" || cc === "]" || cc === ")") {
            if (dd === 0) break;
            dd--;
          } else if (cc === "," && dd === 0) break;
        }
        out.push({ key: m[1], start: i, end: j });
        i = j;
      }
    }
  }
  return out;
}

/**
 * The function a claim sits in. Anchoring IDs to this is load-bearing: a
 * file-wide ordinal SHIFTS when a claim is removed, so deleting a guard made
 * its id silently re-bind to a different claim further down and the ratchet
 * reported all-clear. (Caught by sabotage-testing the ratchet itself.)
 */
function enclosingFn(src, offset) {
  const decl =
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  let name = "<top>";
  for (let m; (m = decl.exec(src));) {
    if (m.index > offset) break;
    name = m[1] ?? m[2] ?? name;
  }
  return name;
}

/**
 * Claims are identified by file + enclosing function + their state-key
 * SIGNATURE + an ordinal within that function — never by line number, which
 * every unrelated edit above them would churn.
 */
function discoverFile(file) {
  const src = readFileSync(file, "utf8");
  const found = [];
  const seen = new Map();
  let from = 0;
  for (;;) {
    const at = src.indexOf("updateMany(", from);
    if (at === -1) break;
    from = at + 11;
    const argOpen = src.indexOf("{", at);
    if (argOpen === -1) continue;
    const arg = block(src, argOpen);
    if (!arg) continue;
    const where = topKeys(src, arg[0], arg[1]).find((p) => p.key === "where");
    if (!where) continue;
    const wOpen = src.indexOf("{", where.start + 6);
    if (wOpen === -1 || wOpen > where.end) continue;
    const wb = block(src, wOpen);
    if (!wb) continue;
    const state = topKeys(src, wb[0], wb[1]).filter(
      (k) => !IDENTITY.has(k.key),
    );
    if (state.length === 0) continue;
    const sig = state
      .map((s) => s.key)
      .sort()
      .join("+");
    const fn = enclosingFn(src, at);
    const scope = `${fn}::${sig}`;
    const ord = (seen.get(scope) ?? 0) + 1;
    seen.set(scope, ord);
    found.push({
      id: `${file}::${fn}::${sig}#${ord}`,
      file,
      line: src.slice(0, at).split("\n").length,
      drop: state.map((s) => [s.start, s.end]),
    });
    from = arg[1];
  }
  return { src, found };
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

  const protectedIds = base.protected;
  const equivalentIds = base.equivalent;
  for (const id of duplicates(protectedIds)) {
    problems.push(`protected contains a duplicate: ${id}`);
  }
  for (const id of duplicates(equivalentIds)) {
    problems.push(`equivalent contains a duplicate: ${id}`);
  }
  if (!sorted(protectedIds)) problems.push("protected IDs are not sorted");
  if (!sorted(equivalentIds)) problems.push("equivalent IDs are not sorted");

  const liveIds = liveClaims.map((claim) => claim.id);
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

/** Run Vitest without a shell so process failures cannot masquerade as kills. */
function runSuite({ bail = false } = {}) {
  const result = spawnSync(
    process.execPath,
    [
      VITEST,
      "run",
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
    return { kind: "infrastructure", result };
  }
  const report = vitestReport(result);
  if (
    result.status === 0 &&
    report?.success === true &&
    report.numFailedTests === 0 &&
    report.numTotalTests > 0
  ) {
    return { kind: "pass", result };
  }
  // Vitest also exits 1 for transform/import/configuration failures. Only an
  // actual failed test is behavioral evidence that the suite killed a mutant.
  if (result.status === 1 && report && report.numFailedTests > 0) {
    return { kind: "test-failure", result };
  }
  return { kind: "infrastructure", result };
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

/** Whether the suite NOTICED the mutation (i.e. the guard is protected). */
function suiteCatches(claim) {
  const original = readFileSync(claim.file, "utf8");
  const { found } = discoverFile(claim.file);
  const live = found.find((c) => c.id === claim.id);
  if (!live) {
    return {
      caught: false,
      missing: true,
      infrastructure: null,
      invalidMutation: null,
    };
  }
  const mutant = mutate(original, live);
  const invalidMutation = mutationSyntaxErrors(claim.file, mutant);
  if (invalidMutation) {
    return {
      caught: false,
      missing: false,
      infrastructure: null,
      invalidMutation,
    };
  }
  writeFileSync(claim.file, mutant);
  try {
    const run = runSuite({ bail: true });
    if (run.kind === "infrastructure") {
      return {
        caught: false,
        missing: false,
        infrastructure: run,
        invalidMutation: null,
      };
    }
    return {
      caught: run.kind === "test-failure",
      missing: false,
      infrastructure: null,
      invalidMutation: null,
    };
  } finally {
    writeFileSync(claim.file, original);
  }
}

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
      "Review every new or changed classification, then run a full --discover.",
    );
    process.exit(2);
  }
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
  process.exit(2);
}

if (discover) {
  console.log(
    `Sweeping ${claims.length} guarded claims (one suite run each)…\n`,
  );
  const protectedIds = [];
  let previousProtected = new Set();
  if (existsSync(BASELINE)) {
    try {
      const previous = JSON.parse(readFileSync(BASELINE, "utf8"));
      if (Array.isArray(previous.protected)) {
        previousProtected = new Set(previous.protected);
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
      `  [${caught ? "PROTECTED  " : "unprotected"}] (${i + 1}/${claims.length}) ${c.id}  (${c.file}:${c.line})${caught && rechecked ? " (confirmed twice)" : ""}`,
    );
    if (rechecked && !caught) {
      console.log(
        "    [FLAKY KILL] first run failed but the mutant survived confirmation; not promoted",
      );
    }
    if (caught) protectedIds.push(c.id);
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
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note:
          "Guarded claims that a test actually protects. Generated by " +
          "`node scripts/mutation-guard.mjs --discover` (needs PG_TEST_URL). " +
          "CI requires every live claim to be exactly classified, re-mutates " +
          "every protected claim, and fails if one regresses or disappears. " +
          "Raise the ratchet by writing a race test and re-running.",
        totalClaims: claims.length,
        equivalent: [...EQUIVALENT].sort(),
        protected: protectedIds.sort(),
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
for (const id of mine) {
  const claim = byId.get(id);
  if (!claim) {
    console.log(`  [GONE       ] ${id}`);
    failures.push(
      `${id} — the guard no longer exists (removed, or its WHERE was weakened)`,
    );
    continue;
  }
  const measured = suiteCatches(claim);
  if (measured.invalidMutation) {
    stopForInvalidMutant(claim, measured.invalidMutation);
  }
  if (measured.infrastructure) {
    stopForInfrastructure(`verifying ${id}`, measured.infrastructure);
  }
  const { caught } = measured;
  console.log(
    `  [${caught ? "ok         " : "REGRESSED  "}] ${id}  (${claim.file}:${claim.line})`,
  );
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
      : "."),
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
