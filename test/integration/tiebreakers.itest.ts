import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTiebreakerWeek, clearTiebreakerWeek, advanceTiebreakerWeek } from "@/lib/tiebreaker-service";
import { createPlayoffBracket, returnToRegularSeason } from "@/lib/playoff-service";
import { projectPlayoffField } from "@/lib/playoff-field";
import { playoffSetupRevision } from "@/lib/playoff-command";
import { computeStandings } from "@/lib/standings";
import { tiebreakerGamesArchiveKey } from "@/lib/settings";
import { generateRegularSchedule, makeSeason, makeTeam, recordMatch } from "./factories";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(), getSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/discord", async (original) => ({
  ...(await original<typeof import("@/lib/discord")>()),
  sendDiscordMessage: vi.fn(async () => true), getWebhookUrl: vi.fn(async () => ""),
}));
import { requireAdmin } from "@/lib/auth";
import { scheduleTiebreakerWeek, resetTiebreakerWeek } from "@/app/actions/tiebreakers";

async function state(seasonId: string) {
  const [season, teams, matches] = await Promise.all([
    prisma.season.findUniqueOrThrow({ where: { id: seasonId } }),
    prisma.team.findMany({ where: { seasonId } }),
    prisma.match.findMany({ where: { seasonId }, include: {
      games: true, availability: true, standins: true, predictions: true, reschedules: true,
    } }),
  ]);
  return { season, teams, matches, revision: playoffSetupRevision({ season, teams, matches }) };
}
async function setup(count = 5, tieAll = false) {
  const season = await makeSeason({ status: "REGULAR_SEASON" });
  const teams = [];
  for (let i = 0; i < count; i++) teams.push(await makeTeam(season.id, `Team ${i}`, i));
  const strength = new Map(teams.map((t, i) => [t.id, i]));
  const regular = await generateRegularSchedule(season.id);
  for (const m of regular) {
    const home = strength.get(m.homeTeamId)!;
    const away = strength.get(m.awayTeamId)!;
    if (tieAll || Math.min(home, away) === count - 2) await recordMatch(m.id, 1, 1);
    else await recordMatch(m.id, home < away ? 2 : 0, home < away ? 0 : 2);
  }
  return { season, teams, regular };
}
function form(seasonId: string, expectedRevision: string) {
  const f = new FormData(); f.set("seasonId", seasonId); f.set("expectedRevision", expectedRevision); return f;
}

describe("tiebreaker week and playoff handoff", () => {
  it("blocks the arbitrary last seed, schedules BO1, and seeds its winner the following week", async () => {
    const { season, teams, regular } = await setup();
    await expect(createPlayoffBracket(season.id)).rejects.toThrow(/tiebreaker week/);
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(regular.length);
    const snapshot = await state(season.id);
    const result = await createTiebreakerWeek(season.id, snapshot.revision);
    expect(result).toMatchObject({ matchCount: 1, week: Math.max(...regular.map((m) => m.week)) + 1 });
    const tb = await prisma.match.findFirstOrThrow({ where: { seasonId: season.id, phase: "TIEBREAKER" } });
    expect(tb.bestOf).toBe(1);
    await expect(createPlayoffBracket(season.id)).rejects.toThrow(/tiebreaker week/);
    await expect(createTiebreakerWeek(season.id)).rejects.toThrow(/Finish the scheduled/);
    await recordMatch(tb.id, 0, 1);
    const ready = await state(season.id);
    expect(projectPlayoffField(ready.teams, ready.matches).seededTeamIds[3]).toBe(tb.awayTeamId);
    await createPlayoffBracket(season.id, { intent: "start", expectedSeasonStatus: "REGULAR_SEASON", expectedRevision: ready.revision });
    const seeded = await state(season.id);
    expect(seeded.season.status).toBe("PLAYOFFS");
    expect(seeded.matches.filter((m) => m.phase === "PLAYOFF").every((m) => m.week === tb.week + 1)).toBe(true);
    expect(seeded.matches.filter((m) => m.phase === "PLAYOFF").flatMap((m) => [m.homeTeamId, m.awayTeamId])).toContain(tb.awayTeamId);
    expect(seeded.matches.find((m) => m.id === tb.id)?.status).toBe("COMPLETED");
    // Both raw and public regular points remain untouched by the extra games.
    expect(computeStandings(teams.map((t) => t.id), seeded.matches).map((r) => r.points))
      .toEqual(computeStandings(teams.map((t) => t.id), snapshot.matches).map((r) => r.points));
    await expect(clearTiebreakerWeek(season.id)).rejects.toThrow(/regular season/);
    await returnToRegularSeason(season.id, { expectedSeasonStatus: "PLAYOFFS", expectedRevision: seeded.revision });
    expect(await prisma.match.count({ where: { id: tb.id } })).toBe(1);
    await createPlayoffBracket(season.id);
    expect(await prisma.match.count({ where: { id: tb.id } })).toBe(1);
  });

  it("settles three teams for two places with one BO1 and a published qualifying bye", async () => {
    const { season } = await setup(3, true);
    const first = await createTiebreakerWeek(season.id);
    expect(first).toMatchObject({ matchCount: 1, untimedCount: 1 });
    await expect(createPlayoffBracket(season.id)).rejects.toThrow(/tiebreaker week/);
    for (let game = 1; game <= 1; game++) {
      const open = await prisma.match.findMany({ where: { seasonId: season.id, phase: "TIEBREAKER", status: "SCHEDULED" } });
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ week: first.week, bestOf: 1 });
      await recordMatch(open[0].id, game === 4 ? 0 : 1, game === 4 ? 1 : 0);
      await advanceTiebreakerWeek(season.id);
      await advanceTiebreakerWeek(season.id);
    }
    expect(await prisma.match.count({ where: { seasonId: season.id, phase: "TIEBREAKER" } })).toBe(1);
    await createPlayoffBracket(season.id);
    expect(await prisma.match.findFirstOrThrow({ where: { seasonId: season.id, phase: "FINAL" } }))
      .toMatchObject({ week: first.week + 1 });
  });

  it("refuses incomplete seasons, inactive seasons, stale forms and duplicate submissions", async () => {
    const { season, regular } = await setup();
    await prisma.match.update({ where: { id: regular[0].id }, data: { status: "SCHEDULED" } });
    await expect(createTiebreakerWeek(season.id)).rejects.toThrow(/every regular-season/);
    await prisma.match.update({ where: { id: regular[0].id }, data: { status: "COMPLETED" } });
    const snapshot = await state(season.id);
    const first = await scheduleTiebreakerWeek(null, form(season.id, snapshot.revision));
    expect(first?.error).toBeUndefined();
    const second = await scheduleTiebreakerWeek(null, form(season.id, snapshot.revision));
    expect(second?.error).toMatch(/changed/);
    expect(await prisma.match.count({ where: { seasonId: season.id, phase: "TIEBREAKER" } })).toBe(1);
    const refreshed = await state(season.id);
    await prisma.season.update({ where: { id: season.id }, data: { isActive: false } });
    expect((await resetTiebreakerWeek(null, form(season.id, refreshed.revision)))?.error).toMatch(/active regular season/);
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("not admin"));
    expect((await scheduleTiebreakerWeek(null, form(season.id, refreshed.revision)))?.error).toBe("Not authorized");
  });

  it("archives imported IDs and releases their claims on reset, preserving regular results", async () => {
    const { season } = await setup();
    await createTiebreakerWeek(season.id);
    const tb = await prisma.match.findFirstOrThrow({ where: { seasonId: season.id, phase: "TIEBREAKER" } });
    await prisma.game.create({ data: { matchId: tb.id, dotaMatchId: "7890123456", radiantWin: true, winnerTeamId: tb.homeTeamId } });
    await prisma.dotaMatchClaim.create({ data: { dotaMatchId: "7890123456", kind: "LEAGUE", contextId: tb.id } });
    const before = await state(season.id);
    expect(await clearTiebreakerWeek(season.id, before.revision)).toMatchObject({ matchCount: 1, removedGameCount: 1 });
    expect(await prisma.game.count({ where: { matchId: tb.id } })).toBe(0);
    expect(await prisma.dotaMatchClaim.count({ where: { dotaMatchId: "7890123456" } })).toBe(0);
    const archive = await prisma.setting.findUniqueOrThrow({ where: { key: tiebreakerGamesArchiveKey(season.id) } });
    expect(JSON.parse(archive.value)).toEqual([{ dotaMatchId: "7890123456", slot: tb.bracketSlot, week: tb.week }]);
    expect((await state(season.id)).matches).toHaveLength(before.matches.length - 1);
    await createTiebreakerWeek(season.id);
    expect(await prisma.match.count({ where: { seasonId: season.id, phase: "TIEBREAKER" } })).toBe(1);
  });

  it("refuses reset when a new dependent row was not in the reviewed confirmation", async () => {
    const { season, teams } = await setup();
    await createTiebreakerWeek(season.id);
    const snapshot = await state(season.id);
    const tb = snapshot.matches.find((m) => m.phase === "TIEBREAKER")!;
    await prisma.prediction.create({ data: { matchId: tb.id, userId: teams[0].captainId, pickedTeamId: tb.homeTeamId } });
    await expect(clearTiebreakerWeek(season.id, snapshot.revision)).rejects.toThrow(/activity changed/);
    expect(await prisma.prediction.count({ where: { matchId: tb.id } })).toBe(1);
    expect(await prisma.match.count({ where: { id: tb.id } })).toBe(1);
  });

  it("dates playoffs after a tiebreaker that was moved beyond its original league week", async () => {
    const { season } = await setup();
    const anchor = new Date(Date.now() + 86400_000);
    await prisma.season.update({ where: { id: season.id }, data: { firstMatchNight: anchor } });
    await createTiebreakerWeek(season.id);
    const tb = await prisma.match.findFirstOrThrow({ where: { seasonId: season.id, phase: "TIEBREAKER" } });
    expect(tb.scheduledAt?.getTime()).toBeGreaterThan(anchor.getTime());
    const movedKickoff = new Date(anchor.getTime() + 100 * 86400_000);
    await prisma.match.update({ where: { id: tb.id }, data: { scheduledAt: movedKickoff } });
    await recordMatch(tb.id, 1, 0);
    await createPlayoffBracket(season.id);
    const playoff = await prisma.match.findFirstOrThrow({ where: { seasonId: season.id, phase: "PLAYOFF" } });
    expect(playoff.scheduledAt!.getTime()).toBeGreaterThan(movedKickoff.getTime());
    expect(playoff.week).toBe(tb.week + 1);
  });

  it("keeps the original random draw when the same three-team week is reset", async () => {
    const { season } = await setup(3, true);
    await createTiebreakerWeek(season.id);
    const first = await prisma.match.findFirstOrThrow({ where: { seasonId: season.id, phase: "TIEBREAKER" } });
    await clearTiebreakerWeek(season.id);
    await createTiebreakerWeek(season.id);
    const rebuilt = await prisma.match.findFirstOrThrow({ where: { seasonId: season.id, phase: "TIEBREAKER" } });
    expect(rebuilt).toMatchObject({ homeTeamId: first.homeTeamId, awayTeamId: first.awayTeamId, bracketSlot: first.bracketSlot });
    expect(await prisma.setting.count({ where: { key: { startsWith: `tiebreakerDraw:${season.id}:` } } })).toBe(1);
  });
});
