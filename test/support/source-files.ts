import { globSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Shared file discovery for SOURCE GUARDS: the unit tests that read .ts/.tsx
 * text to enforce a rule nothing else can see (copy that names a real
 * control, a prop every countdown must carry, a module no client file may
 * import).
 *
 * A guard that reads a fixed list of files rots silently. Move the component
 * it names into a new file and a forbidden phrase or a missing prop moves with
 * it — out of the list — while the test keeps passing and checks nothing. So a
 * guard whose rule covers an AREA globs that area, and every glob states the
 * minimum number of files it expects to find: a renamed folder or a typo'd
 * pattern fails here, loudly, instead of reading nothing. Guards should also
 * assert a minimum number of MATCHES for the thing they inspect (countdowns,
 * call sites), for the same reason.
 */

/** The repository root (this file lives in `test/support/`). */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Tests never count as the source a guard protects. */
const TEST_FILE = /\.(?:test|itest|spec)\.[cm]?[jt]sx?$/;

export type SourceFile = {
  /** Repo-relative path with forward slashes, e.g. `src/app/page.tsx`. */
  path: string;
  text: string;
};

/**
 * Every non-test file matching any of `patterns` (repo-relative
 * `fs.globSync` patterns, so `**`, `*` and `{a,b}` work; a literal `[id]`
 * segment does NOT, because brackets are a character class), de-duplicated
 * and sorted by path. Throws when fewer than `minFiles` match.
 */
export function sourceFiles(
  patterns: string | readonly string[],
  minFiles: number,
): SourceFile[] {
  const list = typeof patterns === "string" ? [patterns] : [...patterns];
  const paths = [
    ...new Set(
      globSync(list, { cwd: REPO_ROOT }).map((p) =>
        p.split(path.sep).join("/"),
      ),
    ),
  ]
    .filter((p) => !TEST_FILE.test(p))
    .sort();
  if (paths.length < minFiles) {
    throw new Error(
      `Source guard found ${paths.length} file(s) for ${JSON.stringify(list)}, ` +
        `expected at least ${minFiles}. The code it protects has moved or the ` +
        `pattern is wrong; re-point the guard before trusting it.`,
    );
  }
  return paths.map((p) => ({
    path: p,
    text: readFileSync(path.join(REPO_ROOT, p), "utf8"),
  }));
}

/** One repo-relative file, by exact path. */
export function sourceFile(relativePath: string): SourceFile {
  return {
    path: relativePath,
    text: readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
  };
}

/** Every matching file's text, joined into one searchable string. */
export function haystackOf(files: readonly SourceFile[]): string {
  return files.map((f) => f.text).join("\n");
}

/**
 * Home (`/`): the route file, which loads the data and picks the phase, plus
 * the shared hero and the per-phase views it draws from src/components/home.
 * A guard that pins Home reads all of them, so code moving between these
 * files stays in view.
 */
const HOME_PAGE_SOURCES = [
  "src/app/page.tsx",
  "src/components/home/**/*.{ts,tsx}",
] as const;

/** Every Home source file's text, joined (see HOME_PAGE_SOURCES). */
export function homePageSource(): string {
  return haystackOf(sourceFiles(HOME_PAGE_SOURCES, 14));
}

/**
 * The text with whole-line comments dropped. Guards look for literals that the
 * comments explaining them also QUOTE; stripping comment lines keeps the
 * explanation without letting it satisfy (or trip) the guard.
 */
export function stripLineComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

/** Files whose text contains `needle` (a literal, or a RegExp match). */
export function filesContaining(
  files: readonly SourceFile[],
  needle: string | RegExp,
): SourceFile[] {
  // A /g or /y RegExp carries lastIndex between .test() calls, which would
  // make the result depend on the previous file; test with a stateless copy.
  const pattern =
    typeof needle === "string"
      ? null
      : new RegExp(needle.source, needle.flags.replace(/[gy]/g, ""));
  return files.filter((f) =>
    pattern ? pattern.test(f.text) : f.text.includes(needle as string),
  );
}
