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
import { parseSingleTiebreakerSlot } from "@/lib/tiebreaker-format";
import { importGameForMatch } from "@/lib/match-import";
import { projectPlayoffField } from "@/lib/playoff-field";
import { runResultSync } from "@/lib/result-sync-service";
import { setRaceHook } from "@/lib/race-hook";
import { generateRegularSchedule, makeSeason, makeTeam, makeUser, recordMatch } from "./factories";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function setup() {
  const season = await makeSeason({ status: "REGULAR_SEASON" });
  const teams = [];
  for (let i = 0; i < 8; i++) teams.push(await makeTeam(season.id, `Team ${i}`, i));
  const regular = await generateRegularSchedule(season.id);
  for (const match of regular) await recordMatch(match.id, 1, 1);
  await createTiebreakerWeek(season.id);
  return { season, teams, regular };
}

async function stages(seasonId: string) {
  return (await prisma.match.findMany({ where: { seasonId, phase: "TIEBREAKER" } }))
    .sort((a, b) => parseSingleTiebreakerSlot(a.bracketSlot)!.stage - parseSingleTiebreakerSlot(b.bracketSlot)!.stage);
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

describe("weekend BO1 knockout lifecycle", () => {
  it("runs ready branches independently, without breaks, and caps all eight teams at three games", async () => {
    const { season, teams } = await setup();
    const before = await prisma.match.findMany({ where: { seasonId: season.id, phase: "REGULAR" } });
    let slate = await stages(season.id);
    expect(slate).toHaveLength(4);
    const firstWeek = slate[0].week;
    // Pick siblings by immutable node index; DB order must not define the bracket.
    const siblings = slate.sort((a, b) => parseSingleTiebreakerSlot(a.bracketSlot)!.index - parseSingleTiebreakerSlot(b.bracketSlot)!.index);
    await win(siblings[0]);
    expect(await stages(season.id)).toHaveLength(4);
    const started = Date.now();
    await win(siblings[1]);
    slate = await stages(season.id);
    expect(slate).toHaveLength(5);
    const next = slate.find((m) => parseSingleTiebreakerSlot(m.bracketSlot)!.stage === 2)!;
    expect(next.scheduledAt!.getTime()).toBeGreaterThanOrEqual(started);
    expect(next.scheduledAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await reopenMatch({}, form({ matchId: siblings[0].id })))?.error).toMatch(/later tiebreaker/i);
    expect(slate.filter((m) => m.status === "SCHEDULED")).toHaveLength(3);
    for (;;) {
      const pending = (await stages(season.id)).find((m) => m.status === "SCHEDULED");
      if (!pending) break;
      expect((await win(pending))?.error).toBeUndefined();
    }
    await advanceTiebreakerWeek(season.id);
    slate = await stages(season.id);
    expect(slate).toHaveLength(7);
    expect(slate.every((m) => m.bestOf === 1 && m.week === firstWeek && m.status === "COMPLETED")).toBe(true);
    for (const team of teams) expect(slate.filter((m) => m.homeTeamId === team.id || m.awayTeamId === team.id).length).toBeLessThanOrEqual(3);
    const all = await prisma.match.findMany({ where: { seasonId: season.id } });
    expect(projectPlayoffField(teams, all).tiebreakers).toMatchObject({ resolved: true, error: null });
    expect(all.filter((m) => m.phase === "REGULAR")).toEqual(before);
    expect((await prisma.season.findUniqueOrThrow({ where: { id: season.id } })).status).toBe("REGULAR_SEASON");
  });

  it("imports BO1 results, recovers a missed successor on sync, and retains durable game claims", async () => {
    const { season } = await setup();
    const initial = (await stages(season.id)).sort((a, b) => parseSingleTiebreakerSlot(a.bracketSlot)!.index - parseSingleTiebreakerSlot(b.bracketSlot)!.index);
    await win(initial[0]);
    await mockGame(initial[1], 99887661);
    vi.mocked(advanceTiebreakerWeek).mockRejectedValueOnce(new Error("temporary failure"));
    expect(await importGameForMatch(initial[1].id, "99887661")).toMatchObject({ ok: true, decided: true, downstreamPending: true });
    expect(await stages(season.id)).toHaveLength(4);
    const sync = await runResultSync();
    expect(sync.issues).not.toContain("TIEBREAKER_SYNC_FAILED");
    expect(await stages(season.id)).toHaveLength(5);
    await runResultSync();
    expect(await stages(season.id)).toHaveLength(5);
    const game = await prisma.game.findFirstOrThrow({ where: { matchId: initial[1].id } });
    expect((await removeGame({}, form({ gameId: game.id })))?.error).toMatch(/later tiebreaker/i);
    expect(await prisma.dotaMatchClaim.count({ where: { dotaMatchId: "99887661" } })).toBe(1);
  });

  it("leaves an already-started playoff season and every fixture untouched", async () => {
    const { season } = await setup();
    await prisma.season.update({ where: { id: season.id }, data: { status: "PLAYOFFS" } });
    const before = await prisma.match.findMany({ where: { seasonId: season.id } });
    await advanceTiebreakerWeek(season.id);
    await expect(createTiebreakerWeek(season.id)).rejects.toThrow(/regular season/);
    expect(await prisma.match.findMany({ where: { seasonId: season.id } })).toEqual(before);
  });
});
