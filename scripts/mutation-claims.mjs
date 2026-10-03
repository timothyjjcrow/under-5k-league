// Guarded-claim discovery, claim-id rules and baseline rules for the mutation
// guard (scripts/mutation-guard.mjs).
//
// Split out of the guard so these rules can be unit-tested without running
// the guard's CLI (`node --test scripts/mutation-claims.test.mjs`). Pure: it
// reads no file, touches no database and writes nothing.
import path from "node:path";
import ts from "typescript";
import { discoverThrottleSqlClaims } from "./mutation-sql-claims.mjs";

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
    // of comment prose, which is how a claim in the since-removed betting
    // service acquired a phantom `write` key that no WHERE ever contained.
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

function parse(file, src) {
  return ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * The TOP-LEVEL declaration a claim sits in: a function declaration's name, or
 * the name of the top-level `const`/`let` whose initializer holds the claim
 * (`export const POST = …`). Anchoring IDs to this is load-bearing: a
 * file-wide ordinal SHIFTS when a claim is removed, so deleting a guard made
 * its id silently re-bind to a different claim further down and the ratchet
 * reported all-clear. (Caught by sabotage-testing the ratchet itself.)
 *
 * It reads the TypeScript syntax tree, not the raw text. The first version
 * regex-scanned for the last `function <word>` / `const <word> = (` before the
 * claim, which also matched COMMENT prose ("this function exists to prevent"
 * anchored a claim to `exists`) and INNER helpers (`const finish = (…) =>`
 * inside a service anchored every later claim in that service to `finish`).
 * Rewording a comment or adding a local helper then renamed a protected claim:
 * CI reported it DISAPPEARED plus a new unreviewed claim, and only a full
 * Postgres --discover cleared it. Comments are trivia to the parser and inner
 * helpers are not top-level statements, so neither can become an anchor now.
 */
function claimAnchor(source, offset) {
  for (const statement of source.statements) {
    if (offset < statement.getStart(source) || offset >= statement.end) continue;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      return statement.name?.text ?? "default";
    }
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(
        (d) => offset >= d.getStart(source) && offset < d.end,
      );
      if (declaration && ts.isIdentifier(declaration.name)) {
        return declaration.name.text;
      }
    }
    return "<top>";
  }
  return "<top>";
}

/**
 * Every guarded claim in one source file.
 *
 * Claims are identified by file + enclosing top-level function + their
 * state-key SIGNATURE + an ordinal within that function — never by line
 * number, which every unrelated edit above them would churn.
 */
export function discoverClaims(file, src) {
  const found = discoverThrottleSqlClaims(file, src);
  const seen = new Map();
  let source = null;
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
    // Parse lazily: most production files the inventory sweep reads have no
    // claim at all.
    source ??= parse(file, src);
    const fn = claimAnchor(source, at);
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
  return found;
}

// The part of a claim id after its file and function: the predicate
// signature and the ordinal (`status+updatedAt#1`). Null for a string that is
// not a claim id.
function claimTail(id) {
  const at = id.lastIndexOf("::");
  return at === -1 ? null : id.slice(at + 2);
}

function repeated(values) {
  const seen = new Set();
  const out = new Set();
  for (const value of values) {
    if (seen.has(value)) out.add(value);
    seen.add(value);
  }
  return [...out].sort();
}

/**
 * Apply a baseline's optional `renames` object ({ "<old id>": "<new id>" }).
 *
 * An id names its file and top-level function, so MOVING a guarded function
 * to another file, or renaming it, changes the id while the guard itself is
 * untouched. Without this the ratchet reads the move as a protected guard
 * that DISAPPEARED plus a new unreviewed claim, and only a full Postgres
 * --discover (~25 minutes) clears it. A rename entry carries the old id's
 * classification to the new id instead.
 *
 * It carries the classification, never the evidence: verify mode re-mutates
 * the NEW id like any other protected claim, so a moved guard must still be
 * killed by a failing test at its new home. The next full --discover rewrites
 * the lists from live ids and drops the entries.
 *
 * Every entry must be an actual move: the old id is classified and no longer
 * live, the new id is live and not yet classified, no two entries land on the
 * same id, and only the file and function part of the id changes. The
 * predicate signature and ordinal must match (see claimTail), because an entry
 * that changes them is not a move: it would carry a protected classification
 * from a guard that was weakened (`status+updatedAt#1` to `status#1`, so verify
 * never mutates the dropped `updatedAt` again) or from a guard that was
 * deleted onto an unrelated new claim. Refusing the entry leaves both to fail
 * as they did before renames existed: a protected claim that DISAPPEARED plus
 * an unclassified one. Expects `base.protected`/`base.equivalent` to be string
 * arrays; returns the problems plus both lists with every rename applied and
 * sorted.
 */
export function resolveRenames(base, liveIds) {
  const unchanged = {
    protected: [...base.protected],
    equivalent: [...base.equivalent],
  };
  const raw = base.renames;
  if (raw === undefined) return { problems: [], ...unchanged };
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.values(raw).some((to) => typeof to !== "string")
  ) {
    return {
      problems: [
        "renames must be an object mapping each old claim id to its new id",
      ],
      ...unchanged,
    };
  }
  const entries = Object.entries(raw);
  const live = new Set(liveIds);
  const recorded = new Set([...base.protected, ...base.equivalent]);
  const problems = [];
  for (const [from, to] of entries) {
    if (!recorded.has(from)) {
      problems.push(`rename source is neither protected nor equivalent: ${from}`);
    }
    if (live.has(from)) {
      problems.push(`rename source is still a live claim, so nothing moved: ${from}`);
    }
    if (!live.has(to)) problems.push(`rename target is not a live claim: ${to}`);
    if (recorded.has(to)) problems.push(`rename target is already classified: ${to}`);
    const tail = claimTail(from);
    if (tail === null || tail !== claimTail(to)) {
      problems.push(
        `rename changes the claim's predicates or ordinal, so it is not a move (only the file and function may change): ${from} -> ${to}`,
      );
    }
  }
  for (const to of repeated(entries.map(([, to]) => to))) {
    problems.push(`more than one rename targets the same claim: ${to}`);
  }
  const map = new Map(entries);
  const apply = (ids) => ids.map((id) => map.get(id) ?? id).sort();
  return {
    problems,
    protected: apply(base.protected),
    equivalent: apply(base.equivalent),
  };
}

// A KILLER is the integration test file that failed first when a full
// --discover deleted a protected claim's guard. The baseline records them in
// an optional `killers` object ({ "<protected id>": "<test file>" }) so verify
// can run that one file before the whole suite. Verify passes the path to
// Vitest, so only a file the PostgreSQL suite's include pattern selects is
// accepted.
const KILLER_PATH = /^test\/integration\/(?:[\w-]+\/)*[\w.-]+\.itest\.ts$/;

function stringMap(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/**
 * Validate a baseline's optional `killers` object and carry its keys through
 * any `renames`, the way resolveRenames carries the lists. `protectedIds` is
 * the protected list with renames already applied. Returns the problems plus
 * a Map from protected claim id to its killer file.
 */
export function resolveKillers(base, protectedIds) {
  const killers = new Map();
  const raw = base.killers;
  if (raw === undefined) return { problems: [], killers };
  if (!stringMap(raw)) {
    return {
      problems: ["killers must be an object mapping protected claim ids to test files"],
      killers,
    };
  }
  const renames = stringMap(base.renames)
    ? new Map(Object.entries(base.renames))
    : new Map();
  const protectedSet = new Set(protectedIds);
  const problems = [];
  for (const [from, file] of Object.entries(raw)) {
    const id = renames.get(from) ?? from;
    if (!KILLER_PATH.test(file)) {
      problems.push(`killer for ${from} is not a test/integration/**/*.itest.ts file: ${file}`);
    } else if (!protectedSet.has(id)) {
      problems.push(`killer recorded for a claim that is not protected: ${from}`);
    } else if (killers.has(id)) {
      problems.push(`more than one killer for the same claim: ${id}`);
    } else {
      killers.set(id, file);
    }
  }
  return { problems, killers };
}

/**
 * The killer in a Vitest JSON report: the first test file with a FAILED test
 * (a file that only failed to load killed nothing), relative to `cwd`. Null
 * when the report names no such file inside the PostgreSQL suite.
 */
export function killerFromReport(report, cwd) {
  const files = Array.isArray(report?.testResults) ? report.testResults : [];
  for (const file of files) {
    const failed =
      Array.isArray(file?.assertionResults) &&
      file.assertionResults.some((test) => test?.status === "failed");
    if (!failed || typeof file.name !== "string") continue;
    const relative = path.relative(cwd, file.name).split(path.sep).join("/");
    return KILLER_PATH.test(relative) ? relative : null;
  }
  return null;
}

/**
 * The failed tests in a Vitest JSON report, one line each: the file relative
 * to `cwd`, the test's full name and the first line of its failure. A file
 * that failed without a failed test (an import or hook error) is listed with
 * its own message. The suite runs with --silent, so without this a red run
 * says only THAT something failed, never which test, and a flake that does
 * not repeat leaves nothing to chase. At most `limit` lines, plus a count.
 */
export function failedTestsFromReport(report, cwd, limit = 20) {
  const files = Array.isArray(report?.testResults) ? report.testResults : [];
  const lines = [];
  for (const file of files) {
    if (typeof file?.name !== "string") continue;
    const relative = path.relative(cwd, file.name).split(path.sep).join("/");
    const failed = Array.isArray(file.assertionResults)
      ? file.assertionResults.filter((test) => test?.status === "failed")
      : [];
    for (const test of failed) {
      const name =
        typeof test.fullName === "string" && test.fullName.trim()
          ? test.fullName.trim()
          : "(unnamed test)";
      lines.push(`${relative} › ${name}${firstLineOf(test.failureMessages?.[0])}`);
    }
    if (failed.length === 0 && file.status === "failed") {
      lines.push(`${relative}${firstLineOf(file.message) || ": failed before any test ran"}`);
    }
  }
  return lines.length > limit
    ? [...lines.slice(0, limit), `… and ${lines.length - limit} more`]
    : lines;
}

function firstLineOf(message) {
  if (typeof message !== "string") return "";
  const line = message.split("\n").find((part) => part.trim()) ?? "";
  return line ? `: ${line.trim().slice(0, 300)}` : "";
}

/**
 * Measure one mutant, trying its recorded killer first.
 *
 * `run(files)` runs the PostgreSQL suite with --bail over `files` (an empty
 * list is the whole suite) and returns { kind: "pass" | "test-failure" |
 * "infrastructure", … }; `exists(file)` says whether the killer is on disk.
 *
 * The rule does not change: a mutant is caught only when a test FAILS. The
 * killer changes the order, never the verdict — when it does not fail, for
 * any reason (survived, gone, or its run broke), the whole suite decides
 * exactly as it did before killers were recorded. With no killer, that is
 * the only run. `fallback` says why the whole suite had to run after a
 * killer.
 */
export function measureMutant(killer, { run, exists }) {
  let fallback = null;
  if (killer) {
    if (!exists(killer)) {
      fallback = "missing";
    } else {
      const first = run([killer]);
      if (first.kind === "test-failure") {
        return { run: first, via: "killer", fallback: null };
      }
      fallback = first.kind === "pass" ? "survived" : "infrastructure";
    }
  }
  return { run: run([]), via: "suite", fallback };
}

/**
 * Whether a recorded killer may run first. The whole-suite preflight proves
 * the unmutated suite green, which is what makes a later failure evidence of
 * the mutation; a killer's failure needs the same proof for that file ON ITS
 * OWN. So each killer file runs once against unmutated source, the first
 * time a claim uses it (`cache` remembers the result per file), and only a
 * pass makes it trusted. A missing file is passed through so measureMutant
 * reports it. Returns the killer to use (or null: the whole suite decides)
 * and, when it was refused, how its unmutated run ended.
 */
export function trustedKiller(file, { run, exists, cache }) {
  if (!file || !exists(file)) return { killer: file ?? null, untrusted: null };
  if (!cache.has(file)) cache.set(file, run([file]).kind);
  const alone = cache.get(file);
  return alone === "pass"
    ? { killer: file, untrusted: null }
    : { killer: null, untrusted: alone };
}
