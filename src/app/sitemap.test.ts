import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  content: { hasGames: true, hasChampion: true },
  season: { status: "COMPLETE" } as { status: string } | null,
}));
vi.mock("@/lib/public-navigation", () => ({
  getPublicLeagueContent: async () => mocks.content,
}));
vi.mock("@/lib/season", () => ({
  getActiveSeason: async () => mocks.season,
}));

import sitemap from "./sitemap";

beforeEach(() => {
  mocks.content = { hasGames: true, hasChampion: true };
  mocks.season = { status: "COMPLETE" };
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://league.example");
  vi.stubEnv("VERCEL_URL", "");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
});
afterEach(() => vi.unstubAllEnvs());

const urls = async () => (await sitemap()).map((entry) => entry.url);

describe("public sitemap", () => {
  it("includes public statistics, content, archive, and discovery surfaces", async () => {
    const listed = await urls();
    for (const path of [
      "/leaders",
      "/meta",
      "/records",
      "/players/compare",
      "/news",
      "/features",
      "/hall-of-fame",
      "/seasons",
      "/recap",
      "/inhouse/history",
      "/scrims",
    ]) {
      expect(listed).toContain(`https://league.example${path}`);
    }
    expect(listed).not.toContain("https://league.example/privacy");
    expect(listed).not.toContain("https://league.example/terms");
    expect(new Set(listed).size).toBe(listed.length);
  });

  // A league with no games yet (a new region) would otherwise ask search
  // engines to index a row of "No stats yet" pages.
  it("leaves out pages that have nothing to show yet", async () => {
    mocks.content = { hasGames: false, hasChampion: false };
    mocks.season = { status: "SIGNUPS" };
    const listed = await urls();
    for (const path of [
      "/leaders",
      "/meta",
      "/records",
      "/players/compare",
      "/hall-of-fame",
      "/recap",
    ]) {
      expect(listed).not.toContain(`https://league.example${path}`);
    }
    for (const path of ["", "/players", "/news", "/seasons", "/inhouse"]) {
      expect(listed).toContain(`https://league.example${path}`);
    }

    // Games alone bring the statistics pages; the Hall of Fame waits for a
    // champion, and the recap for the season's end.
    mocks.content = { hasGames: true, hasChampion: false };
    mocks.season = { status: "PLAYOFFS" };
    const midSeason = await urls();
    expect(midSeason).toContain("https://league.example/records");
    expect(midSeason).not.toContain("https://league.example/hall-of-fame");
    expect(midSeason).not.toContain("https://league.example/recap");

    mocks.season = null;
    expect(await urls()).not.toContain("https://league.example/recap");
  });

  it("does not invent a last-modified date for static route entries", async () => {
    expect((await sitemap()).every((entry) => entry.lastModified == null)).toBe(
      true,
    );
  });

  it("does not produce double slashes from a trailing-slash site override", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://league.example/");
    expect(
      (await sitemap()).every((entry) => !entry.url.includes("example//")),
    ).toBe(true);
  });
});
