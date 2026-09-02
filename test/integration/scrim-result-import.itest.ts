import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import type { OpenDotaMatch, OpenDotaPlayer } from "@/lib/dota";
import {
  DOTA_MATCH_KIND,
  MATCH_PHASE,
  MATCH_STATUS,
  ROLE,
  SCRIM_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import {
  importScrimGame,
  removeScrimGame,
} from "@/lib/scrim-result-service";
import { importGameForMatch } from "@/lib/match-import";
import { makeCaptain, makeSeason, makeUser } from "./factories";

vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return { ...actual, fetchOpenDotaMatch: vi.fn() };
});

vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return { ...actual, claimProviderCooldown: vi.fn() };
});

import { fetchOpenDotaMatch } from "@/lib/dota";
import { claimProviderCooldown } from "@/lib/settings";

const DOTA_MATCH_ID = "8654321234";
const KICKOFF = new Date("2026-08-18T03:00:00.000Z");
const HOST_ACCOUNT_IDS = [111_001, 111_002, 111_003];
const AWAY_ACCOUNT_IDS = [222_001, 222_002, 222_003];

function player(
  accountId: number,
  playerSlot: number,
  isRadiant: boolean,
): OpenDotaPlayer {
  return {
    account_id: accountId,
    player_slot: playerSlot,
    isRadiant,
    hero_id: accountId % 100,
    kills: 4,
    deaths: 2,
    assists: 8,
  };
}

function fetchedScrimGame(): OpenDotaMatch {
  return {
    match_id: Number(DOTA_MATCH_ID),
    radiant_win: true,
    duration: 2_400,
    start_time: Math.floor((KICKOFF.getTime() + 30 * 60_000) / 1_000),
    radiant_score: 31,
    dire_score: 19,
    players: [
      ...HOST_ACCOUNT_IDS.map((accountId, index) =>
        player(accountId, index, true),
      ),
      player(333_001, 3, true),
      player(333_002, 4, true),
      ...AWAY_ACCOUNT_IDS.map((accountId, index) =>
        player(accountId, 128 + index, false),
      ),
      player(444_001, 131, false),
      player(444_002, 132, false),
    ],
  };
}

beforeEach(() => {
  vi.mocked(fetchOpenDotaMatch).mockReset();
  vi.mocked(claimProviderCooldown).mockReset();
  vi.mocked(fetchOpenDotaMatch).mockResolvedValue(fetchedScrimGame());
  vi.mocked(claimProviderCooldown).mockResolvedValue("claimed");
});

describe("scrim result ownership and competitive isolation", () => {
  it("records one player-ID-matched scrim without touching league or fantasy data", async () => {
    const season = await makeSeason({
      status: SEASON_STATUS.REGULAR_SEASON,
      teamSize: 3,
    });
    const host = await makeCaptain(season.id, "Scrim Host", 100, 0);
    const away = await makeCaptain(season.id, "Scrim Away", 100, 1);
    const fantasyManager = await makeUser("Fantasy Manager");
    const admin = await makeUser("Allowlisted Scrim Admin");

    const officialMatch = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: host.team.id,
        awayTeamId: away.team.id,
        bestOf: 1,
      },
    });
    const fantasyBefore = await prisma.fantasyRoster.create({
      data: {
        seasonId: season.id,
        userId: fantasyManager.id,
        picks: { create: { userId: host.user.id } },
      },
      include: { picks: true },
    });
    const scrim = await prisma.scrim.create({
      data: {
        seasonId: season.id,
        hostTeamId: host.team.id,
        opponentTeamId: away.team.id,
        createdById: host.user.id,
        scheduledAt: KICKOFF,
        bestOf: 1,
        status: SCRIM_STATUS.SCHEDULED,
        participants: {
          create: [
            ...HOST_ACCOUNT_IDS.map((dotaAccountId, index) => ({
              teamId: host.team.id,
              dotaAccountId,
              displayName: `Host player ${index + 1}`,
              guest: true,
              addedById: host.user.id,
            })),
            ...AWAY_ACCOUNT_IDS.map((dotaAccountId, index) => ({
              teamId: away.team.id,
              dotaAccountId,
              displayName: `Away player ${index + 1}`,
              guest: true,
              addedById: away.user.id,
            })),
          ],
        },
      },
    });

    const imported = await importScrimGame(
      { id: host.user.id, role: ROLE.USER },
      scrim.id,
      DOTA_MATCH_ID,
    );

    expect(imported).toMatchObject({
      ok: true,
      imported: 1,
      hostScore: 1,
      awayScore: 0,
      winnerTeamId: host.team.id,
      status: SCRIM_STATUS.COMPLETED,
    });

    const [
      storedScrim,
      scrimGame,
      claim,
      officialAfterScrim,
      leagueGameCount,
      seasonAfterScrim,
      fantasyAfterScrim,
    ] = await Promise.all([
      prisma.scrim.findUniqueOrThrow({ where: { id: scrim.id } }),
      prisma.scrimGame.findUniqueOrThrow({
        where: { dotaMatchId: DOTA_MATCH_ID },
      }),
      prisma.dotaMatchClaim.findUniqueOrThrow({
        where: { dotaMatchId: DOTA_MATCH_ID },
      }),
      prisma.match.findUniqueOrThrow({ where: { id: officialMatch.id } }),
      prisma.game.count(),
      prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
      prisma.fantasyRoster.findUniqueOrThrow({
        where: {
          seasonId_userId: {
            seasonId: season.id,
            userId: fantasyManager.id,
          },
        },
        include: { picks: true },
      }),
    ]);

    expect(storedScrim).toMatchObject({
      status: SCRIM_STATUS.COMPLETED,
      hostScore: 1,
      awayScore: 0,
      winnerTeamId: host.team.id,
    });
    expect(scrimGame).toMatchObject({
      scrimId: scrim.id,
      dotaMatchId: DOTA_MATCH_ID,
      radiantTeamId: host.team.id,
      direTeamId: away.team.id,
      winnerTeamId: host.team.id,
    });
    expect(claim).toMatchObject({
      kind: DOTA_MATCH_KIND.SCRIM,
      contextId: scrim.id,
    });
    expect(JSON.parse(scrimGame.players)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: HOST_ACCOUNT_IDS[0],
          teamId: host.team.id,
          userId: null,
          personaname: "Host player 1",
        }),
        expect.objectContaining({
          accountId: AWAY_ACCOUNT_IDS[0],
          teamId: away.team.id,
          userId: null,
        }),
      ]),
    );

    expect(leagueGameCount).toBe(0);
    expect(officialAfterScrim).toMatchObject({
      status: MATCH_STATUS.SCHEDULED,
      homeScore: 0,
      awayScore: 0,
      winnerTeamId: null,
      completedAt: null,
    });
    expect(seasonAfterScrim.fantasyLockedAt).toBeNull();
    expect(fantasyAfterScrim).toEqual(fantasyBefore);

    const officialAttempt = await importGameForMatch(
      officialMatch.id,
      DOTA_MATCH_ID,
      {
        expectedCaptainId: host.user.id,
        providerActorId: host.user.id,
      },
    );

    expect(officialAttempt).toEqual({
      ok: false,
      error: "That game is already recorded as a scrim",
    });
    expect(fetchOpenDotaMatch).toHaveBeenCalledTimes(1);
    expect(claimProviderCooldown).toHaveBeenCalledTimes(1);
    expect(await prisma.game.count()).toBe(0);
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: officialMatch.id } }),
    ).toEqual(officialAfterScrim);

    const previousAdminSteamIds = process.env.ADMIN_STEAM_IDS;
    process.env.ADMIN_STEAM_IDS = admin.steamId;
    const corrected = await (async () => {
      try {
        return await removeScrimGame(
          { id: admin.id, role: ROLE.ADMIN },
          scrim.id,
          scrimGame.id,
        );
      } finally {
        if (previousAdminSteamIds === undefined) {
          delete process.env.ADMIN_STEAM_IDS;
        } else {
          process.env.ADMIN_STEAM_IDS = previousAdminSteamIds;
        }
      }
    })();
    expect(corrected).toMatchObject({
      ok: true,
      hostScore: 0,
      awayScore: 0,
      winnerTeamId: null,
      status: SCRIM_STATUS.SCHEDULED,
    });
    expect(await prisma.scrimGame.count()).toBe(0);
    expect(
      await prisma.dotaMatchClaim.findUnique({
        where: { dotaMatchId: DOTA_MATCH_ID },
      }),
    ).toBeNull();
    expect(
      await prisma.scrim.findUniqueOrThrow({ where: { id: scrim.id } }),
    ).toMatchObject({
      status: SCRIM_STATUS.SCHEDULED,
      hostScore: 0,
      awayScore: 0,
      winnerTeamId: null,
    });
    expect(
      JSON.parse(
        (await prisma.setting.findUniqueOrThrow({
          where: { key: `importSkip:${season.id}` },
        })).value,
      ),
    ).toContain(DOTA_MATCH_ID);
  });
});
