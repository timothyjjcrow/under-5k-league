import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, sourceFiles } from "../../test/support/source-files";

/**
 * A colour class must name a colour the theme defines.
 *
 * Tailwind v4 generates utilities only for the `--color-*` tokens in
 * globals.css (plus its own palette). A class naming anything else renders
 * NOTHING, with no build error: `text-warning`, `bg-warning/10` and
 * `border-warning/40` shipped on the draft room's "out of date" and "hasn't
 * loaded" boxes, the rooms' delayed status line, /me's unverified-account note
 * and the database health card, and every one of them drew as plain text with
 * no box. The site's warning colour is `accent` (amber).
 *
 * The guard checks every class whose colour name LOOKS like a theme token:
 * its first segment is the first segment of a defined token (`surface-1`,
 * `info-strong`) or it is a semantic name other design systems use
 * (`warning`, `error`, `primary`...). Palette colours (`amber-400`) and
 * non-colour utilities (`text-sm`, `border-2`) are left alone.
 */
const CSS = readFileSync(path.join(REPO_ROOT, "src/app/globals.css"), "utf8");
const TOKENS = new Set(
  [...CSS.matchAll(/^\s*--color-([a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
);
const TOKEN_ROOTS = new Set([...TOKENS].map((t) => t.split("-")[0]));
const SEMANTIC_NAMES = new Set([
  "warning",
  "warn",
  "error",
  "primary",
  "secondary",
  "destructive",
  "caution",
  "attention",
  "positive",
  "negative",
  "foreground",
  "background",
]);

const COLOR_CLASS =
  /(?:^|[\s"'`:])(?:text|bg|border(?:-[trblxyse])?|ring|ring-offset|outline|divide|decoration|placeholder|caret|fill|stroke|from|via|to)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?=\/|[\s"'`]|$)/g;

function tokenShaped(name: string): boolean {
  return SEMANTIC_NAMES.has(name) || TOKEN_ROOTS.has(name.split("-")[0]);
}

describe("colour classes name defined theme tokens", () => {
  const files = sourceFiles(["src/**/*.tsx", "src/**/*.ts"], 150);
  const uses = files.flatMap((f) =>
    [...f.text.matchAll(COLOR_CLASS)]
      .map((m) => m[1])
      .filter(tokenShaped)
      .map((name) => ({ at: f.path, name })),
  );

  it("reads the theme and finds the classes it polices", () => {
    for (const token of ["accent", "danger", "danger-soft", "info", "surface"]) {
      expect(TOKENS.has(token), token).toBe(true);
    }
    expect(uses.length).toBeGreaterThan(500);
  });

  it("uses no colour name globals.css doesn't define", () => {
    expect(
      uses
        .filter(({ name }) => !TOKENS.has(name))
        .map(({ at, name }) => `${at}: ${name}`),
    ).toEqual([]);
  });

  it("recognises the classes that once rendered nothing", () => {
    const names = (s: string) =>
      [...s.matchAll(COLOR_CLASS)].map((m) => m[1]).filter(tokenShaped);
    expect(names('"border-warning/40 bg-warning/10 text-warning"')).toEqual([
      "warning",
      "warning",
      "warning",
    ]);
    expect(names('"hover:bg-surface-1"')).toEqual(["surface-1"]);
    expect(names('"text-sm border-2 bg-amber-400/10 text-fg"')).toEqual(["fg"]);
  });
});
