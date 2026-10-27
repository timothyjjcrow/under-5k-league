import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { INHOUSE_STATUS, SEASON_STATUS } from "@/lib/constants";
import { fetchCareerFacts } from "@/lib/cached-queries";
import {
  DRAFT_SCOUT_TTL_MS,
  loadDraftScoutInfo,
} from "@/lib/draft-scout-service";
import { resetInhouseLadderCache } from "@/lib/inhouse-ladder";
import { summarizePubMatches } from "@/lib/pub-scout";
import { __clearShortLivedMemosForTests } from "@/lib/short-lived-memo";
import { makeCaptain, makePlayer, makeSeason, makeUser } from "./factories";

// The draft room's scouting map, read the way the /draft render reads it.
// Outside a Next request the career facts can't use their cache, so the test
// passes the uncached read through the loader's seam (the pool-history
// precedent).
const readFacts = async () => (await fetchCareerFacts()).appearances;

const NOW_MS = Date.UTC(2026, 9, 24, 18);
const NOW = Math.floor(NOW_MS / 1000);

const pubStats = () =>
  JSON.stringify({
    recentWins: 12,
    recentLosses: 8,
    totalGames: 900,
    lastPlayedAt: NOW - 86_400,
    topHeroes: [{ heroId: 26, games: 40, wins: 22 }],
    scout: summarizePubMatches(
      Array.from({ length: 20 }, (_, i) => ({
        hero_id: 26,
        player_slot: 1,
        radiant_win: i % 3 !== 0,
        kills: 2,
        deaths: 6,
        assists: 14,
        gold_per_min: 300,
        last_hits: 60,
        duration: 40 * 60,
        game_mode: 22,
        lobby_type: 7,
        party_size: 1,
        average_rank: 63,
        cluster: 122,
        leaver_status: 0,
        start_time: NOW - 86_400 - i * 3_600,
        lane_role: null,
        is_roaming: false,
      })),
    ),
  });

async function givePubStats(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { pubStats: pubStats(), pubStatsAt: new Date(NOW_MS - 86_400_000) },
  });
}

async function seedLobby(userIds: string[], createdAt: Date) {
  await prisma.inhouseLobby.create({
    data: {
      status: INHOUSE_STATUS.COMPLETED,
      winnerTeam: 1,
      createdAt,
      players: {
        create: userIds.map((userId, i) => ({
          userId,
          team: i % 2 === 0 ? 1 : 2,
          mmr: 3000,
        })),
      },
    },
  });
}

describe("loadDraftScoutInfo", () => {
  beforeEach(() => {
    __clearShortLivedMemosForTests();
    resetInhouseLadderCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function league() {
    const past = await prisma.season.create({
      data: {
        name: "Season 1",
        createdAt: new Date("2026-01-01"),
        status: SEASON_STATUS.COMPLETE,
        isActive: false,
      },
    });
    const season = await makeSeason({
      name: "Season 2",
      status: SEASON_STATUS.DRAFT,
    });
    const scouted = await makePlayer(season.id, "Scouted", 3200, {
      roles: "4,5",
    });
    await givePubStats(scouted.id);
    await prisma.registration.update({
      where: { seasonId_userId: { seasonId: season.id, userId: scouted.id } },
      data: { captainNote: "Pos 5, any night.", favoriteHeroes: "Lion" },
    });
    const bare = await makePlayer(season.id, "Bare", 2800);
    await prisma.registration.update({
      where: { seasonId_userId: { seasonId: season.id, userId: bare.id } },
      data: { captainNote: "New here." },
    });
    // A captain, someone who withdrew and a standin: none can be nominated.
    const { user: captain, team } = await makeCaptain(season.id, "Cap", 100, 0);
    await givePubStats(captain.id);
    const gone = await makePlayer(season.id, "Gone", 3000);
    await givePubStats(gone.id);
    await prisma.registration.update({
      where: { seasonId_userId: { seasonId: season.id, userId: gone.id } },
      data: { status: "WITHDRAWN" },
    });
    const standin = await makeUser("Standin");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: standin.id,
        type: "STANDIN",
        status: "ACTIVE",
        mmr: 3000,
      },
    });
    // A player already sold stays in the map: Undo can return them.
    const sold = await makePlayer(season.id, "Sold", 3100);
    await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: team.id,
        userId: sold.id,
        isCaptain: false,
        price: 9,
      },
    });
    // Scouted played last season, and five inhouses.
    const oldTeam = await prisma.team.create({
      data: {
        seasonId: past.id,
        name: "Dire Straits",
        captainId: captain.id,
        budget: 100,
        draftOrder: 0,
      },
    });
    await prisma.teamMember.create({
      data: {
        seasonId: past.id,
        teamId: oldTeam.id,
        userId: scouted.id,
        isCaptain: false,
        price: 12,
      },
    });
    const others = await Promise.all(
      Array.from({ length: 9 }, (_, i) => makeUser(`Inhouser ${i}`)),
    );
    for (let g = 0; g < 2; g++) {
      await seedLobby(
        [scouted.id, ...others.map((u) => u.id)],
        new Date(NOW_MS - (g + 1) * 3_600_000),
      );
    }
    return { season, scouted, bare, sold, captain, gone, standin };
  }

  it("covers every nominable signup, with what is on file for each", async () => {
    const { season, scouted, bare, sold } = await league();
    const info = await loadDraftScoutInfo(season, { nowMs: NOW_MS, readFacts });
    expect(info).not.toBeNull();
    expect(Object.keys(info!).sort()).toEqual(
      [scouted.id, bare.id, sold.id].sort(),
    );
    const s = info![scouted.id];
    expect(s.pub?.recentWins).toBe(12);
    expect(s.pub?.scout?.games).toBe(20);
    expect(s.pub).not.toHaveProperty("totalGames");
    expect(s.inhouse?.games).toBe(2);
    expect(s.lastSeason).toMatchObject({
      seasonName: "Season 1",
      teamName: "Dire Straits",
      price: 12,
    });
    expect(s.favoriteHeroes).toBe("Lion");
    expect(s.about).toBe("Pos 5, any night.");
    expect(info![bare.id]).toEqual({ about: "New here." });
    expect(info![sold.id]).toEqual({});
  });

  it("keeps one map per season for the TTL, then reads afresh", async () => {
    const { season, bare } = await league();
    const first = await loadDraftScoutInfo(season, { nowMs: NOW_MS, readFacts });
    await prisma.registration.update({
      where: { seasonId_userId: { seasonId: season.id, userId: bare.id } },
      data: { captainNote: "Edited." },
    });
    const cached = await loadDraftScoutInfo(season, {
      nowMs: NOW_MS + DRAFT_SCOUT_TTL_MS - 1,
      readFacts,
    });
    expect(cached).toBe(first);
    const fresh = await loadDraftScoutInfo(season, {
      nowMs: NOW_MS + DRAFT_SCOUT_TTL_MS,
      readFacts,
    });
    expect(fresh![bare.id].about).toBe("Edited.");
  });

  it("returns null on a failed read, logs a fixed code, and keeps no failure", async () => {
    const { season } = await league();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma.registration, "findMany").mockRejectedValueOnce(
      new Error("postgres://user:secret@db/ggd2l connection reset"),
    );
    expect(
      await loadDraftScoutInfo(season, { nowMs: NOW_MS, readFacts }),
    ).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[draft-scout] read unavailable");
    const next = await loadDraftScoutInfo(season, { nowMs: NOW_MS, readFacts });
    expect(next).not.toBeNull();
  });
});
