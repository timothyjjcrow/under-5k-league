import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...path: string[]) => readFileSync(join(__dirname, ...path), "utf8");
const HOME = read("page.tsx");
const LAYOUT = read("layout.tsx");
const PUBLIC_NAVIGATION = read("../lib/public-navigation.ts");
const QUERIES = read("../lib/queries.ts");
const LINK_PREVIEW_METADATA = read("../lib/link-preview-metadata.ts");

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
    expect(LAYOUT).not.toMatch(/prisma\.registration\./);
    expect(LAYOUT).toMatch(
      /user && season\?\.status === "SIGNUPS"\s*\?\s*getViewerRegistration\(season\.id, user\.id\)/,
    );
    expect(QUERIES.match(/prisma\.registration\.findUnique\(\{/g)).toHaveLength(1);
    expect(QUERIES).toMatch(
      /getViewerRegistration = cache\([\s\S]*?prisma\.registration\.findUnique\(\{\s*where: \{ seasonId_userId:/,
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

  // The menus offer the statistics pages, the Hall of Fame and Fantasy only
  // once they have something to show. Every page pays for that, so it is
  // existence reads behind the shared snapshot, never a count or a scan.
  it("decides which data pages to offer from cached existence reads", () => {
    expect(LAYOUT).toContain("getPublicLeagueContent(null)");
    expect(LAYOUT).toContain("getPublicSeasonHasGames(season.id)");
    expect(LAYOUT).not.toMatch(/prisma\.game\./);
    expect(PUBLIC_NAVIGATION).toMatch(/prisma\.game\.findFirst\(\{/);
    expect(PUBLIC_NAVIGATION).not.toMatch(/prisma\.game\.(?:count|findMany)\(/);
  });

  it("reads the viewer's fantasy entry with one unique-key lookup", () => {
    expect(LAYOUT).not.toMatch(/prisma\.fantasyRoster\./);
    expect(LAYOUT).toContain("getViewerFantasyEntered(season.id, user.id)");
    expect(QUERIES.match(/prisma\.fantasyRoster\./g)).toHaveLength(1);
    expect(QUERIES).toMatch(
      /getViewerFantasyEntered = cache\([\s\S]*?prisma\.fantasyRoster\.findUnique\(\{\s*where: \{ seasonId_userId:/,
    );
  });

  // During DRAFT the layout, Home's snapshot and Home's link preview all need
  // the auction status: one request-cached read, never one each.
  it("shares the auction status through one request-cached read", () => {
    expect(LAYOUT).not.toMatch(/prisma\.draft\./);
    expect(LAYOUT).toContain("getSeasonDraftStatus(season.id)");
    expect(QUERIES.match(/prisma\.draft\./g)).toHaveLength(1);
    expect(QUERIES).toMatch(/getSeasonDraftStatus = cache\(/);
  });
});

describe("homepage link preview query efficiency", () => {
  // generateMetadata runs on every Home render. It reuses the page's own
  // request-cached snapshot and match list instead of re-reading the draft,
  // the signup count or the champion.
  it("reuses Home's cached snapshot and match list", () => {
    expect(QUERIES).toMatch(/export const getSeasonSnapshot = cache\(/);
    expect(QUERIES).toMatch(/export const getSeasonMatches = cache\(/);
    expect(LINK_PREVIEW_METADATA).toContain("getSeasonSnapshot(user?.id)");
    expect(HOME).toContain("getSeasonSnapshot(user?.id)");
    expect(HOME).toContain("getSeasonMatches(season.id)");
    const home = LINK_PREVIEW_METADATA.slice(
      LINK_PREVIEW_METADATA.indexOf("export async function homeMetadata"),
      LINK_PREVIEW_METADATA.indexOf("export async function seasonPageMetadata"),
    );
    expect(home).toContain("getSeasonMatches(season.id)");
    expect(home).not.toMatch(/prisma\./);
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
