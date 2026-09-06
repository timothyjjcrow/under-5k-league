import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(), getSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/discord", async (original) => ({
  ...(await original<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));
vi.mock("@/lib/dota", async (original) => ({
  ...(await original<typeof import("@/lib/dota")>()),
  fetchOpenDotaMatch: vi.fn(),
  fetchRecentMatchIds: vi.fn(async () => []),
  fetchLeagueMatchIds: vi.fn(async () => []),
}));
vi.mock("@/lib/tiebreaker-service", async (original) => {
  const actual = await original<typeof import("@/lib/tiebreaker-service")>();
  return { ...actual, advanceTiebreakerWeek: vi.fn(actual.advanceTiebreakerWeek) };
});

import { prisma } from "@/lib/prisma";
import { fetchOpenDotaMatch, steamIdToAccountId } from "@/lib/dota";
import { recordResult, removeGame, reopenMatch } from "@/app/actions/admin";
import { advanceTiebreakerWeek, createTiebreakerWeek } from "@/lib/tiebreaker-service";
import { parseTiebreakerStage } from "@/lib/tiebreakers";
import { importGameForMatch } from "@/lib/match-import";
import { projectPlayoffField } from "@/lib/playoff-field";
import { runResultSync } from "@/lib/result-sync-service";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { generateRegularSchedule, makeSeason, makeTeam, makeUser, recordMatch } from "./factories";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function setup() {
  const season = await makeSeason({ status: "REGULAR_SEASON" });
  const teams = [];
  for (let i = 0; i < 3; i++) teams.push(await makeTeam(season.id, `Team ${i}`, i));
  const regular = await generateRegularSchedule(season.id);
  for (const match of regular) await recordMatch(match.id, 1, 1);
  await createTiebreakerWeek(season.id);
  return { season, teams, regular };
}

async function stages(seasonId: string) {
  return (await prisma.match.findMany({ where: { seasonId, phase: "TIEBREAKER" } }))
    .sort((a, b) => parseTiebreakerStage(a.bracketSlot)!.stage - parseTiebreakerStage(b.bracketSlot)!.stage);
}

async function win(match: { id: string; homeTeamId: string }, winnerTeamId = match.homeTeamId) {
  return recordResult({}, form({
    matchId: match.id,
    homeScore: winnerTeamId === match.homeTeamId ? "1" : "0",
    awayScore: winnerTeamId === match.homeTeamId ? "0" : "1",
  }));
}

async function mockGame(match: { seasonId: string; homeTeamId: string; awayTeamId: string }, id: number) {
  const players = [];
  for (const [side, teamId] of [match.homeTeamId, match.awayTeamId].entries()) {
    for (let i = 0; i < 3; i++) {
      const user = await makeUser(`Player ${side}-${i}`);
      await prisma.teamMember.create({ data: { seasonId: match.seasonId, teamId, userId: user.id, price: 0 } });
      players.push({
        account_id: steamIdToAccountId(user.steamId)!, player_slot: side * 128 + i,
        hero_id: i + 1 + side * 3, isRadiant: side === 0, kills: 1, deaths: 0, assists: 0,
      });
    }
  }
  vi.mocked(fetchOpenDotaMatch).mockResolvedValue({
    match_id: id, radiant_win: true, duration: 2000, start_time: 1,
    radiant_score: 30, dire_score: 20, players,
  });
}

afterEach(() => {
  setRaceHook(null);
  vi.clearAllMocks();
});

describe("three-team BO1 result lifecycle", () => {
  it("creates each next game after an admin result, finishes in four games, and preserves the ongoing season", async () => {
    const { season, teams } = await setup();
    const before = await prisma.match.findMany({ where: { seasonId: season.id, phase: "REGULAR" } });
    const first = (await stages(season.id))[0];
    expect(first.bestOf).toBe(1);
    for (let stage = 1; stage <= 3; stage++) {
      const slate = await stages(season.id);
      expect(slate).toHaveLength(stage);
      expect((await win(slate[stage - 1]))?.error).toBeUndefined();
    }
    const final = await stages(season.id);
    expect(final).toHaveLength(4);
    expect((await win(final[3], final[1].winnerTeamId!))?.error).toBeUndefined();
    const completed = await stages(season.id);
    expect(completed).toHaveLength(4);
    expect(completed.every((m) => m.bestOf === 1 && m.week === first.week && m.status === "COMPLETED")).toBe(true);
    const all = await prisma.match.findMany({ where: { seasonId: season.id } });
    expect(projectPlayoffField(teams, all).tiebreakers.resolved).toBe(true);
    expect(all.filter((m) => m.phase === "REGULAR")).toEqual(before);
    expect(all.filter((m) => ["PLAYOFF", "FINAL"].includes(m.phase))).toHaveLength(0);
    expect(await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
      .toMatchObject({ status: "REGULAR_SEASON", championTeamId: null });
  });

  it("adds only one reset game when the undefeated team loses, then resolves every seed in the same week", async () => {
    const { season, teams } = await setup();
    for (let stage = 1; stage <= 3; stage++) await win((await stages(season.id))[stage - 1]);
    const final = await stages(season.id);
    await win(final[3], final[2].winnerTeamId!);
    const reset = await stages(season.id);
    expect(reset).toHaveLength(5);
    expect(reset[4].week).toBe(reset[0].week);
    await win(reset[4]);
    await advanceTiebreakerWeek(season.id);
    await advanceTiebreakerWeek(season.id);
    const all = await prisma.match.findMany({ where: { seasonId: season.id } });
    const field = projectPlayoffField(teams, all);
    expect(field.tiebreakers.resolved).toBe(true);
    expect(new Set(field.seededTeamIds).size).toBe(field.seededTeamIds.length);
    expect(await stages(season.id)).toHaveLength(5);
  });

  it("commits one imported game as a BO1 win, advances once, and locks the consumed source against removal", async () => {
    const { season } = await setup();
    const first = (await stages(season.id))[0];
    await mockGame(first, 987654321);
    expect(await importGameForMatch(first.id, "987654321"))
      .toMatchObject({ ok: true, decided: true, homeScore: 1, awayScore: 0, winnerTeamId: first.homeTeamId });
    expect(await stages(season.id)).toHaveLength(2);
    expect((await importGameForMatch(first.id, "987654321")).ok).toBe(false);
    const game = await prisma.game.findFirstOrThrow({ where: { matchId: first.id } });
    expect((await removeGame({}, form({ gameId: game.id })))?.error).toMatch(/later tiebreaker/i);
    expect(await prisma.game.count({ where: { matchId: first.id } })).toBe(1);
    expect(await prisma.dotaMatchClaim.count({ where: { dotaMatchId: "987654321" } })).toBe(1);
    expect(await stages(season.id)).toHaveLength(2);
  });

  it("keeps an imported result durable when advancement fails and recovers the next game on automatic sync", async () => {
    const { season } = await setup();
    const first = (await stages(season.id))[0];
    await mockGame(first, 987654322);
    vi.mocked(advanceTiebreakerWeek).mockRejectedValueOnce(new Error("temporary failure"));
    expect(await importGameForMatch(first.id, "987654322"))
      .toMatchObject({ ok: true, decided: true, downstreamPending: true });
    expect(await stages(season.id)).toHaveLength(1);
    const result = await runResultSync();
    expect(result.issues).not.toContain("TIEBREAKER_SYNC_FAILED");
    expect(result.playoff).toBe(false);
    expect(await stages(season.id)).toHaveLength(2);
    await runResultSync();
    expect(await stages(season.id)).toHaveLength(2);
    expect(await prisma.game.count({ where: { matchId: first.id } })).toBe(1);
  });

  it("can correct a saved result before its next stage exists, and retries from the corrected source", async () => {
    const { season } = await setup();
    const first = (await stages(season.id))[0];
    vi.mocked(advanceTiebreakerWeek).mockRejectedValueOnce(new Error("temporary failure"));
    expect((await win(first))?.message).toMatch(/Result saved.*pending automatic retry/);
    expect((await reopenMatch({}, form({ matchId: first.id })))?.error).toBeUndefined();
    await runResultSync();
    expect(await stages(season.id)).toHaveLength(1);
    await win(first, first.awayTeamId);
    const next = (await stages(season.id))[1];
    expect([next.homeTeamId, next.awayTeamId]).toContain(first.awayTeamId);
    expect([next.homeTeamId, next.awayTeamId]).not.toContain(first.homeTeamId);
  });

  it("rechecks same-week advancement inside the result command before applying a stale correction", async () => {
    const { season } = await setup();
    const first = (await stages(season.id))[0];
    await recordMatch(first.id, 1, 0);
    setRaceHook(onceAt("recordResult.beforeSwap", () => advanceTiebreakerWeek(season.id)));
    expect((await win(first, first.awayTeamId))?.error).toMatch(/later tiebreaker/i);
    expect((await reopenMatch({}, form({ matchId: first.id })))?.error).toMatch(/later tiebreaker/i);
    expect((await stages(season.id))[0]).toMatchObject({ homeScore: 1, awayScore: 0, winnerTeamId: first.homeTeamId });
  });
});
