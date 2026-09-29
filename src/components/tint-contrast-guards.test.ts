import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../test/support/source-files";

/**
 * Red TEXT on a red-tinted box uses `text-danger-soft`, never plain
 * `text-danger`: plain danger on a `bg-danger/10` tint is about 4.3:1, under
 * AA for body and small text, and the soft token is 5.6:1 (globals.css).
 * The admin Playoffs warning, the form error box, the sign-in error and the
 * rooms' danger status line all shipped the plain pair.
 *
 * The guard reads each quoted class string on its own, so a box whose words
 * are `text-fg` (with only an icon inheriting the red) never sets the pair in
 * one string and isn't flagged.
 */
const CLASS_STRING = /"[^"\n]*"|`[^`\n]*`/g;
const DANGER_TINT = /(?:^|[\s"`])bg-danger\/(?:5|10|15|20)(?=[\s"`])/;
const PLAIN_DANGER_TEXT = /(?:^|[\s"`])text-danger(?=[\s"`])/;

describe("danger text on a danger tint", () => {
  const files = sourceFiles(["src/**/*.tsx", "src/**/*.ts"], 150);
  const tinted = files.flatMap((f) =>
    [...f.text.matchAll(CLASS_STRING)]
      .map((m) => m[0])
      .filter((s) => DANGER_TINT.test(s))
      .map((s) => ({ at: f.path, s })),
  );

  it("finds the tinted boxes it polices", () => {
    expect(tinted.length).toBeGreaterThanOrEqual(8);
  });

  it("never pairs a bg-danger tint with plain text-danger", () => {
    expect(
      tinted
        .filter(({ s }) => PLAIN_DANGER_TEXT.test(s))
        .map(({ at, s }) => `${at}: ${s}`),
    ).toEqual([]);
  });
});
