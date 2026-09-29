import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../test/support/source-files";

/**
 * A Dota name can be one character (the live league has a player called
 * "x"), so `PlayerLink` carries `min-w-6`: its tap target never drops under
 * WCAG 2.5.8's 24px. `cn` is twMerge, so a caller's own `min-w-*` REPLACES
 * that base. A row that must truncate passes `min-w-6` (a flex child can still
 * shrink to 24px and truncates fine); `min-w-0` hands a one-letter name back
 * its 8px target. Ten call sites had drifted to `min-w-0`.
 */
const PLAYER_LINK = /<PlayerLink\b([^>]*?)>/g;
const CLASS_NAME = /className=(\{[^}]*\}|"[^"]*")/;

describe("PlayerLink call sites", () => {
  const files = sourceFiles(["src/**/*.tsx"], 150);
  const sites = files.flatMap((f) =>
    [...f.text.matchAll(PLAYER_LINK)].map((m) => ({
      at: `${f.path}:${f.text.slice(0, m.index).split("\n").length}`,
      className: m[1].match(CLASS_NAME)?.[1] ?? "",
    })),
  );

  it("finds the call sites it polices", () => {
    expect(sites.length).toBeGreaterThanOrEqual(40);
    expect(sites.filter((s) => /\bmin-w-6\b/.test(s.className)).length).toBeGreaterThanOrEqual(10);
  });

  it("never overrides the one-character floor with min-w-0", () => {
    expect(
      sites.filter((s) => /\bmin-w-0\b/.test(s.className)).map((s) => s.at),
    ).toEqual([]);
  });
});
