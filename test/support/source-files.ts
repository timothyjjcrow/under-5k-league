import { globSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * Every non-test .ts/.tsx file directly inside one folder (repo-relative),
 * its `page.tsx` first and the rest by name. For a route folder whose
 * dynamic segment (`[id]`) a glob can't spell: a page split into a loader and
 * one file per card keeps its rules checkable wherever a card moves within
 * the folder. Throws when fewer than `minFiles` are found.
 */
export function folderSourceFiles(
  relativeDir: string,
  minFiles: number,
): SourceFile[] {
  const names = readdirSync(path.join(REPO_ROOT, relativeDir))
    .filter((name) => /\.tsx?$/.test(name) && !TEST_FILE.test(name))
    .sort((a, b) =>
      a === "page.tsx" ? -1 : b === "page.tsx" ? 1 : a.localeCompare(b),
    );
  if (names.length < minFiles) {
    throw new Error(
      `Source guard found ${names.length} file(s) in ${relativeDir}, expected ` +
        `at least ${minFiles}. The code it protects has moved; re-point the ` +
        `guard before trusting it.`,
    );
  }
  return names.map((name) => sourceFile(`${relativeDir}/${name}`));
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

/** Every Home source file (see HOME_PAGE_SOURCES). */
export function homePageFiles(): SourceFile[] {
  return sourceFiles(HOME_PAGE_SOURCES, 14);
}

/** Every Home source file's text, joined (see HOME_PAGE_SOURCES). */
export function homePageSource(): string {
  return haystackOf(homePageFiles());
}

/**
 * The admin page (`/admin`): the route file, which loads the season and picks
 * the order of the cards, plus the cards and their helpers in
 * src/components/admin. A guard that pins the admin page reads all of them,
 * so code moving between these files stays in view.
 */
const ADMIN_PAGE_SOURCES = [
  "src/app/admin/page.tsx",
  "src/components/admin/**/*.{ts,tsx}",
] as const;

/** Every admin page source file (see ADMIN_PAGE_SOURCES). */
export function adminPageFiles(): SourceFile[] {
  return sourceFiles(ADMIN_PAGE_SOURCES, 30);
}

/** Every admin page source file's text, joined (see ADMIN_PAGE_SOURCES). */
export function adminPageSource(): string {
  return haystackOf(adminPageFiles());
}

/**
 * One top-level declaration's text, from whichever of `files` declares it:
 * from its `function name(`, `const name` or `type name` line to the next
 * top-level declaration, or the end of that file. For a guard that pins one
 * card or helper wherever it moves. Throws unless exactly one file declares
 * it, so a renamed or duplicated declaration fails loudly instead of handing
 * the guard an empty string.
 */
export function declarationSource(
  files: readonly SourceFile[],
  name: string,
): string {
  const start = new RegExp(
    `^(?:export )?(?:default )?(?:async )?(?:function ${name}\\(|(?:const|type|interface) ${name}\\b)`,
    "m",
  );
  const found = files.filter((f) => start.test(f.text));
  if (found.length !== 1) {
    throw new Error(
      `Source guard expected one top-level declaration of ${name}, found ` +
        `${found.length} (${found.map((f) => f.path).join(", ") || "none"}). ` +
        `Re-point the guard before trusting it.`,
    );
  }
  const text = found[0].text;
  const from = text.search(start);
  const next = /^(?:export )?(?:default )?(?:async )?(?:function|const|let|type|interface|class) /m;
  const rest = text.slice(from + 1);
  const end = rest.search(next);
  return end < 0 ? text.slice(from) : text.slice(from, from + 1 + end);
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
