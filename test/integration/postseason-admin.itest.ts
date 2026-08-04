import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { updateTag } from "next/cache";
import {
  recordResult,
  removeGame,
  reopenMatch,
  returnToRegularSeasonAction,
  setSeasonPhase,
  startPlayoffs,
} from "@/app/actions/admin";
import { sendDiscordMessage } from "@/lib/discord";
import { prisma } from "@/lib/prisma";
import { playoffSetupRevision } from "@/lib/playoff-command";
import {
  advancePlayoffBracket,
  createPlayoffBracket,
} from "@/lib/playoff-service";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  recordMatch,
} from "./factories";

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function seededSeason(teamCount: number) {
  const season = await makeSeason({
    status: SEASON_STATUS.REGULAR_SEASON,
    minTeams: Math.max(2, teamCount),
    teamSize: 3,
  });
  const teams = [];
  for (let i = 0; i < teamCount; i++) {
    teams.push(await makeTeam(season.id, `Team ${i}`, i));
  }
  const strength = new Map(teams.map((team, index) => [team.id, index]));
  const matches = await generateRegularSchedule(season.id);
  for (const match of matches) {
    const homeWins =
      strength.get(match.homeTeamId)! < strength.get(match.awayTeamId)!;
    await recordMatch(match.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
  }
  return { season, teams };
}

async function commandFields(seasonId: string) {
  const [season, teams, matches] = await Promise.all([
    prisma.season.findUniqueOrThrow({ where: { id: seasonId } }),
    prisma.team.findMany({ where: { seasonId } }),
    prisma.match.findMany({
      where: { seasonId },
      include: {
        games: { select: { id: true, dotaMatchId: true } },
        availability: { select: { id: true, userId: true, status: true } },
        standins: {
          select: {
            id: true,
            teamId: true,
            standinUserId: true,
            replacingUserId: true,
          },
        },
        predictions: {
          select: { id: true, userId: true, pickedTeamId: true },
        },
        reschedules: {
          select: {
            id: true,
            proposedById: true,
            proposedTime: true,
            status: true,
          },
        },
      },
    }),
  ]);
  return {
    expectedActiveSeasonId: season.id,
    expectedSeasonStatus: season.status,
    expectedRevision: playoffSetupRevision({ season, teams, matches }),
  };
}

async function postseason(seasonId: string) {
  return prisma.match.findMany({
    where: { seasonId, phase: { not: "REGULAR" } },
    orderBy: { bracketSlot: "asc" },
  });
}

async function crownedImportedFinalWithRemovableLoss() {
  const { season } = await seededSeason(2);
  await createPlayoffBracket(season.id);
  const [final] = await postseason(season.id);
  let losingGameId = "";
  for (let index = 0; index < 4; index++) {
    const homeWon = index < 3;
    const game = await prisma.game.create({
      data: {
        matchId: final.id,
        dotaMatchId: `decided-championship-${index}`,
        radiantWin: homeWon,
        winnerTeamId: homeWon ? final.homeTeamId : final.awayTeamId,
        players: "[]",
      },
    });
    if (!homeWon) losingGameId = game.id;
  }
  await prisma.match.update({
    where: { id: final.id },
    data: {
      status: MATCH_STATUS.COMPLETED,
      homeScore: 3,
      awayScore: 1,
      winnerTeamId: final.homeTeamId,
    },
  });
  if (!(await advancePlayoffBracket(season.id))) {
    throw new Error("Failed to crown the imported championship fixture");
  }
  return { season, final, losingGameId };
}

describe("postseason admin commands", () => {
  afterEach(() => {
    setRaceHook(null);
    vi.restoreAllMocks();
  });

  it("makes Start explicit and replay-safe all the way through the Server Action", async () => {
    vi.mocked(updateTag).mockClear();
    const { season } = await seededSeason(4);
    const claim = await commandFields(season.id);
    const values = { ...claim, intent: "start" };

    const first = await startPlayoffs({}, form(values));
    expect(first?.error).toBeUndefined();
    const bracketIds = (await postseason(season.id)).map((match) => match.id);

    const replay = await startPlayoffs({}, form(values));
    expect(replay?.error).toMatch(/changed.*reload|already exists/i);
    expect((await postseason(season.id)).map((match) => match.id)).toEqual(
      bracketIds,
    );
    expect(updateTag).toHaveBeenCalledWith("games");
  });

  it("does not disclose an unexpected playoff-start database error", async () => {
    const secret = "postgresql://league:secret@internal.example/league";
    const { season } = await seededSeason(2);
    const claim = await commandFields(season.id);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error(secret));

    const result = await startPlayoffs(
      {},
      form({ ...claim, intent: "start" }),
    );

    expect(result).toEqual({
      error: "Couldn't update the playoff bracket — reload and try again",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(log).toHaveBeenCalledWith(
      "[server-action:admin.playoffs.start] unexpected failure",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });

  it("rejects missing intent and a stale active-season claim", async () => {
    const { season } = await seededSeason(2);
    const claim = await commandFields(season.id);
    expect((await startPlayoffs({}, form(claim)))?.error).toMatch(
      /choose start/i,
    );
    expect(
      (
        await startPlayoffs(
          {},
          form({ ...claim, expectedActiveSeasonId: "stale", intent: "start" }),
        )
      )?.error,
    ).toMatch(/active season changed/i);
    expect(await postseason(season.id)).toHaveLength(0);
  });

  it("rejects a Reset claim when an imported playoff game lands after the page snapshot", async () => {
    const { season } = await seededSeason(4);
    await createPlayoffBracket(season.id);
    const before = await postseason(season.id);
    const claim = await commandFields(season.id);
    const imported = await prisma.game.create({
      data: {
        matchId: before[0].id,
        dotaMatchId: "post-claim-playoff-game",
        radiantWin: true,
        winnerTeamId: before[0].homeTeamId,
        players: "[]",
      },
    });

    const reset = await startPlayoffs({}, form({ ...claim, intent: "reset" }));

    expect(reset?.error).toMatch(/imported games.*changed.*reload/i);
    expect((await postseason(season.id)).map((match) => match.id)).toEqual(
      before.map((match) => match.id),
    );
    expect(
      await prisma.game.findUnique({ where: { id: imported.id } }),
    ).not.toBeNull();
  });

  it("rejects a Reset claim when a playoff RSVP lands after the page snapshot", async () => {
    const { season, teams } = await seededSeason(4);
    await createPlayoffBracket(season.id);
    const before = await postseason(season.id);
    const claim = await commandFields(season.id);
    const availability = await prisma.matchAvailability.create({
      data: {
        matchId: before[0].id,
        userId: teams[0].captainId,
        status: "IN",
      },
    });

    const reset = await startPlayoffs({}, form({ ...claim, intent: "reset" }));

    expect(reset?.error).toMatch(/playoff bracket.*changed.*reload/i);
    expect((await postseason(season.id)).map((match) => match.id)).toEqual(
      before.map((match) => match.id),
    );
    expect(
      await prisma.matchAvailability.findUnique({
        where: { id: availability.id },
      }),
    ).not.toBeNull();
  });

  it("broadcasts when the administrator withdraws the bracket for a standings correction", async () => {
    const { season } = await seededSeason(2);
    await createPlayoffBracket(season.id);
    const claim = await commandFields(season.id);
    vi.mocked(sendDiscordMessage).mockClear();

    const result = await returnToRegularSeasonAction({}, form(claim));

    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(/returned to the regular season/i);
    expect(sendDiscordMessage).toHaveBeenCalledTimes(1);
    expect(sendDiscordMessage).toHaveBeenCalledWith(
      expect.stringMatching(/bracket is void.*Regular season/i),
    );
  });

  it("does not disclose an unexpected playoff-return database error", async () => {
    const secret = "postgresql://league:secret@internal.example/league";
    const { season } = await seededSeason(2);
    await createPlayoffBracket(season.id);
    const claim = await commandFields(season.id);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error(secret));

    const result = await returnToRegularSeasonAction({}, form(claim));

    expect(result).toEqual({
      error:
        "Couldn't return to the regular season — reload and try again",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(log).toHaveBeenCalledWith(
      "[server-action:admin.playoffs.return] unexpected failure",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });

  it("warns the administrator when the bracket-withdrawal broadcast fails", async () => {
    const { season } = await seededSeason(2);
    await createPlayoffBracket(season.id);
    const claim = await commandFields(season.id);
    vi.mocked(sendDiscordMessage).mockClear();
    vi.mocked(sendDiscordMessage).mockResolvedValueOnce(false);

    const result = await returnToRegularSeasonAction({}, form(claim));

    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(
      /Discord warning.*league-wide bracket notice failed.*manually/i,
    );
    expect(sendDiscordMessage).toHaveBeenCalledTimes(1);
  });

  it("does not let a phase button manufacture Complete or retract a champion", async () => {
    const { season } = await seededSeason(2);
    await createPlayoffBracket(season.id);
    let result = await setSeasonPhase(
      {},
      form({
        phase: SEASON_STATUS.COMPLETE,
        expectedActiveSeasonId: season.id,
      }),
    );
    expect(result?.error).toMatch(/automatically.*grand final/i);

    const [final] = await postseason(season.id);
    await recordMatch(final.id, 3, 0);
    await advancePlayoffBracket(season.id);
    result = await setSeasonPhase(
      {},
      form({
        phase: SEASON_STATUS.PLAYOFFS,
        expectedActiveSeasonId: season.id,
      }),
    );
    expect(result?.error).toMatch(/crowned season cannot move backward/i);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      status: SEASON_STATUS.COMPLETE,
      championTeamId: final.homeTeamId,
    });
  });

  it("reopens a hand-entered grand final without destroying earlier rounds", async () => {
    const { season } = await seededSeason(4);
    await createPlayoffBracket(season.id);
    const semis = await postseason(season.id);
    for (const semi of semis) {
      await recordMatch(semi.id, 2, 0);
      await advancePlayoffBracket(season.id);
    }
    const final = (await postseason(season.id)).find(
      (match) => match.phase === "FINAL",
    )!;
    await recordMatch(final.id, 3, 0);
    await advancePlayoffBracket(season.id);
    await prisma.setting.upsert({
      where: { key: `championAnnounced:${season.id}` },
      create: { key: `championAnnounced:${season.id}`, value: "sent" },
      update: { value: "sent" },
    });

    const opened = await reopenMatch(
      {},
      form({ matchId: final.id, expectedActiveSeasonId: season.id }),
    );
    expect(opened?.error).toBeUndefined();
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({ status: SEASON_STATUS.PLAYOFFS, championTeamId: null });
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: final.id } }),
    ).toMatchObject({
      status: "SCHEDULED",
      homeScore: 0,
      awayScore: 0,
      winnerTeamId: null,
    });
    expect(
      await prisma.match.count({
        where: {
          id: { in: semis.map((match) => match.id) },
          status: "COMPLETED",
        },
      }),
    ).toBe(semis.length);
    expect(
      await prisma.setting.findUnique({
        where: { key: `championAnnounced:${season.id}` },
      }),
    ).toBeNull();

    const corrected = await recordResult(
      {},
      form({
        matchId: final.id,
        expectedActiveSeasonId: season.id,
        homeScore: "0",
        awayScore: "3",
      }),
    );
    expect(corrected?.error).toBeUndefined();
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      status: SEASON_STATUS.COMPLETE,
      championTeamId: final.awayTeamId,
    });
  });

  it("uses the targeted final recovery when the stored champion is the losing finalist", async () => {
    const { season } = await seededSeason(2);
    await createPlayoffBracket(season.id);
    const [final] = await postseason(season.id);
    await recordMatch(final.id, 3, 0);
    await advancePlayoffBracket(season.id);
    await prisma.season.update({
      where: { id: season.id },
      data: { championTeamId: final.awayTeamId },
    });

    const opened = await reopenMatch(
      {},
      form({ matchId: final.id, expectedActiveSeasonId: season.id }),
    );

    expect(opened?.error).toBeUndefined();
    expect(opened?.message).toMatch(/champion retracted/i);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({ status: SEASON_STATUS.PLAYOFFS, championTeamId: null });
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: final.id } }),
    ).toMatchObject({
      status: MATCH_STATUS.SCHEDULED,
      homeScore: 0,
      awayScore: 0,
      winnerTeamId: null,
    });
  });

  it("removes an imported championship game by atomically un-crowning the final", async () => {
    const { season } = await seededSeason(2);
    await createPlayoffBracket(season.id);
    const [final] = await postseason(season.id);
    const games = [];
    for (let i = 0; i < 3; i++) {
      games.push(
        await prisma.game.create({
          data: {
            matchId: final.id,
            dotaMatchId: `championship-${i}`,
            radiantWin: true,
            winnerTeamId: final.homeTeamId,
            players: "[]",
          },
        }),
      );
    }
    await prisma.match.update({
      where: { id: final.id },
      data: {
        status: "COMPLETED",
        homeScore: 3,
        awayScore: 0,
        winnerTeamId: final.homeTeamId,
      },
    });
    await advancePlayoffBracket(season.id);

    const removed = await removeGame({}, form({ gameId: games[0].id }));
    expect(removed?.error).toBeUndefined();
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({ status: SEASON_STATUS.PLAYOFFS, championTeamId: null });
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: final.id } }),
    ).toMatchObject({
      status: "LIVE",
      homeScore: 2,
      awayScore: 0,
      winnerTeamId: null,
    });
  });

  it("re-crowns a final that remains decided after its losing-side game is removed", async () => {
    const { season, final, losingGameId } =
      await crownedImportedFinalWithRemovableLoss();
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      status: SEASON_STATUS.COMPLETE,
      championTeamId: final.homeTeamId,
    });

    const removed = await removeGame({}, form({ gameId: losingGameId }));

    expect(removed?.error).toBeUndefined();
    expect(removed?.message).toMatch(/series recomputed.*re-crowned/i);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      status: SEASON_STATUS.COMPLETE,
      championTeamId: final.homeTeamId,
    });
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: final.id } }),
    ).toMatchObject({
      status: "COMPLETED",
      homeScore: 3,
      awayScore: 0,
      winnerTeamId: final.homeTeamId,
    });
    expect(
      await prisma.game.findUnique({ where: { id: losingGameId } }),
    ).toBeNull();
  });

  it("does not claim a re-crown when championship advancement throws after the removal commits", async () => {
    const { season, final, losingGameId } =
      await crownedImportedFinalWithRemovableLoss();
    vi.spyOn(console, "error").mockImplementation(() => {});
    setRaceHook(
      onceAt("playoffs.advance.beforeCrown", async () => {
        throw new Error("forced re-crown failure");
      }),
    );

    const removed = await removeGame({}, form({ gameId: losingGameId }));

    expect(removed?.error).toBeUndefined();
    expect(removed?.message).not.toMatch(/champion was re-crowned/i);
    expect(removed?.message).toMatch(/could not be confirmed/i);
    expect(removed?.message).toMatch(
      /removal is saved.*champion re-crowning did not finish/i,
    );
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      status: SEASON_STATUS.PLAYOFFS,
      championTeamId: null,
    });
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: final.id } }),
    ).toMatchObject({
      status: MATCH_STATUS.COMPLETED,
      homeScore: 3,
      awayScore: 0,
      winnerTeamId: final.homeTeamId,
    });
    expect(
      await prisma.game.findUnique({ where: { id: losingGameId } }),
    ).toBeNull();
  });

  it("does not treat COMPLETE without the corrected champion as a successful re-crown", async () => {
    const { season, losingGameId } =
      await crownedImportedFinalWithRemovableLoss();
    setRaceHook(
      onceAt("playoffs.advance.beforeCrown", async () => {
        await prisma.season.update({
          where: { id: season.id },
          data: { status: SEASON_STATUS.COMPLETE, championTeamId: null },
        });
      }),
    );

    const removed = await removeGame({}, form({ gameId: losingGameId }));

    expect(removed?.error).toBeUndefined();
    expect(removed?.message).not.toMatch(/champion was re-crowned/i);
    expect(removed?.message).toMatch(/could not be confirmed/i);
    expect(removed?.message).toMatch(/champion re-crowning did not finish/i);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      status: SEASON_STATUS.COMPLETE,
      championTeamId: null,
    });
    expect(
      await prisma.game.findUnique({ where: { id: losingGameId } }),
    ).toBeNull();
  });

  it("reports a re-crown when a concurrent caller committed the corrected champion first", async () => {
    const { season, final, losingGameId } =
      await crownedImportedFinalWithRemovableLoss();
    let rivalAdvanced = false;
    setRaceHook(
      onceAt("playoffs.advance.beforeCrown", async () => {
        rivalAdvanced = await advancePlayoffBracket(season.id);
      }),
    );

    const removed = await removeGame({}, form({ gameId: losingGameId }));

    expect(rivalAdvanced).toBe(true);
    expect(removed?.error).toBeUndefined();
    expect(removed?.message).toMatch(/champion was re-crowned/i);
    expect(removed?.message).not.toMatch(/re-crowning.*did not finish/i);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      status: SEASON_STATUS.COMPLETE,
      championTeamId: final.homeTeamId,
    });
    expect(
      await prisma.game.findUnique({ where: { id: losingGameId } }),
    ).toBeNull();
  });
});
