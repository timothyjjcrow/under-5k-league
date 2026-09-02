#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REGULAR_FILE_MODE = "100644";

const UI_STYLE_FILES = new Set(["src/app/globals.css"]);
const UI_PRESENTATION_COMPONENTS = new Set([
  "src/components/site-footer.tsx",
  "src/components/site-header.tsx",
]);
const UI_PUBLIC_ASSET =
  /\.(?:avif|gif|ico|jpe?g|mp4|png|svg|webm|webp|woff2?)$/i;

const STRICT_FILES = new Set([
  ".env",
  ".env.example",
  ".gitignore",
  ".vercelignore",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/PRODUCTION-OPERATIONS.md",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "postcss.config.js",
  "postcss.config.mjs",
  "postcss.config.ts",
  "tsconfig.json",
  "vercel.json",
]);

const STRICT_PREFIXES = [
  ".github/",
  "ops/",
  "prisma/",
  "scripts/",
  "src/app/actions/",
  "src/app/api/",
  "src/lib/",
];

const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const TEST_PREFIXES = ["e2e/", "test/"];
const DOC_PREFIXES = ["docs/"];

const SCHEDULER_PREFIXES = [
  "ops/",
  "src/app/api/cron/",
  "src/app/api/health/automation/",
];
const SCHEDULER_LIBRARY =
  /^src\/lib\/(?:automation(?:-|\.)|cron(?:-|\.)|external-automation-scheduler(?:\.|$))/;

function fail(message) {
  throw new Error(`release classifier: ${message}`);
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) fail(`could not run git: ${result.error.message}`);
  if (result.signal) fail(`git ${args[0]} ended from signal ${result.signal}`);
  return result;
}

function requireGitSuccess(args, cwd) {
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    fail(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function takeToken(tokens, cursor, label) {
  if (cursor.index >= tokens.length)
    fail(`malformed git diff: missing ${label}`);
  const value = tokens[cursor.index];
  cursor.index += 1;
  if (!value) fail(`malformed git diff: empty ${label}`);
  return value;
}

function nulTokens(output) {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  return tokens;
}

/** Parse `git diff --name-status -z --find-renames`. */
export function parseNameStatus(output) {
  const tokens = nulTokens(output);
  const cursor = { index: 0 };
  const entries = [];

  while (cursor.index < tokens.length) {
    const status = takeToken(tokens, cursor, "status");
    if (!/^[A-Z][0-9]*$/.test(status)) {
      fail(`malformed git diff status ${JSON.stringify(status)}`);
    }
    const code = status[0];
    if (code === "R" || code === "C") {
      entries.push({
        status,
        code,
        oldPath: takeToken(tokens, cursor, "old path"),
        path: takeToken(tokens, cursor, "new path"),
      });
    } else {
      entries.push({
        status,
        code,
        oldPath: null,
        path: takeToken(tokens, cursor, "path"),
      });
    }
  }

  return entries;
}

/** Parse `git diff --raw -z --find-renames --no-abbrev`. */
export function parseRawDiff(output) {
  const tokens = nulTokens(output);
  const cursor = { index: 0 };
  const entries = [];

  while (cursor.index < tokens.length) {
    const header = takeToken(tokens, cursor, "raw header");
    const match = header.match(
      /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/,
    );
    if (!match) fail(`malformed raw git diff header ${JSON.stringify(header)}`);
    const [, oldMode, newMode, , , status] = match;
    const code = status[0];
    if (code === "R" || code === "C") {
      entries.push({
        status,
        code,
        oldMode,
        newMode,
        oldPath: takeToken(tokens, cursor, "raw old path"),
        path: takeToken(tokens, cursor, "raw new path"),
      });
    } else {
      entries.push({
        status,
        code,
        oldMode,
        newMode,
        oldPath: null,
        path: takeToken(tokens, cursor, "raw path"),
      });
    }
  }

  return entries;
}

function mergeDiffMetadata(named, raw) {
  if (named.length !== raw.length) {
    fail("name-status and raw git diffs disagree on the changed-file count");
  }
  return named.map((entry, index) => {
    const rawEntry = raw[index];
    if (
      entry.status !== rawEntry.status ||
      entry.path !== rawEntry.path ||
      entry.oldPath !== rawEntry.oldPath
    ) {
      fail("name-status and raw git diffs disagree on a changed file");
    }
    return { ...entry, oldMode: rawEntry.oldMode, newMode: rawEntry.newMode };
  });
}

function isTestPath(path) {
  return (
    TEST_FILE.test(path) ||
    TEST_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

function isNeutralPath(path) {
  return (
    DOC_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    isTestPath(path)
  );
}

function isStrictPath(path) {
  return (
    STRICT_FILES.has(path) ||
    /^\.env(?:\.|$)/.test(path) ||
    STRICT_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

function isUiOnlyEntry(entry) {
  return (
    UI_STYLE_FILES.has(entry.path) ||
    (UI_PRESENTATION_COMPONENTS.has(entry.path) &&
      entry.code === "M" &&
      entry.presentationSafe === true) ||
    (entry.path.startsWith("public/") && UI_PUBLIC_ASSET.test(entry.path))
  );
}

function normalizedStaticClassNameLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("<") || !trimmed.endsWith(">")) return null;

  const attribute = /(^|[\s<])className\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*')/g;
  const matches = [...line.matchAll(attribute)];
  if (matches.length !== 1) return null;

  const match = matches[0];
  if (match.index === undefined) return null;
  const prefix = match[1];
  return `${line.slice(0, match.index)}${prefix}className=__STATIC_CLASS_LIST__${line.slice(match.index + match[0].length)}`;
}

/**
 * Accept only zero-context hunks where an existing JSX tag's static className
 * string is the sole changed source text. This intentionally rejects imports,
 * expressions, multiline attributes, handlers, and any other logic change.
 */
export function isStaticClassNameOnlyDiff(patch) {
  const hunks = [];
  let current = null;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@ ")) {
      current = { removed: [], added: [] };
      hunks.push(current);
      continue;
    }
    if (
      line === "" ||
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      continue;
    }
    if (!current) return false;
    if (line.startsWith("-")) {
      current.removed.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      current.added.push(line.slice(1));
      continue;
    }
    // Zero-context diffs should contain no context or metadata inside a hunk.
    return false;
  }

  if (hunks.length === 0) return false;
  return hunks.every(({ removed, added }) => {
    if (removed.length === 0 || removed.length !== added.length) return false;
    return removed.every((oldLine, index) => {
      const normalizedOld = normalizedStaticClassNameLine(oldLine);
      const normalizedNew = normalizedStaticClassNameLine(added[index]);
      return normalizedOld !== null && normalizedOld === normalizedNew;
    });
  });
}

function isAppPath(path) {
  return path.startsWith("src/app/") || path.startsWith("src/components/");
}

function impactForStrictPath(path) {
  if (isTestPath(path)) {
    return { needsDbRelease: false, needsSchedulerPause: false };
  }

  // Strict review of release plumbing is not itself a reason to run a schema
  // writer. Only a committed Prisma/schema surface selects the DB-release
  // procedure; malformed/unknown changes are handled fail-closed by the caller.
  const needsDbRelease = path.startsWith("prisma/");
  const needsSchedulerPause =
    needsDbRelease ||
    SCHEDULER_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    SCHEDULER_LIBRARY.test(path);
  return { needsDbRelease, needsSchedulerPause };
}

function entryModeIsSafe(entry) {
  if (entry.code === "A") {
    return entry.oldMode === "000000" && entry.newMode === REGULAR_FILE_MODE;
  }
  return (
    entry.code === "M" &&
    entry.oldMode === REGULAR_FILE_MODE &&
    entry.newMode === REGULAR_FILE_MODE
  );
}

function resultFor(
  lane,
  changedFiles,
  reasons,
  { needsDbRelease = false, needsSchedulerPause = false } = {},
) {
  return {
    lane,
    changedFiles,
    reasons,
    needs_postgres: lane !== "ui-only",
    needs_mutation: lane !== "ui-only",
    needs_e2e: true,
    needs_db_release: needsDbRelease,
    needs_scheduler_pause: needsSchedulerPause,
  };
}

export function classifyEntries(entries) {
  if (entries.length === 0) fail("base and head have no changed files");

  const changedFiles = entries.flatMap((entry) =>
    entry.oldPath ? [entry.oldPath, entry.path] : [entry.path],
  );
  const reasons = [];
  let sawUi = false;
  let sawApp = false;
  let sawStrict = false;
  let needsDbRelease = false;
  let needsSchedulerPause = false;

  for (const entry of entries) {
    const label = entry.oldPath
      ? `${entry.oldPath} -> ${entry.path}`
      : entry.path;

    if (entry.code !== "A" && entry.code !== "M") {
      sawStrict = true;
      needsDbRelease = true;
      needsSchedulerPause = true;
      reasons.push(
        `${entry.status} ${label}: only additions/modifications qualify`,
      );
      continue;
    }
    if (!entryModeIsSafe(entry)) {
      sawStrict = true;
      needsDbRelease = true;
      needsSchedulerPause = true;
      reasons.push(
        `${entry.status} ${label}: file type or mode is not an unchanged regular 100644 file`,
      );
      continue;
    }
    if (isStrictPath(entry.path)) {
      sawStrict = true;
      const impact = impactForStrictPath(entry.path);
      needsDbRelease ||= impact.needsDbRelease;
      needsSchedulerPause ||= impact.needsSchedulerPause;
      const impactReason = impact.needsDbRelease
        ? "; database release and scheduler controls required"
        : impact.needsSchedulerPause
          ? "; scheduler controls required"
          : "";
      reasons.push(
        `${entry.status} ${label}: production-sensitive path${impactReason}`,
      );
      continue;
    }
    if (isNeutralPath(entry.path)) {
      reasons.push(`${entry.status} ${label}: neutral documentation/test path`);
      continue;
    }
    if (isUiOnlyEntry(entry)) {
      sawUi = true;
      reasons.push(`${entry.status} ${label}: verified UI-only change`);
      continue;
    }
    if (isAppPath(entry.path)) {
      sawApp = true;
      reasons.push(`${entry.status} ${label}: application path`);
      continue;
    }
    sawStrict = true;
    needsDbRelease = true;
    needsSchedulerPause = true;
    reasons.push(`${entry.status} ${label}: unknown path`);
  }

  if (sawStrict) {
    return resultFor("strict", changedFiles, reasons, {
      needsDbRelease,
      needsSchedulerPause,
    });
  }
  if (sawApp) return resultFor("app", changedFiles, reasons);
  if (sawUi) return resultFor("ui-only", changedFiles, reasons);

  reasons.push(
    "no deployable UI or application change established a fast lane",
  );
  return resultFor("strict", changedFiles, reasons);
}

function verifyFullCommitSha(sha, label, cwd) {
  if (!FULL_SHA.test(sha))
    fail(`${label} must be a full lowercase 40-character SHA`);
  const resolved = requireGitSuccess(
    ["rev-parse", "--verify", `${sha}^{commit}`],
    cwd,
  ).trim();
  if (resolved !== sha)
    fail(`${label} did not resolve to the exact requested commit`);
}

export function classifyRelease({ base, head, cwd = process.cwd() }) {
  verifyFullCommitSha(base, "--base", cwd);
  verifyFullCommitSha(head, "--head", cwd);

  const ancestry = runGit(["merge-base", "--is-ancestor", base, head], cwd);
  if (ancestry.status === 1) fail("--base is not an ancestor of --head");
  if (ancestry.status !== 0) {
    const detail = ancestry.stderr.trim();
    fail(`could not verify commit ancestry${detail ? `: ${detail}` : ""}`);
  }

  const named = parseNameStatus(
    requireGitSuccess(
      [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--find-copies-harder",
        base,
        head,
      ],
      cwd,
    ),
  );
  const raw = parseRawDiff(
    requireGitSuccess(
      [
        "diff",
        "--raw",
        "-z",
        "--find-renames",
        "--find-copies-harder",
        "--no-abbrev",
        base,
        head,
      ],
      cwd,
    ),
  );
  const entries = mergeDiffMetadata(named, raw).map((entry) => {
    if (
      !UI_PRESENTATION_COMPONENTS.has(entry.path) ||
      entry.code !== "M" ||
      !entryModeIsSafe(entry)
    ) {
      return entry;
    }
    const patch = requireGitSuccess(
      [
        "diff",
        "--unified=0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        base,
        head,
        "--",
        entry.path,
      ],
      cwd,
    );
    return {
      ...entry,
      presentationSafe: isStaticClassNameOnlyDiff(patch),
    };
  });
  const result = classifyEntries(entries);
  return { baseSha: base, headSha: head, ...result };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--base", "--head", "--format"].includes(flag)) {
      fail(`unknown argument ${JSON.stringify(flag)}`);
    }
    if (values.has(flag)) fail(`duplicate argument ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  for (const required of ["--base", "--head", "--format"]) {
    if (!values.has(required)) fail(`missing required argument ${required}`);
  }
  const format = values.get("--format");
  if (format !== "json" && format !== "github") {
    fail("--format must be json or github");
  }
  return {
    base: values.get("--base"),
    head: values.get("--head"),
    format,
  };
}

function githubOutput(result) {
  const keys = [
    "lane",
    "baseSha",
    "headSha",
    "needs_postgres",
    "needs_mutation",
    "needs_e2e",
    "needs_db_release",
    "needs_scheduler_pause",
  ];
  return keys.map((key) => `${key}=${String(result[key])}`).join("\n");
}

function main() {
  try {
    const { base, head, format } = parseArgs(process.argv.slice(2));
    const result = classifyRelease({ base, head });
    process.stdout.write(
      format === "json"
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${githubOutput(result)}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
