import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { importGameForMatch, autoDetectGamesForMatch, syncLeagueGames, enrichStoredGames } from "@/lib/match-import";
import { setRaceHook, onceAt } from "@/lib/race-hook";
import { makeSeason, makeTeam, makeUser } from "./factories";
import { correctGameIdentity } from "@/lib/game-identity-correction";
import { gamePlayersDigest } from "@/lib/game-participants";

vi.mock("@/lib/dota", async (original) => ({
  ...await original<typeof import("@/lib/dota")>(),
  fetchOpenDotaMatch: vi.fn(), fetchRecentMatchIds: vi.fn(async () => [777]),
  fetchLeagueMatchIds: vi.fn(async () => [777]),
}));
import { fetchOpenDotaMatch } from "@/lib/dota";

async function setup(confirmedTime = 900_000) {
  const season = await makeSeason();
  await prisma.season.update({ where: { id: season.id }, data: { status: "REGULAR_SEASON", dotaLeagueId: "123" } });
  const home = await makeTeam(season.id, "Home", 0), away = await makeTeam(season.id, "Away", 1);
  const match = await prisma.match.create({ data: { seasonId: season.id, homeTeamId: home.id, awayTeamId: away.id,
    week: 1, scheduledAt: new Date(1_000_000), bestOf: 1 } });
  for (const [side, team] of [home, away].entries()) {
    await prisma.matchLineup.create({ data: {
      matchId: match.id, teamId: team.id, revision: 1, scheduleRevision: 0, logisticsRevision: 0,
      scheduledAtSnapshot: new Date(1_000_000), createdAt: new Date(confirmedTime), confirmedAt: new Date(confirmedTime),
      createdById: team.captainId, confirmedById: team.captainId, confirmedByName: "Captain",
      status: "SUPERSEDED", supersededAt: new Date(2_000_000), compositionFingerprint: "recorded",
      seats: { create: Array.from({ length: 5 }, (_, i) => ({ seatKey: String(i),
        userId: `former-${side}-${i}`, userNameSnapshot: `Former ${side}-${i}`, accountId: 2_000_000_000 + side * 5 + i,
        entryKind: "ROSTER", acceptanceStatusSnapshot: "READY", position: i + 1,
        mmr: 2100 + i, mmrSource: "REGISTRATION", ratingAt: new Date(confirmedTime), availabilityAt: new Date(confirmedTime),
      })) },
    } });
  }
  const details = { match_id: 777, radiant_win: true, duration: 1800, start_time: 1000, radiant_score: 20, dire_score: 10,
    players: Array.from({ length: 10 }, (_, i) => ({ account_id: 2_000_000_000 + i,
      player_slot: i < 5 ? i : 128 + i - 5, hero_id: i + 1, isRadiant: i < 5,
      kills: i, deaths: 2, assists: 4, gold_per_min: 400, xp_per_min: 500 })) };
  vi.mocked(fetchOpenDotaMatch).mockResolvedValue(details);
  return { season, home, away, match, details };
}
afterEach(() => { setRaceHook(null); vi.clearAllMocks(); });

describe("confirmed historical lineup imports", () => {
  it("imports after roster release using prior seats and pre-game metadata", async () => {
    const { match, home } = await setup();
    const result = await importGameForMatch(match.id, "777");
    expect(result.ok).toBe(true);
    const game = await prisma.game.findUniqueOrThrow({ where: { dotaMatchId: "777" } });
    expect(game.participantComplete).toBe(true);
    expect(game.participantSource).toBe(game.players);
    const first = JSON.parse(game.players)[0];
    expect(first).toMatchObject({ userId: "former-0-0", teamId: home.id, providerPlayerSlot: 0,
      plannedPosition: 1, positionSource: "LINEUP_PLANNED", ratingSnapshot: 2100, ratingSource: "REGISTRATION" });
    expect(first).not.toHaveProperty("playedPosition");
    expect(await prisma.gameParticipant.count()).toBe(10);
  });
  it("uses the same historical resolver in per-player discovery", async () => {
    const { match } = await setup();
    expect(await autoDetectGamesForMatch(match.id)).toMatchObject({ imported: 1 });
  });
  it("uses batched historical snapshots in league feed classification", async () => {
    const { season } = await setup();
    expect(await syncLeagueGames(season.id)).toMatchObject({ imported: 1 });
  });
  it("does not backdate a later confirmed lineup into an older game", async () => {
    const { match } = await setup(1_100_000);
    expect((await importGameForMatch(match.id, "777")).ok).toBe(false);
    expect(await prisma.game.count()).toBe(0);
    expect(await prisma.gameParticipant.count()).toBe(0);
  });
  it("enrichment keeps attribution/provenance and rebuilds its source proof", async () => {
    const { match } = await setup(); await importGameForMatch(match.id, "777");
    const game = await prisma.game.findUniqueOrThrow({ where: { dotaMatchId: "777" } });
    const lines = JSON.parse(game.players); for (const line of lines) delete line.benchmarks;
    await prisma.game.update({ where: { id: game.id }, data: { players: JSON.stringify(lines) } });
    expect(await enrichStoredGames()).toMatchObject({ enriched: 1, failed: 0 });
    const updated = await prisma.game.findUniqueOrThrow({ where: { id: game.id } });
    expect(updated.participantSource).toBe(updated.players);
    const first = await prisma.gameParticipant.findFirstOrThrow({ where: { gameId: game.id, sourceLineIndex: 0 } });
    expect(first).toMatchObject({ userId: "former-0-0", plannedPosition: 1, ratingSnapshot: 2100, playedPosition: null });
  });
  it("a real identity correction wins over delayed provider enrichment", async () => {
    const { match, details, home } = await setup(); await importGameForMatch(match.id, "777");
    const game = await prisma.game.findUniqueOrThrow({ where: { dotaMatchId: "777" } });
    const lines = JSON.parse(game.players); for (const line of lines) delete line.benchmarks;
    const players = JSON.stringify(lines);
    await prisma.game.update({ where: { id: game.id }, data: { players } });
    const admin = await makeUser("Admin", "ADMIN"), replacement = await makeUser("Correct player");
    vi.mocked(fetchOpenDotaMatch).mockImplementationOnce(async () => {
      await correctGameIdentity({ actorId: admin.id, gameId: game.id, sourceLineIndex: 0,
        expectedSourceDigest: gamePlayersDigest(players), userId: replacement.id,
        teamId: home.id, reason: "Verified participant identity" });
      return details;
    });
    expect(await enrichStoredGames()).toMatchObject({ enriched: 0, failed: 1 });
    const updated = await prisma.game.findUniqueOrThrow({ where: { id: game.id } });
    expect(JSON.parse(updated.players)[0]).toMatchObject({ userId: replacement.id });
    expect(JSON.parse(updated.players)[0]).not.toHaveProperty("ratingSnapshot");
    expect(updated.participantSource).toBe(updated.players);
    expect(await prisma.gameParticipant.count({ where: { gameId: game.id, userId: replacement.id } })).toBe(1);
  });

  it("rolls back game, ownership claim and projection when a participant write fails", async () => {
    const { match } = await setup();
    setRaceHook(onceAt("gameParticipants.beforeRows", async () => { throw new Error("row write unavailable"); }));
    await expect(importGameForMatch(match.id, "777")).rejects.toThrow("row write unavailable");
    expect(await prisma.game.count()).toBe(0);
    expect(await prisma.gameParticipant.count()).toBe(0);
    expect(await prisma.dotaMatchClaim.count()).toBe(0);
  });
});
