import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...path: string[]) => readFileSync(join(__dirname, ...path), "utf8");
const HOME = read("page.tsx");
const LAYOUT = read("layout.tsx");
const PUBLIC_NAVIGATION = read("../lib/public-navigation.ts");

describe("shared-shell query efficiency", () => {
  it("checks for archived seasons without counting every archived row", () => {
    expect(LAYOUT).toContain("getPublicHasHistory(null)");
    expect(LAYOUT).not.toMatch(/prisma\.season\.(?:count|findFirst)\(\{/);
    expect(PUBLIC_NAVIGATION).toMatch(/prisma\.season\.findFirst\(\{/);
    expect(PUBLIC_NAVIGATION).not.toMatch(/prisma\.season\.count\(\{/);
  });
});

describe("homepage query efficiency", () => {
  it("reads the viewer's picks once, for the side-game hint AND every This-week card", () => {
    // One lookup, signed-in only; a per-card query would be N round trips on
    // the hottest page.
    expect(HOME.match(/prisma\.prediction\./g)).toHaveLength(1);
    expect(HOME).toMatch(
      /userId && viewerPickIds\.length > 0\s*\?\s*await prisma\.prediction\.findMany\(/,
    );
  });

  it("reuses the season game count for the hero and fantasy lock", () => {
    expect(HOME.match(/prisma\.game\.count\(\{/g)).toHaveLength(1);
    expect(HOME).toContain("gamesOnRecord={gamesOnRecord}");
    expect(HOME).toMatch(/gamesOnRecord: number;/);
  });
});
