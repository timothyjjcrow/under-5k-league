import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The picture bodies over stand-in reads and drawing: what is drawn, what is
// kept, and what each request gets. The cache's own rules are in
// src/lib/picture-cache.test.ts.
const reads = vi.hoisted(() => ({
  loadMatchCard: vi.fn(),
  loadTeamCard: vi.fn(),
  loadPlayerCard: vi.fn(),
  loadSeasonCard: vi.fn(),
  loadInhouseNightCard: vi.fn(),
}));
const draws = vi.hoisted(() => ({ drawOgImage: vi.fn() }));

vi.mock("@/lib/link-preview-images", () => reads);
vi.mock("@/lib/og-assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/og-assets")>()),
  drawOgImage: draws.drawOgImage,
  loadLeagueEmblem: async () => null,
}));

import {
  inhouseShareImage,
  matchShareImage,
  playerShareImage,
  teamShareImage,
} from "./og-share-images";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MATCH_CARD = {
  seasonName: "Season 9",
  round: "Week 4",
  grandFinal: false,
  home: { name: "Radiant Raccoons", hue: 200, logo: null },
  away: { name: "Dire Ducks", hue: 20, logo: null },
  score: null,
  winner: null,
  status: { tone: "upcoming", text: "Sun, Oct 18 · Best of 3" },
};

async function bytes(res: Response): Promise<number[]> {
  return [...new Uint8Array(await res.arrayBuffer())];
}

beforeEach(() => {
  delete (globalThis as { ggd2lSharePictures?: unknown }).ggd2lSharePictures;
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  vi.stubEnv("NODE_ENV", "production");
  draws.drawOgImage.mockImplementation(async () => PNG.slice().buffer);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const mock of [...Object.values(reads), draws.drawOgImage]) mock.mockReset();
});

describe("link preview pictures in production", () => {
  it("draw a page's picture once for its opengraph-image and twitter-image", async () => {
    reads.loadMatchCard.mockResolvedValue(MATCH_CARD);
    // Discord's and X's fetches of one link arrive together.
    const [og, twitter] = await Promise.all([matchShareImage("m1"), matchShareImage("m1")]);
    const again = await matchShareImage("m1");
    for (const res of [og, twitter, again]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toMatch(/max-age=300/);
      expect(await bytes(res)).toEqual([...PNG]);
    }
    expect(reads.loadMatchCard).toHaveBeenCalledTimes(1);
    expect(draws.drawOgImage).toHaveBeenCalledTimes(1);
    // Another match, or a team with the same id, is its own picture.
    reads.loadTeamCard.mockResolvedValue({
      seasonName: "Season 9",
      team: MATCH_CARD.home,
      facts: [],
      goldFact: null,
      captain: "Raccoon King",
      roster: [],
    });
    await matchShareImage("m2");
    await teamShareImage("m1");
    expect(reads.loadMatchCard).toHaveBeenCalledTimes(2);
    expect(reads.loadTeamCard).toHaveBeenCalledTimes(1);
    expect(draws.drawOgImage).toHaveBeenCalledTimes(3);
  });

  it("draw again after five minutes, and say how old a kept picture is", async () => {
    reads.loadMatchCard.mockResolvedValue(MATCH_CARD);
    await matchShareImage("m1");
    vi.advanceTimersByTime(4 * 60_000 + 30_000);
    const kept = await matchShareImage("m1");
    expect(kept.headers.get("age")).toBe("270");
    expect(draws.drawOgImage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    const redrawn = await matchShareImage("m1");
    expect(redrawn.headers.get("age")).toBe("0");
    expect(draws.drawOgImage).toHaveBeenCalledTimes(2);
  });

  it("keep no 404, no league picture and no failure", async () => {
    // No such page: a 404 every time, so a page made later gets its picture.
    reads.loadMatchCard.mockResolvedValue(null);
    expect((await matchShareImage("new")).status).toBe(404);
    reads.loadMatchCard.mockResolvedValue(MATCH_CARD);
    expect((await matchShareImage("new")).status).toBe(200);

    // An account that only signed in keeps the league's picture until it joins.
    reads.loadPlayerCard.mockResolvedValue("unjoined");
    expect((await playerShareImage("p1")).status).toBe(307);
    expect((await playerShareImage("p1")).status).toBe(307);
    expect(reads.loadPlayerCard).toHaveBeenCalledTimes(2);

    // A read that throws sends the league's picture and is tried again.
    reads.loadInhouseNightCard.mockRejectedValueOnce(new Error("database unreachable"));
    expect((await inhouseShareImage()).status).toBe(307);
    reads.loadInhouseNightCard.mockResolvedValue(null);
    expect((await inhouseShareImage()).status).toBe(307);
    expect(reads.loadInhouseNightCard).toHaveBeenCalledTimes(2);

    // A drawing that fails sends the league's picture and is tried again.
    reads.loadTeamCard.mockResolvedValue({
      seasonName: "Season 9",
      team: MATCH_CARD.home,
      facts: [],
      goldFact: null,
      captain: "Raccoon King",
      roster: [],
    });
    draws.drawOgImage.mockResolvedValueOnce(null);
    const failed = await teamShareImage("t1");
    expect(failed.status).toBe(307);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    const drawn = await teamShareImage("t1");
    expect(drawn.status).toBe(200);
    expect(await teamShareImage("t1")).toHaveProperty("status", 200);
    expect(reads.loadTeamCard).toHaveBeenCalledTimes(2);
  });
});

describe("link preview pictures in development", () => {
  it("draw on every request, so a layout edit shows at once", async () => {
    vi.stubEnv("NODE_ENV", "development");
    reads.loadMatchCard.mockResolvedValue(MATCH_CARD);
    await matchShareImage("m1");
    await matchShareImage("m1");
    expect(draws.drawOgImage).toHaveBeenCalledTimes(2);
  });
});
