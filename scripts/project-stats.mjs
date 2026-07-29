#!/usr/bin/env node
// Measures the size of this project and writes src/lib/project-stats.json.
//
// Run by `prebuild`, so a production deploy always ships numbers measured from
// the tree it is building. The output is COMMITTED as well, which is what makes
// the git-derived figure correct on Vercel: builds there run against a shallow
// clone where `git rev-list --count HEAD` is wrong (or fails), so the script
// keeps the committed value — written by a local run of the very commit being
// deployed. Filesystem figures are always recounted and never fall back.
//
// Every figure here only ever grows. That is deliberate: the Discord board
// learned the hard way that a trailing-window stat ("commits this week") reads
// as a dead project during exactly the quiet stretch it was meant to paper over.

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "src/lib/project-stats.json");

const CODE_EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".css", ".prisma"]);
const SKIP_DIR = new Set([
  "node_modules",
  ".next",
  ".git",
  "backups",
  "test-results",
  "playwright-report",
  "public",
]);

/** A test file by this project's own conventions: *.test.ts, *.itest.ts, e2e specs. */
function isTest(path) {
  return (
    /\.(test|itest|spec)\.[jt]sx?$/.test(path) ||
    path.startsWith("e2e/") ||
    path.startsWith("e2e-mid/") ||
    path.startsWith("test/")
  );
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR.has(entry) || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXT.has(extname(full))) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
let codeLines = 0;
let testLines = 0;
let codeFiles = 0;
let testFiles = 0;
let tests = 0;

for (const full of files) {
  const rel = relative(ROOT, full);
  const src = readFileSync(full, "utf8");
  // Non-blank only. Comments DO count — in this codebase the reasoning written
  // above a guard is a large part of the work, and stripping it would report a
  // number that undersells the thing the stat exists to describe.
  const lines = src.split("\n").filter((l) => l.trim()).length;
  if (isTest(rel)) {
    testFiles++;
    testLines += lines;
    // Test CASES, not assertions: `it(` / `test(` at a statement position.
    // A loop inside one `it` is still one test, which is what the suite reports.
    //
    // The suffix list is explicit rather than `\.\w+` because Playwright hangs
    // its hooks off the same identifier — `test.beforeEach(`, `test.use(` and
    // `test.setTimeout(` were being counted as five tests that do not exist.
    // Undercounting is the safe direction and this still does a little of it:
    // one `it.each([...])` is N cases at run time and 1 here.
    tests += (
      src.match(
        /^\s*(it|test)(\.(each|only|skip|todo|fails|concurrent|sequential))?\s*\(/gm,
      ) || []
    ).length;
  } else {
    codeFiles++;
    codeLines += lines;
  }
}

function git(cmd, fallback = null) {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return fallback;
  }
}

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const shallow = git("git rev-parse --is-shallow-repository") === "true";
const commits = shallow ? null : Number(git("git rev-list --count HEAD")) || null;
// NOT `git log --reverse --max-count=1`: the limit is applied BEFORE the
// reverse, so that returns the NEWEST commit — it reported this project as
// having started today. The root commit is the only unambiguous way to ask.
const rootSha = shallow ? null : git("git rev-list --max-parents=0 HEAD");
const firstCommit = rootSha
  ? git(`git log -1 --format=%cI ${rootSha.split("\n")[0]}`)
  : null;

const stats = {
  codeLines,
  codeFiles,
  testLines,
  testFiles,
  tests,
  // Keep the committed value when git can't answer — see the header.
  commits: commits ?? prev.commits ?? null,
  firstCommit: firstCommit ?? prev.firstCommit ?? null,
};

writeFileSync(OUT, JSON.stringify(stats, null, 2) + "\n");
console.log(
  `project-stats: ${stats.codeLines} code lines in ${stats.codeFiles} files, ` +
    `${stats.tests} tests in ${stats.testFiles} files, ${stats.commits} commits` +
    (shallow ? " (shallow clone — kept committed git figures)" : ""),
);
