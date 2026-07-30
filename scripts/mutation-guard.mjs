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
//   node scripts/mutation-guard.mjs              # verify the baseline (what CI runs)
//
// Verify mode re-mutates only the claims the baseline says are PROTECTED, so it
// costs ~1 suite run each rather than one per claim in the repo. It fails when:
//   * a protected claim is no longer caught  → a test that protected it regressed
//   * a protected claim has DISAPPEARED      → the guard itself was removed
// New claims are reported but never fail the build; raise the ratchet by
// writing a test and re-running --discover.
//
// MUST run against Postgres (PG_TEST_URL). Several of these claims are only
// caught by RACED tests, and on SQLite those race calls serialize — the mutant
// survives and the ratchet would silently measure nothing.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const BASELINE = "test/mutation-baseline.json";

/**
 * EQUIVALENT MUTANTS — claims whose predicate can be deleted without changing
 * the end state, so no test can ever kill them. Listing them keeps the score
 * honest: they are not gaps waiting for a test, they are guards that happen to
 * be redundant.
 *
 * Every entry needs a REASON that someone can re-check, because "equivalent"
 * is also what an untested gap looks like from here. The first two are
 * archive-then-set pairs — `updateMany({ isActive: true } → false)` followed by
 * activating one row. Dropping the predicate archives rows that are already
 * archived, which lands in exactly the same place.
 */
const EQUIVALENT = new Set([
  "src/lib/season.ts::reactivateSeason::isActive#1",
  "src/app/actions/admin.ts::createSeason::isActive#1",
  // `{ autoSyncAttempts: { gt: 0 } }` guarding `data: { autoSyncAttempts: 0 }`
  // — dropping it writes 0 over a 0. Same end state, nothing observable.
  "src/lib/match-import.ts::importGameForMatch::autoSyncAttempts#1",
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

// Every file that holds transactional service logic. Add new ones here.
const FILES = [
  "src/lib/draft-service.ts",
  "src/lib/inhouse-service.ts",
  "src/lib/match-import.ts",
  "src/lib/reschedule-service.ts",
  "src/lib/standin-service.ts",
  "src/lib/playoff-service.ts",
  "src/lib/result-sync-service.ts",
  "src/lib/inhouse-board-service.ts",
  "src/lib/inhouse-bet-service.ts",
  "src/lib/settings.ts",
  "src/lib/season.ts",
  "src/app/actions/admin.ts",
  "src/app/actions/registration.ts",
];

// Keys that merely IDENTIFY the row. Everything else in a WHERE is state, and
// state is what makes the write a claim.
const IDENTITY = new Set([
  "id", "seasonId", "lobbyId", "userId", "matchId", "teamId", "key",
  "draftId", "gameId", "dotaMatchId", "registrationId", "steamId", "discordId",
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
  let d = 0, inStr = null, esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === "\\") esc = true; else if (c === inStr) inStr = null; continue; }
    const j = skipComment(src, i);
    if (j !== i) { i = j; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) return [open, i + 1]; }
  }
  return null;
}

/** Top-level `key: value` spans inside an object literal. */
function topKeys(src, s, e) {
  const out = [];
  let d = 0, inStr = null, esc = false;
  for (let i = s + 1; i < e - 1; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === "\\") esc = true; else if (c === inStr) inStr = null; continue; }
    // Same reason as in `block` — and this scanner ALSO mis-read key names out
    // of comment prose, which is how `refundLobbyBets`' signature acquired a
    // phantom `write` key that no WHERE ever contained.
    const j = skipComment(src, i);
    if (j !== i) { i = j; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{" || c === "[" || c === "(") d++;
    else if (c === "}" || c === "]" || c === ")") d--;
    else if (d === 0) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i, i + 40));
      if (m && (i === s + 1 || /[\s,{]/.test(src[i - 1]))) {
        let j = i + m[0].length, dd = 0, st = null, es = false;
        for (; j < e - 1; j++) {
          const cc = src[j];
          if (es) { es = false; continue; }
          if (st) { if (cc === "\\") es = true; else if (cc === st) st = null; continue; }
          // Third scanner, same fix — and the most dangerous of the three to
          // leave broken: this one decides where a predicate's value ENDS, i.e.
          // the `drop` span `mutate()` physically deletes. A desync here cuts
          // the wrong source text, so the "mutant" tested is not the mutant the
          // report names.
          const jj = skipComment(src, j);
          if (jj !== j) { j = jj; continue; }
          if (cc === '"' || cc === "'" || cc === "`") { st = cc; continue; }
          if (cc === "{" || cc === "[" || cc === "(") dd++;
          else if (cc === "}" || cc === "]" || cc === ")") { if (dd === 0) break; dd--; }
          else if (cc === "," && dd === 0) break;
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
  for (let m; (m = decl.exec(src)); ) {
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
    const state = topKeys(src, wb[0], wb[1]).filter((k) => !IDENTITY.has(k.key));
    if (state.length === 0) continue;
    const sig = state.map((s) => s.key).sort().join("+");
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

/** Source with this claim's state predicates deleted — a blind write. */
function mutate(src, claim) {
  let out = src;
  for (const [s, e] of [...claim.drop].sort((a, b) => b[0] - a[0])) {
    let end = e;
    while (end < out.length && /[\s,]/.test(out[end]) && out[end] !== "\n") end++;
    out = out.slice(0, s) + out.slice(end);
  }
  return out;
}

/** True if the suite NOTICED the mutation (i.e. the guard is protected). */
function suiteCatches(claim) {
  const original = readFileSync(claim.file, "utf8");
  const { found } = discoverFile(claim.file);
  const live = found.find((c) => c.id === claim.id);
  if (!live) return { caught: false, missing: true };
  writeFileSync(claim.file, mutate(original, live));
  try {
    execSync("npx vitest run --config vitest.pg.config.mts --bail=1 --silent", {
      stdio: "pipe", timeout: 900_000, env: process.env,
    });
    return { caught: false, missing: false };
  } catch {
    return { caught: true, missing: false };
  } finally {
    writeFileSync(claim.file, original);
  }
}

// ---------------------------------------------------------------------------
if (!process.env.PG_TEST_URL) {
  console.error(
    "PG_TEST_URL is required — the ratchet is meaningless on SQLite, where the\n" +
      "raced tests that protect several claims cannot interleave.",
  );
  process.exit(2);
}

// A mutant is "caught" when the suite FAILS — which is also what happens if
// the suite is broken for any other reason (a syntax error in a test file, a
// missing DB). That would report every guard as protected: a false green in
// the very tool built to catch false greens. So prove the baseline is green
// first, and refuse to measure anything otherwise.
function suiteIsGreen() {
  try {
    execSync("npx vitest run --config vitest.pg.config.mts --silent", {
      stdio: "pipe", timeout: 900_000, env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

const discover = process.argv.includes("--discover");
// `--only <substring>` narrows to matching claim ids — a full sweep is one
// suite run per claim, which is far too slow a loop while writing the tests
// that close them.
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg !== -1 ? process.argv[onlyArg + 1] : null;

// `--shard i/n` verifies a deterministic slice of the baseline. Every mutant
// costs a full suite run, so the job grew linearly with coverage — 38 claims
// was 11 minutes of CI. Shards run as a matrix and the slices are disjoint, so
// coverage per push is unchanged; only the wall clock moves.
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
const claims = discoverAll().filter((c) => !only || c.id.includes(only));

if (!suiteIsGreen()) {
  console.error(
    "The suite does not pass on UNMUTATED source, so every mutant would look\n" +
      "caught and the result would be meaningless. Fix the suite first:\n" +
      "  npm run test:pg",
  );
  process.exit(2);
}

if (discover) {
  console.log(`Sweeping ${claims.length} guarded claims (one suite run each)…\n`);
  const protectedIds = [];
  for (const [i, c] of claims.entries()) {
    if (EQUIVALENT.has(c.id)) {
      console.log(`  [equivalent ] (${i + 1}/${claims.length}) ${c.id}`);
      continue;
    }
    const { caught } = suiteCatches(c);
    console.log(
      `  [${caught ? "PROTECTED  " : "unprotected"}] (${i + 1}/${claims.length}) ${c.id}  (${c.file}:${c.line})`,
    );
    if (caught) protectedIds.push(c.id);
  }
  if (only) {
    // A filtered sweep has only seen part of the repo, so writing the baseline
    // from it would silently DROP every claim it didn't look at — turning the
    // ratchet off for them. `--only` is a probe; the baseline comes from a
    // full run.
    console.log(
      `\n${protectedIds.length}/${claims.length} protected in this slice — ` +
        `baseline NOT written (--only is a probe; run a full --discover to update it).`,
    );
    process.exit(0);
  }
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note:
          "Guarded claims that a test actually protects. Generated by " +
          "`node scripts/mutation-guard.mjs --discover` (needs PG_TEST_URL). " +
          "CI re-mutates exactly these and fails if any stops being caught, or " +
          "disappears. Raise the ratchet by writing a race test and re-running.",
        totalClaims: claims.length,
        equivalent: [...EQUIVALENT].sort(),
        protected: protectedIds.sort(),
      },
      null,
      2,
    ) + "\n",
  );
  const gradeable = claims.filter((c) => !EQUIVALENT.has(c.id)).length;
  console.log(
    `\n${protectedIds.length}/${gradeable} protected ` +
      `(${claims.length - gradeable} equivalent mutants excluded) — ` +
      `baseline written to ${BASELINE}`,
  );
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`No ${BASELINE}. Run with --discover first.`);
  process.exit(2);
}
const base = JSON.parse(readFileSync(BASELINE, "utf8"));
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
    failures.push(`${id} — the guard no longer exists (removed, or its WHERE was weakened)`);
    continue;
  }
  const { caught } = suiteCatches(claim);
  console.log(`  [${caught ? "ok         " : "REGRESSED  "}] ${id}  (${claim.file}:${claim.line})`);
  if (!caught) {
    failures.push(
      `${id} (${claim.file}:${claim.line}) — deleting its guard no longer fails any test`,
    );
  }
}

const newly = claims.filter(
  (c) => !base.protected.includes(c.id) && !EQUIVALENT.has(c.id),
).length;
console.log(
  `\n${claims.length - newly}/${claims.length} claims protected; ` +
    `${newly} unprotected (not gating)` +
    (shard ? ` — this shard verified ${mine.length}.` : "."),
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
