import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../test/support/source-files";

// SOURCE GUARD: no raw bidi control characters in the code ("Trojan Source").
// An override, embedding, isolate or directional mark written literally into
// a source file makes an editor or GitHub show the line in another order than
// the compiler reads it, and this repository is public. Code that needs one
// (the lobby chat's name cleaner, its tests) spells it as a \u escape, which
// reads the same everywhere. Zero-width spaces and joiners are not on the
// list: Discord escaping and emoji tests use them on purpose.
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const CODE = [
  "{src,test,e2e,e2e-mid,e2e-postseason,scripts,prisma}/**/*.{ts,tsx,mts,cts,js,mjs,cjs,json,css,prisma,sql}",
  "ops/**/*.{ts,mts,js,mjs,cjs,json,proto,sh}",
];

function codeFiles(): string[] {
  return globSync(CODE, {
    cwd: REPO_ROOT,
    exclude: ["**/node_modules/**", "**/.next/**", "**/.wrangler/**"],
  })
    .map((p) => p.split(path.sep).join("/"))
    .sort();
}

describe("bidi control characters (source)", () => {
  it("finds the code it guards", () => {
    const files = codeFiles();
    // This file and the name cleaner are among them, so the guard reads the
    // test files too (unlike `sourceFiles`, which skips them on purpose).
    expect(files).toContain("src/lib/bidi-source-guard.test.ts");
    expect(files).toContain("src/lib/dota-lobby.ts");
    expect(files).toContain("src/lib/dota-lobby.test.ts");
    expect(files).toContain("test/integration/dota-lobby.itest.ts");
    expect(files.some((f) => f.startsWith("ops/"))).toBe(true);
    expect(files.length).toBeGreaterThan(500);
  });

  it("has none written literally: spell them as \\u escapes", () => {
    const hits: string[] = [];
    for (const file of codeFiles()) {
      const lines = readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const m = BIDI.exec(line);
        if (m) {
          const code = m[0].codePointAt(0)!.toString(16).padStart(4, "0");
          hits.push(`${file}:${i + 1} U+${code.toUpperCase()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
