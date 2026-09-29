import { afterEach, describe, expect, it, vi } from "vitest";

// Create season unpins last season's pinned news: the posts published before
// that season's grand final was decided. Anything pinned after the final
// stays, and the toast names what was unpinned so it can be pinned again.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({ id: "test-admin", name: "Test administrator", role: "ADMIN", steamId: "76561198000000000", avatar: null })),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { createSeason } from "@/app/actions/admin-season";
import { unpinNewsBeforeFinal } from "@/lib/news-rollover";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS } from "@/lib/constants";
import { makeSeason, makeTeam } from "./factories";

afterEach(() => setRaceHook(null));

const at = (iso: string) => new Date(iso);
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function createForm(expectedActiveSeasonId: string): FormData {
  const f = new FormData();
  f.set("name", "Season 10");
  f.set("teamSize", "5");
  f.set("minTeams", "2");
  f.set("draftBudget", "100");
  f.set("expectedActiveSeasonId", expectedActiveSeasonId);
  return f;
}

/**
 * A complete season whose grand final kicked off at 18:00, ended (by its
 * games) at 19:30, and whose result was stored the next morning.
 */
async function finishedSeason({
  isActive = true,
  games = true,
}: { isActive?: boolean; games?: boolean } = {}) {
  const season = await makeSeason({ name: "Season 9", status: "PLAYOFFS" });
  const home = await makeTeam(season.id, "Alpha", 0);
  const away = await makeTeam(season.id, "Bravo", 1);
  const final = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 9,
      phase: MATCH_PHASE.FINAL,
      bracketSlot: "R2M0",
      homeTeamId: home.id,
      awayTeamId: away.id,
      status: MATCH_STATUS.COMPLETED,
      homeScore: 2,
      awayScore: 0,
      winnerTeamId: home.id,
      scheduledAt: at("2026-09-20T18:00:00Z"),
      completedAt: at("2026-09-21T09:00:00Z"),
    },
  });
  if (games) {
    await prisma.game.createMany({
      data: [
        {
          matchId: final.id,
          dotaMatchId: "8100000001",
          radiantWin: true,
          startTime: unix("2026-09-20T18:05:00Z"),
          durationSecs: 2400,
        },
        {
          matchId: final.id,
          dotaMatchId: "8100000002",
          radiantWin: true,
          startTime: unix("2026-09-20T19:00:00Z"),
          durationSecs: 1800,
        },
      ],
    });
  }
  return prisma.season.update({
    where: { id: season.id },
    data: { status: "COMPLETE", championTeamId: home.id, isActive },
  });
}

async function post(title: string, createdAt: string, pinned = true) {
  return prisma.newsPost.create({
    data: { title, body: `${title}.`, pinned, createdAt: at(createdAt) },
  });
}

async function pinnedTitles() {
  const rows = await prisma.newsPost.findMany({
    where: { pinned: true },
    orderBy: { createdAt: "asc" },
    select: { title: true },
  });
  return rows.map((row) => row.title);
}

describe("createSeason unpins last season's news", () => {
  it("unpins posts from before the final ended and names them", async () => {
    const old = await finishedSeason();
    await post("League rules", "2026-08-01T12:00:00Z");
    await post("Grand final this Sunday", "2026-09-17T12:00:00Z");
    // After the last game ended, before the result was stored: the games
    // date the final, so this one stays.
    await post("Congrats Alpha, signups soon", "2026-09-20T20:00:00Z");
    await post("An old unpinned post", "2026-09-01T12:00:00Z", false);

    const res = await createSeason({}, createForm(old.id));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe(
      "Created Season 10. Unpinned last season's news: “League rules” and “Grand final this Sunday”. Pin any of them again under League news if they still matter.",
    );
    expect(await pinnedTitles()).toEqual(["Congrats Alpha, signups soon"]);
    // Unpinned, never deleted: /news keeps every post.
    expect(await prisma.newsPost.count()).toBe(4);
    const log = await prisma.adminAction.findFirstOrThrow({
      where: { action: "createSeason" },
    });
    expect(log.summary).toMatch(
      /unpinned 2 news posts from before last season's final$/,
    );
  });

  it("uses the last archived season's final when opening from the offseason", async () => {
    await finishedSeason({ isActive: false, games: false });
    // No imported game: the stored result (the next morning) dates the final.
    await post("Grand final this Sunday", "2026-09-17T12:00:00Z");
    await post("Offseason inhouse nights", "2026-09-25T12:00:00Z");

    const res = await createSeason({}, createForm(""));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe(
      "Created Season 10. Unpinned last season's news: “Grand final this Sunday”. Pin it again under League news if it still matters.",
    );
    expect(await pinnedTitles()).toEqual(["Offseason inhouse nights"]);
  });

  it("unpins nothing after a season that never reached its final", async () => {
    await makeSeason({
      name: "Cancelled",
      status: "REGULAR_SEASON",
      isActive: false,
    });
    await post("Season cancelled", "2026-09-17T12:00:00Z");

    const res = await createSeason({}, createForm(""));

    expect(res).toEqual({ message: "Created Season 10" });
    expect(await pinnedTitles()).toEqual(["Season cancelled"]);
  });
});

describe("unpinNewsBeforeFinal", () => {
  it("names only the posts it unpinned itself", async () => {
    const old = await finishedSeason();
    const early = await post("Playoffs start Sunday", "2026-09-06T12:00:00Z");
    await post("Grand final this Sunday", "2026-09-17T12:00:00Z");
    let fired = false;
    // Another admin unpins one of them between the read and the write.
    setRaceHook(
      onceAt("news.unpinNewsBeforeFinal.beforeUnpin", async () => {
        fired = true;
        await prisma.newsPost.update({
          where: { id: early.id },
          data: { pinned: false },
        });
      }),
    );

    const unpinned = await unpinNewsBeforeFinal(old.id);

    expect(fired).toBe(true);
    expect(unpinned).toEqual(["Grand final this Sunday"]);
    expect(await pinnedTitles()).toEqual([]);
  });
});
