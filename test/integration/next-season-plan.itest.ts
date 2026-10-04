import { describe, expect, it, vi } from "vitest";

// The next season's signup date on Home's Season complete hero: an admin sets
// and clears it on the Season handoff card. It is refused outside Season
// complete and against a stale page, and the handoff makes it lapse.
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

import {
  clearNextSeasonDate,
  createSeason,
  setNextSeasonDate,
} from "@/app/actions/admin-season";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { parseNextSeasonPlan } from "@/lib/next-season";
import { prisma } from "@/lib/prisma";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { makeSeason, makeTeam } from "./factories";

const DAY = 24 * 60 * 60 * 1000;

function dateForm(seasonId: string, whenMs: number | null): FormData {
  const f = new FormData();
  f.set("expectedActiveSeasonId", seasonId);
  // What <LocalDatetimeField> posts: the raw box and the browser's epoch.
  f.set("nextSignupsAt", whenMs == null ? "" : "2026-10-17T18:00");
  f.set("nextSignupsAtTs", whenMs == null ? "" : String(whenMs));
  return f;
}

/** A crowned season: Alpha won its grand final 2–0. */
async function crownedSeason() {
  const season = await makeSeason({ name: "Season 9", status: "PLAYOFFS" });
  const home = await makeTeam(season.id, "Alpha", 0);
  const away = await makeTeam(season.id, "Bravo", 1);
  await prisma.match.create({
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
      completedAt: new Date(),
    },
  });
  return prisma.season.update({
    where: { id: season.id },
    data: { status: SEASON_STATUS.COMPLETE, championTeamId: home.id },
  });
}

async function storedPlan(activeSeasonId: string) {
  return parseNextSeasonPlan(
    await getSetting(SETTING_KEYS.NEXT_SEASON_PLAN),
    activeSeasonId,
  );
}

describe("the next season's date", () => {
  it("is saved for the complete season, logged, and cleared again", async () => {
    const season = await crownedSeason();
    const when = Date.now() + 14 * DAY;

    const set = await setNextSeasonDate({}, dateForm(season.id, when));
    expect(set?.error).toBeUndefined();
    expect(set?.message).toMatch(/^Home now says the next season's signups open /);
    expect(await storedPlan(season.id)).toEqual({
      seasonId: season.id,
      signupsAtMs: when,
    });

    const cleared = await clearNextSeasonDate({}, new FormData());
    expect(cleared?.error).toBeUndefined();
    expect(await getSetting(SETTING_KEYS.NEXT_SEASON_PLAN)).toBeNull();

    const log = await prisma.adminAction.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { action: true, seasonId: true },
    });
    expect(log).toEqual([
      { action: "setNextSeasonDate", seasonId: season.id },
      { action: "clearNextSeasonDate", seasonId: season.id },
    ]);
  });

  it("is refused before the season is complete", async () => {
    for (const status of [
      SEASON_STATUS.SIGNUPS,
      SEASON_STATUS.REGULAR_SEASON,
      SEASON_STATUS.PLAYOFFS,
    ]) {
      await prisma.season.deleteMany();
      const season = await makeSeason({ status });
      const res = await setNextSeasonDate(
        {},
        dateForm(season.id, Date.now() + 7 * DAY),
      );
      expect(res?.error, status).toMatch(/once this season is complete/);
      expect(await getSetting(SETTING_KEYS.NEXT_SEASON_PLAN)).toBeNull();
    }
  });

  it("is refused from a page rendered for another season, or with no season", async () => {
    const season = await crownedSeason();
    const stale = await setNextSeasonDate(
      {},
      dateForm("some-other-season", Date.now() + 7 * DAY),
    );
    expect(stale?.error).toMatch(/active season changed/);

    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });
    const none = await setNextSeasonDate(
      {},
      dateForm(season.id, Date.now() + 7 * DAY),
    );
    expect(none?.error).toMatch(/active season changed/);
    expect(await getSetting(SETTING_KEYS.NEXT_SEASON_PLAN)).toBeNull();
  });

  it("refuses a missing, past or far-off date and keeps the saved one", async () => {
    const season = await crownedSeason();
    const saved = Date.now() + 10 * DAY;
    await setNextSeasonDate({}, dateForm(season.id, saved));

    const missing = await setNextSeasonDate({}, dateForm(season.id, null));
    expect(missing?.error).toMatch(/Pick the date/);
    const past = await setNextSeasonDate(
      {},
      dateForm(season.id, Date.now() - DAY),
    );
    expect(past?.error).toMatch(/future/);
    const farOff = await setNextSeasonDate(
      {},
      dateForm(season.id, Date.now() + 400 * DAY),
    );
    expect(farOff?.error).toMatch(/within the next year/);

    expect((await storedPlan(season.id))?.signupsAtMs).toBe(saved);
  });

  it("lapses when the handoff opens the next season", async () => {
    const season = await crownedSeason();
    await setNextSeasonDate({}, dateForm(season.id, Date.now() + 7 * DAY));

    const f = new FormData();
    f.set("name", "Season 10");
    f.set("expectedActiveSeasonId", season.id);
    const opened = await createSeason({}, f);
    expect(opened?.error).toBeUndefined();

    const next = await prisma.season.findFirstOrThrow({
      where: { isActive: true },
    });
    expect(next.id).not.toBe(season.id);
    // The row is still there; it names the old season, so nothing shows it.
    expect(await getSetting(SETTING_KEYS.NEXT_SEASON_PLAN)).not.toBeNull();
    expect(await storedPlan(next.id)).toBeNull();
  });
});
