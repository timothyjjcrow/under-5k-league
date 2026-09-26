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

const ROSTER_ACCOUNT = 2_000_000_000;
const OLD_LINEUP_ACCOUNT = 3_000_000_000;

/** Two rostered 5-player teams and a Bo1 fixture. With `leftoverLineups`, each
 * side also carries a confirmed lineup naming five OTHER accounts — rows the
 * removed "Playing lineups" card may have left behind. */
async function setup({ leftoverLineups = true } = {}) {
  const season = await makeSeason({ teamSize: 5 });
  await prisma.season.update({ where: { id: season.id }, data: { status: "REGULAR_SEASON", dotaLeagueId: "123" } });
  const home = await makeTeam(season.id, "Home", 0), away = await makeTeam(season.id, "Away", 1);
  const match = await prisma.match.create({ data: { seasonId: season.id, homeTeamId: home.id, awayTeamId: away.id,
    week: 1, scheduledAt: new Date(1_000_000), bestOf: 1 } });
  const players: { id: string; name: string }[][] = [];
  for (const [side, team] of [home, away].entries()) {
    players[side] = [];
    for (let i = 0; i < 5; i++) {
      const user = await prisma.user.update({
        where: { id: (await makeUser(`Player ${side}-${i}`)).id },
        data: { dotaAccountIdV2: ROSTER_ACCOUNT + side * 5 + i },
      });
      await prisma.teamMember.create({ data: { seasonId: season.id, teamId: team.id, userId: user.id, isCaptain: i === 0, price: 0 } });
      players[side].push(user);
    }
    if (!leftoverLineups) continue;
    await prisma.matchLineup.create({ data: {
      matchId: match.id, teamId: team.id, revision: 1, activeKey: `${match.id}:${team.id}`,
      scheduleRevision: 0, logisticsRevision: 0,
      scheduledAtSnapshot: new Date(1_000_000), createdAt: new Date(900_000), confirmedAt: new Date(900_000),
      createdById: team.captainId, confirmedById: team.captainId, confirmedByName: "Captain",
      status: "CONFIRMED", compositionFingerprint: "recorded",
      seats: { create: Array.from({ length: 5 }, (_, i) => ({ seatKey: String(i),
        userId: `former-${side}-${i}`, userNameSnapshot: `Former ${side}-${i}`, accountId: OLD_LINEUP_ACCOUNT + side * 5 + i,
        entryKind: "ROSTER", acceptanceStatusSnapshot: "READY", position: i + 1,
        mmr: 2100 + i, mmrSource: "REGISTRATION", ratingAt: new Date(900_000), availabilityAt: new Date(900_000),
      })) },
    } });
  }
  const details = { match_id: 777, radiant_win: true, duration: 1800, start_time: 1000, radiant_score: 20, dire_score: 10,
    players: Array.from({ length: 10 }, (_, i) => ({ account_id: ROSTER_ACCOUNT + i,
      player_slot: i < 5 ? i : 128 + i - 5, hero_id: i + 1, isRadiant: i < 5,
      kills: i, deaths: 2, assists: 4, gold_per_min: 400, xp_per_min: 500 })) };
  vi.mocked(fetchOpenDotaMatch).mockResolvedValue(details);
  return { season, home, away, match, details, players };
}
afterEach(() => { setRaceHook(null); vi.clearAllMocks(); });

describe("result imports use the roster and standin cover, never saved lineups", () => {
  it("credits the rostered players even when an old confirmed lineup names others", async () => {
    const { match, home, players } = await setup();
    const result = await importGameForMatch(match.id, "777");
    expect(result.ok).toBe(true);
    const game = await prisma.game.findUniqueOrThrow({ where: { dotaMatchId: "777" } });
    expect(game.participantComplete).toBe(true);
    expect(game.participantSource).toBe(game.players);
    const first = JSON.parse(game.players)[0];
    expect(first).toMatchObject({ userId: players[0][0].id, teamId: home.id, providerPlayerSlot: 0 });
    for (const key of ["plannedPosition", "positionSource", "ratingSnapshot", "playedPosition"]) {
      expect(first).not.toHaveProperty(key);
    }
    expect(await prisma.gameParticipant.count()).toBe(10);
  });
  it("a standin booked for the match is credited for the seat they covered", async () => {
    const { match, home, players, details } = await setup({ leftoverLineups: false });
    const standin = await prisma.user.update({
      where: { id: (await makeUser("Standin")).id }, data: { dotaAccountIdV2: 2_100_000_000 },
    });
    await prisma.standinAssignment.create({ data: {
      matchId: match.id, teamId: home.id, standinUserId: standin.id, replacingUserId: players[0][4].id,
    } });
    details.players[4].account_id = 2_100_000_000;
    expect((await importGameForMatch(match.id, "777")).ok).toBe(true);
    const lines = JSON.parse((await prisma.game.findUniqueOrThrow({ where: { dotaMatchId: "777" } })).players);
    expect(lines[4]).toMatchObject({ userId: standin.id, teamId: home.id });
  });
  it("per-player discovery ignores leftover lineups", async () => {
    const { match } = await setup();
    expect(await autoDetectGamesForMatch(match.id)).toMatchObject({ imported: 1 });
  });
  it("league feed classification ignores leftover lineups", async () => {
    const { season } = await setup();
    expect(await syncLeagueGames(season.id)).toMatchObject({ imported: 1 });
  });
  it("a game played by the old lineup's accounts is not claimed for the fixture", async () => {
    const { match, details } = await setup();
    details.players.forEach((player, i) => { player.account_id = OLD_LINEUP_ACCOUNT + i; });
    expect((await importGameForMatch(match.id, "777")).ok).toBe(false);
    expect(await prisma.game.count()).toBe(0);
    expect(await prisma.gameParticipant.count()).toBe(0);
  });
  it("enrichment keeps attribution/provenance and rebuilds its source proof", async () => {
    const { match, players } = await setup(); await importGameForMatch(match.id, "777");
    const game = await prisma.game.findUniqueOrThrow({ where: { dotaMatchId: "777" } });
    const lines = JSON.parse(game.players); for (const line of lines) delete line.benchmarks;
    await prisma.game.update({ where: { id: game.id }, data: { players: JSON.stringify(lines) } });
    expect(await enrichStoredGames()).toMatchObject({ enriched: 1, failed: 0 });
    const updated = await prisma.game.findUniqueOrThrow({ where: { id: game.id } });
    expect(updated.participantSource).toBe(updated.players);
    const first = await prisma.gameParticipant.findFirstOrThrow({ where: { gameId: game.id, sourceLineIndex: 0 } });
    expect(first).toMatchObject({ userId: players[0][0].id, plannedPosition: null, ratingSnapshot: null, playedPosition: null });
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
