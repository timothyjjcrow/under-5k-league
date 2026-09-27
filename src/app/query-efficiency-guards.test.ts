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

  // Every page renders the layout, so the header's "Join Season N" costs one
  // unique-key row for signed-in viewers during signups and nothing else.
  it("reads the viewer's signup for the join button with one unique-key lookup", () => {
    expect(LAYOUT.match(/prisma\.registration\./g)).toHaveLength(1);
    expect(LAYOUT).toContain("prisma.registration.findUnique({");
    expect(LAYOUT).toMatch(
      /user && season\?\.status === "SIGNUPS"\s*\?\s*prisma\.registration/,
    );
  });

  // The header's "Series live" chip reads one indexed row behind the shared
  // public snapshot, never a list or a count of the season's matches.
  it("checks for a live series through the cached public snapshot", () => {
    expect(LAYOUT).toContain("getPublicHasLiveMatch(season.id)");
    expect(LAYOUT).not.toMatch(/prisma\.match\./);
    expect(PUBLIC_NAVIGATION).toMatch(/prisma\.match\.findFirst\(\{/);
    expect(PUBLIC_NAVIGATION).not.toMatch(/prisma\.match\.(?:count|findMany)\(/);
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
