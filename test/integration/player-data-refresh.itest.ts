/**
 * The automation worker's hourly player data refresh: medals, scouting stats,
 * Steam names and report-card backfill without an admin pressing anything,
 * kept below result sync and backing off when OpenDota refuses a call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchRankTier: vi.fn(),
  fetchPubStats: vi.fn(),
  fetchOpenDotaMatch: vi.fn(),
}));
vi.mock("@/lib/steam", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/steam")>()),
  fetchSteamProfiles: vi.fn(async () => new Map()),
}));

import { prisma } from "@/lib/prisma";
import { effectiveDotaAccountId } from "@/lib/dota-account";
import { fetchOpenDotaMatch, fetchPubStats, fetchRankTier } from "@/lib/dota";
import { fetchSteamProfiles } from "@/lib/steam";
import {
  PLAYER_DATA_REFRESH_ACCOUNTS,
  refreshPlayerDataAutomatically,
} from "@/lib/player-data-refresh";
import { runResultSync } from "@/lib/result-sync-service";
import { SETTING_KEYS, getSetting, setSetting } from "@/lib/settings";
import { DRAFT_STATUS, MATCH_PHASE, SEASON_STATUS } from "@/lib/constants";
import type { PubStats } from "@/lib/pub-stats";
import { makePlayer, makeSeason, makeTeam, makeUser } from "./factories";

const PUB: PubStats = {
  recentWins: 6,
  recentLosses: 4,
  totalGames: 900,
  lastPlayedAt: 1_722_000_000,
  topHeroes: [{ heroId: 14, games: 50, wins: 30 }],
};

const rank = vi.mocked(fetchRankTier);
const pub = vi.mocked(fetchPubStats);
const steam = vi.mocked(fetchSteamProfiles);
const match = vi.mocked(fetchOpenDotaMatch);
const steamKey = process.env.STEAM_API_KEY;

beforeEach(() => {
  delete process.env.STEAM_API_KEY;
  rank.mockReset();
  rank.mockResolvedValue({ ok: true, rankTier: 55, fhUnavailable: false });
  pub.mockReset();
  pub.mockResolvedValue({ ok: true, stats: PUB });
  steam.mockReset();
  steam.mockResolvedValue(new Map());
  match.mockReset();
  match.mockResolvedValue(null);
});
afterEach(() => {
  if (steamKey === undefined) delete process.env.STEAM_API_KEY;
  else process.env.STEAM_API_KEY = steamKey;
});

async function refreshedIds() {
  return (
    await prisma.user.findMany({
      where: { pubStatsAt: { not: null } },
      select: { id: true },
    })
  ).map((u) => u.id);
}

/** Pretend the last pass ran `hoursAgo` hours ago. */
async function lastPassAgo(hoursAgo: number) {
  await setSetting(
    SETTING_KEYS.PLAYER_DATA_REFRESH_AT,
    new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  );
}

describe("the hourly player data refresh", () => {
  it("refreshes the stalest few accounts, this season's signups first", async () => {
    const season = await makeSeason();
    const signupA = await makePlayer(season.id, "Signup A", 3000);
    const signupB = await makePlayer(season.id, "Signup B", 3000);
    for (let i = 0; i < 4; i++) await makeUser(`Outsider ${i}`);

    const out = await refreshPlayerDataAutomatically();

    expect(out).toMatchObject({
      ran: true,
      accounts: PLAYER_DATA_REFRESH_ACCOUNTS,
      backedOff: false,
    });
    const refreshed = await refreshedIds();
    expect(refreshed).toHaveLength(PLAYER_DATA_REFRESH_ACCOUNTS);
    expect(refreshed).toEqual(expect.arrayContaining([signupA.id, signupB.id]));
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: signupA.id } }),
    ).toMatchObject({ rankTier: 55, pubStats: JSON.stringify(PUB) });
  });

  it("backfills a medal for someone who never signed up", async () => {
    const outsider = await makeUser("Never Signed Up");

    await refreshPlayerDataAutomatically();

    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: outsider.id } }))
        .rankTier,
    ).toBe(55);
  });

  it("runs about once an hour, and skips accounts checked this week", async () => {
    await makeUser("Checked");
    expect((await refreshPlayerDataAutomatically()).ran).toBe(true);
    expect(rank).toHaveBeenCalledTimes(1);

    expect((await refreshPlayerDataAutomatically()).ran).toBe(false);
    await lastPassAgo(1);
    expect(await refreshPlayerDataAutomatically()).toMatchObject({
      ran: true,
      accounts: 0,
    });
    expect(rank).toHaveBeenCalledTimes(1);
  });

  it("stops at the first call OpenDota refuses and waits longer before the next pass", async () => {
    const users = [];
    for (let i = 0; i < 3; i++) users.push(await makeUser(`Player ${i}`));
    // A rate limit: both of the first account's calls are refused.
    rank.mockResolvedValueOnce({ ok: false, rankTier: null, fhUnavailable: null });
    pub.mockResolvedValueOnce({ ok: false, stats: null });

    const out = await refreshPlayerDataAutomatically();

    expect(out).toMatchObject({ ran: true, accounts: 0, backedOff: true });
    expect(rank).toHaveBeenCalledTimes(1);
    const failedAccount = rank.mock.calls[0][0];
    const failed = users.find((u) => effectiveDotaAccountId(u) === failedAccount);
    expect(await getSetting(SETTING_KEYS.PLAYER_DATA_REFRESH_FAILED_USER)).toBe(
      failed?.id,
    );
    expect((await refreshPlayerDataAutomatically()).ran).toBe(false);

    // ...and once it has passed, the refused account goes last.
    await lastPassAgo(1);
    rank.mockClear();
    expect((await refreshPlayerDataAutomatically()).accounts).toBe(3);
    expect(rank.mock.calls.at(-1)?.[0]).toBe(failedAccount);
  });

  it("writes a future timestamp as its back-off", async () => {
    await makeUser("Refused");
    pub.mockResolvedValueOnce({ ok: false, stats: null });
    const before = Date.now();

    await refreshPlayerDataAutomatically();

    const stamp = await getSetting(SETTING_KEYS.PLAYER_DATA_REFRESH_AT);
    expect(new Date(stamp ?? 0).getTime()).toBeGreaterThan(before + 3_600_000);
  });

  it("leaves medals and names alone while an auction is live", async () => {
    process.env.STEAM_API_KEY = "test-key";
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.PAUSED },
    });
    await makePlayer(season.id, "In The Pool", 3000);

    const out = await refreshPlayerDataAutomatically();

    expect(out).toMatchObject({ ran: true, accounts: 0, steamProfiles: 0 });
    expect(rank).not.toHaveBeenCalled();
    expect(steam).not.toHaveBeenCalled();
  });

  it("updates Steam names and avatars, writing only what changed", async () => {
    process.env.STEAM_API_KEY = "test-key";
    const renamed = await makeUser("Old Name");
    const same = await makeUser("Same Name");
    await prisma.user.updateMany({ data: { pubStatsAt: new Date() } });
    steam.mockResolvedValue(
      new Map([
        [
          renamed.steamId,
          { name: "New Name", avatar: "https://a.example/new.png", profileUrl: null },
        ],
        [same.steamId, { name: "Same Name", avatar: null, profileUrl: null }],
      ]),
    );

    const out = await refreshPlayerDataAutomatically();

    expect(out.steamProfiles).toBe(1);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: renamed.id } }),
    ).toMatchObject({ name: "New Name", avatar: "https://a.example/new.png" });
  });

  it("gives a few older games report-card stats and stops at one OpenDota refuses", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const fixture = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: home.id,
        awayTeamId: away.id,
      },
    });
    const line = { accountId: 111, heroId: 7, isRadiant: true, kills: 1 };
    for (const [i, id] of ["9101", "9102", "9103"].entries()) {
      await prisma.game.create({
        data: {
          matchId: fixture.id,
          dotaMatchId: id,
          radiantWin: true,
          winnerTeamId: home.id,
          players: JSON.stringify([line]),
          fetchedAt: new Date(Date.now() - (10 - i) * 60_000),
        },
      });
    }
    // Every account is fresh, so the pass goes straight to the games.
    await prisma.user.updateMany({ data: { pubStatsAt: new Date() } });
    match.mockResolvedValueOnce({
      match_id: 9101,
      radiant_win: true,
      duration: 2000,
      start_time: 1,
      players: [
        {
          account_id: 111,
          player_slot: 0,
          hero_id: 7,
          isRadiant: true,
          kills: 1,
          deaths: 0,
          assists: 0,
          xp_per_min: 500,
        },
      ],
    });

    const out = await refreshPlayerDataAutomatically();

    expect(out).toMatchObject({ ran: true, games: 1, backedOff: true });
    expect(match).toHaveBeenCalledTimes(2);
    const enriched = await prisma.game.findFirstOrThrow({
      where: { dotaMatchId: "9101" },
    });
    expect(JSON.parse(enriched.players)[0]).toMatchObject({ xpm: 500 });
  });

  it("marks a game OpenDota no longer has as done instead of backing off every pass", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const fixture = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: home.id,
        awayTeamId: away.id,
      },
    });
    const line = { accountId: 111, heroId: 7, isRadiant: true, kills: 1 };
    await prisma.game.create({
      data: {
        matchId: fixture.id,
        dotaMatchId: "9201",
        radiantWin: true,
        winnerTeamId: home.id,
        players: JSON.stringify([line]),
      },
    });
    await prisma.user.updateMany({ data: { pubStatsAt: new Date() } });
    // OpenDota answers 404: it has aged the game out.
    match.mockImplementation(async (_id, _o, report) => {
      if (report) report.missing = true;
      return null;
    });
    const before = Date.now();

    const out = await refreshPlayerDataAutomatically();

    expect(out).toMatchObject({ ran: true, games: 0, backedOff: false });
    const stamp = await getSetting(SETTING_KEYS.PLAYER_DATA_REFRESH_AT);
    expect(new Date(stamp ?? 0).getTime()).toBeLessThan(before + 60_000);
    // The next pass has nothing left to fetch.
    await lastPassAgo(1);
    match.mockClear();
    await refreshPlayerDataAutomatically();
    expect(match).not.toHaveBeenCalled();
  });
});

describe("the worker runs the refresh last, and only when result sync is idle", () => {
  it("is off for direct result sync calls", async () => {
    await makeUser("Stale");
    await runResultSync();
    expect(rank).not.toHaveBeenCalled();
  });

  it("waits while result sync is watching a filling inhouse queue", async () => {
    const queued = await makeUser("Queued");
    await prisma.inhouseQueueEntry.create({
      data: { userId: queued.id, mmr: 3000, lastSeenAt: new Date() },
    });

    const out = await runResultSync({ refreshPlayerData: true });

    expect(out.watch).toBe(true);
    expect(rank).not.toHaveBeenCalled();
    // Not claimed, so the next idle run can take it.
    expect(await getSetting(SETTING_KEYS.PLAYER_DATA_REFRESH_AT)).toBeNull();

    await prisma.inhouseQueueEntry.deleteMany();
    const idle = await runResultSync({ refreshPlayerData: true });
    expect(idle.issues).toEqual([]);
    expect(idle.skipped).toEqual([]);
    expect(rank).toHaveBeenCalledTimes(1);
  });

  it("a refused OpenDota call is not a degraded run", async () => {
    await makeUser("Rate Limited");
    rank.mockResolvedValue({ ok: false, rankTier: null, fhUnavailable: null });

    const out = await runResultSync({ refreshPlayerData: true });

    expect(out.issues).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(rank).toHaveBeenCalledTimes(1);
  });
});
