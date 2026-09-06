import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  recordResult,
  reinstateTeam,
  removeGame,
  reopenMatch,
  withdrawTeam,
} from "@/app/actions/admin";
import { matchResultLockReason } from "@/lib/league-lifecycle";
import { makeSeason, makeTeam } from "./factories";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function setup() {
  const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
  const home = await makeTeam(season.id, "Home", 1);
  const away = await makeTeam(season.id, "Away", 2);
  const common = {
    seasonId: season.id,
    homeTeamId: home.id,
    awayTeamId: away.id,
  };
  const regular = await prisma.match.create({
    data: {
      ...common,
      phase: MATCH_PHASE.REGULAR,
      week: 1,
      bestOf: 2,
      homeScore: 1,
      awayScore: 1,
      status: MATCH_STATUS.COMPLETED,
    },
  });
  const tiebreaker = await prisma.match.create({
    data: {
      ...common,
      phase: MATCH_PHASE.TIEBREAKER,
      bracketSlot: "TB:test:1",
      week: 2,
      bestOf: 3,
    },
  });
  return { season, home, away, regular, tiebreaker };
}

describe("tiebreaker result lifecycle", () => {
  it("records a BO3 winner without starting or advancing the playoffs", async () => {
    const { season, home, tiebreaker } = await setup();
    const result = await recordResult({}, form({
      matchId: tiebreaker.id,
      expectedActiveSeasonId: season.id,
      homeScore: "2",
      awayScore: "1",
    }));
    expect(result?.error).toBeUndefined();
    expect(await prisma.match.findUniqueOrThrow({ where: { id: tiebreaker.id } }))
      .toMatchObject({ status: MATCH_STATUS.COMPLETED, winnerTeamId: home.id });
    expect(await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
      .toMatchObject({ status: SEASON_STATUS.REGULAR_SEASON, championTeamId: null });
    expect(await prisma.match.count({
      where: { seasonId: season.id, phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] } },
    })).toBe(0);

    const reopened = await reopenMatch({}, form({ matchId: tiebreaker.id }));
    expect(reopened?.error).toBeUndefined();
    expect(await prisma.match.findUniqueOrThrow({ where: { id: tiebreaker.id } }))
      .toMatchObject({ status: MATCH_STATUS.SCHEDULED, winnerTeamId: null });
  });

  it("rejects a drawn tiebreaker even when submitted as a forfeit ruling", async () => {
    const { tiebreaker } = await setup();
    const result = await recordResult({}, form({
      matchId: tiebreaker.id, homeScore: "1", awayScore: "1", forfeit: "on",
    }));
    expect(result?.error).toMatch(/tiebreaker.*draw/i);
    expect(await prisma.match.findUniqueOrThrow({ where: { id: tiebreaker.id } }))
      .toMatchObject({ status: MATCH_STATUS.SCHEDULED, homeScore: 0, awayScore: 0 });
  });

  it("freezes regular corrections and team eligibility until the extra week is reset", async () => {
    const { season, home, away, regular } = await setup();
    const expectedActiveSeasonId = season.id;
    expect((await recordResult({}, form({
      matchId: regular.id, homeScore: "2", awayScore: "0",
    })))?.error).toMatch(/Reset the tiebreaker week/);
    expect((await reopenMatch({}, form({ matchId: regular.id })))?.error)
      .toMatch(/Reset the tiebreaker week/);
    expect((await withdrawTeam({}, form({ teamId: home.id, expectedActiveSeasonId })))?.error)
      .toMatch(/Reset the tiebreaker week/);
    await prisma.team.update({ where: { id: away.id }, data: { withdrawn: true } });
    expect((await reinstateTeam({}, form({ teamId: away.id, expectedActiveSeasonId })))?.error)
      .toMatch(/Reset the tiebreaker week/);
    expect(await prisma.team.findUniqueOrThrow({ where: { id: home.id } }))
      .toMatchObject({ withdrawn: false });
    expect(await prisma.team.findUniqueOrThrow({ where: { id: away.id } }))
      .toMatchObject({ withdrawn: true });
    expect(await prisma.match.findUniqueOrThrow({ where: { id: regular.id } }))
      .toMatchObject({ status: MATCH_STATUS.COMPLETED, homeScore: 1, awayScore: 1 });
  });

  it("keeps games and earlier-round winners when a later tiebreaker week exists", async () => {
    const { season, home, away, tiebreaker } = await setup();
    await prisma.match.update({
      where: { id: tiebreaker.id },
      data: { status: MATCH_STATUS.COMPLETED, homeScore: 2, winnerTeamId: home.id },
    });
    const game = await prisma.game.create({
      data: { matchId: tiebreaker.id, dotaMatchId: "91919001", radiantWin: true, winnerTeamId: home.id },
    });
    await prisma.match.create({
      data: {
        seasonId: season.id, homeTeamId: home.id, awayTeamId: away.id,
        phase: MATCH_PHASE.TIEBREAKER, week: 3, bestOf: 3, bracketSlot: "TB:test:2",
      },
    });
    expect((await removeGame({}, form({ gameId: game.id })))?.error)
      .toMatch(/later tiebreaker round/i);
    expect(await prisma.game.findUnique({ where: { id: game.id } })).not.toBeNull();
    await prisma.game.delete({ where: { id: game.id } });
    expect((await reopenMatch({}, form({ matchId: tiebreaker.id })))?.error)
      .toMatch(/later tiebreaker round/i);
    expect(await matchResultLockReason(prisma, { ...tiebreaker, week: 3 })).toBeNull();
  });

  it("locks tiebreakers against seeded playoffs even if the season phase is stale", async () => {
    const { season, home, away, tiebreaker } = await setup();
    await prisma.match.create({
      data: {
        seasonId: season.id, homeTeamId: home.id, awayTeamId: away.id,
        phase: MATCH_PHASE.TIEBREAKER, week: 3, bestOf: 3, bracketSlot: "TB:test:2",
      },
    });
    await prisma.match.create({
      data: {
        seasonId: season.id, homeTeamId: home.id, awayTeamId: away.id,
        phase: MATCH_PHASE.FINAL, week: 3, bestOf: 3, bracketSlot: "R1M1",
      },
    });
    expect((await recordResult({}, form({
      matchId: tiebreaker.id, homeScore: "2", awayScore: "0",
    })))?.error).toMatch(/playoffs are already seeded/i);
    expect(await prisma.match.findUniqueOrThrow({ where: { id: tiebreaker.id } }))
      .toMatchObject({ status: MATCH_STATUS.SCHEDULED });
  });
});
