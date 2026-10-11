import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  sourceFile,
  sourceFiles,
  stripLineComments,
} from "../../../test/support/source-files";

/**
 * Source contracts for the self-hosted display face (fonts/oswald.ts). A
 * mistake here fails quietly: a missing subset or a family listed after the
 * fallback renders that script in Arial, and next/font/google brings back a
 * compile-time download that broke CI's dev server.
 */
const MODULE_TEXT = sourceFile("src/app/fonts/oswald.ts").text;
const MODULE = stripLineComments(MODULE_TEXT);

const FAMILIES = MODULE.split(/(?=export const \w+ = localFont\()/)
  .slice(1)
  .map((text) => ({
    name: /export const (\w+) = localFont\(/.exec(text)![1],
    text,
    paths: [...text.matchAll(/path: "([^"]+)"/g)].map((m) => m[1]),
    weights: [...text.matchAll(/weight: "([^"]+)"/g)].map((m) => m[1]),
    variable: /variable: "(--[\w-]+)"/.exec(text)?.[1],
  }));

/** The variables `--font-oswald` chains, in order (globals.css). */
function oswaldChain(): string[] {
  const css = sourceFile("src/app/globals.css").text;
  const value = /--font-oswald:([^;]+);/.exec(css)?.[1] ?? "";
  return [...value.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
}

describe("the Oswald display face", () => {
  it("never downloads a font from Google while compiling", () => {
    const files = sourceFiles("src/**/*.{ts,tsx}", 200);
    const loaders = files.filter((f) =>
      /["'](?:next|@next)\/font\/google["']/.test(f.text),
    );
    expect(loaders.map((f) => f.path)).toEqual([]);
  });

  it("self-hosts each subset from a committed woff2 under Oswald's licence", () => {
    expect(FAMILIES.map((f) => f.name)).toEqual([
      "oswaldLatinExt",
      "oswaldVietnamese",
      "oswaldCyrillic",
      "oswaldCyrillicExt",
      "oswaldLatin",
    ]);
    const files = new Set<string>();
    for (const family of FAMILIES) {
      // Google's weights for this layout, all three from one variable file.
      expect(family.weights, family.name).toEqual(["500", "600", "700"]);
      expect(new Set(family.paths).size, family.name).toBe(1);
      expect(family.text, family.name).toContain('display: "swap"');
      expect(family.text, family.name).toMatch(
        /prop: "unicode-range",\s*value:\s*"U\+[0-9A-F]/,
      );
      files.add(family.paths[0]);
    }
    expect(files.size).toBe(FAMILIES.length);
    for (const file of files) {
      const absolute = path.join(REPO_ROOT, "src/app/fonts", file);
      // WOFF2's magic number.
      expect(readFileSync(absolute).subarray(0, 4).toString(), file).toBe("wOF2");
    }
    // The licence travels with the repository's Oswald (one copy: see
    // oswald.ts).
    expect(MODULE_TEXT).toContain("src/lib/og-fonts/OFL.txt");
    expect(sourceFile("src/lib/og-fonts/OFL.txt").text).toMatch(
      /^Copyright 2016 The Oswald Project Authors[\s\S]*SIL Open Font License, Version 1\.1/,
    );
  });

  it("chains every subset into --font-oswald, latin last with the only preload and fallback", () => {
    expect(oswaldChain()).toEqual(FAMILIES.map((f) => f.variable));
    expect(FAMILIES.at(-1)!.name).toBe("oswaldLatin");
    for (const family of FAMILIES.slice(0, -1)) {
      expect(family.text, family.name).toContain("preload: false");
      expect(family.text, family.name).toContain("adjustFontFallback: false");
    }
    const latin = FAMILIES.at(-1)!.text;
    expect(latin).not.toMatch(/preload:|adjustFontFallback:/);

    // Every family's variable class reaches <html>.
    expect(MODULE).toMatch(
      /oswaldVariables = \[\s*oswaldLatinExt,\s*oswaldVietnamese,\s*oswaldCyrillic,\s*oswaldCyrillicExt,\s*oswaldLatin,\s*\]/,
    );
    expect(sourceFile("src/app/layout.tsx").text).toContain(
      "className={`h-full antialiased ${oswaldVariables}`}",
    );
  });
});
