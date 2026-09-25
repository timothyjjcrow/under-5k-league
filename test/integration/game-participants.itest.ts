import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { backfillGameParticipants, fetchGamesForPlayers, gamePlayersDigest, PARTICIPANT_VERSION,
  participantUncoveredWhere, rebuildGameParticipants } from "@/lib/game-participants";
import { correctGameIdentity } from "@/lib/game-identity-correction";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { SETTING_KEYS, honorsAnnouncedKey } from "@/lib/settings";
import { makeSeason, makeTeam, makeUser, ON_POSTGRES } from "./factories";

async function fixture() {
  const season = await makeSeason();
  const home = await makeTeam(season.id, "Home", 0), away = await makeTeam(season.id, "Away", 1);
  const match = await prisma.match.create({ data: { seasonId: season.id, week: 1, homeTeamId: home.id, awayTeamId: away.id } });
  const lines = Array.from({ length: 10 }, (_, i) => ({ userId: `player-${i}`, teamId: i < 5 ? home.id : away.id,
    accountId: 4294967200 + i, heroId: i + 1, isRadiant: i < 5, kills: i, deaths: 2, assists: 3,
    gpm: 450.25, benchmarks: { gold_per_min: { raw: 450.25, pct: 0.7 } } }));
  const game = await prisma.game.create({ data: { matchId: match.id, dotaMatchId: "123456", startTime: 1000,
    radiantWin: true, radiantTeamId: home.id, direTeamId: away.id, players: JSON.stringify(lines) } });
  return { season, home, away, match, lines, game };
}
async function rebuild(game: { id: string; players: string }) {
  return prisma.$transaction((tx) => rebuildGameParticipants(tx, { gameId: game.id, expectedPlayers: game.players }));
}
afterEach(() => { vi.unstubAllEnvs(); setRaceHook(null); vi.restoreAllMocks(); });

describe("participant source projection", () => {
  it("stores normalized values and exact proof, without user/team foreign keys", async () => {
    const { game } = await fixture();
    expect(await rebuild(game)).toBe(true);
    const current = await prisma.game.findUniqueOrThrow({ where: { id: game.id } });
    expect(current).toMatchObject({ participantSource: game.players, participantVersion: PARTICIPANT_VERSION, participantComplete: true });
    const rows = await prisma.gameParticipant.findMany({ where: { gameId: game.id }, orderBy: { sourceLineIndex: "asc" } });
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({ sourceLineIndex: 0, userId: "player-0", accountId: 4294967200, gpm: 450.25 });
    expect(JSON.parse(rows[0].benchmarks!)).toEqual({ gold_per_min: { raw: 450.25, pct: 0.7 } });
    expect(await prisma.game.count({ where: participantUncoveredWhere() })).toBe(0);
  });
  it("reads null proof, indexed proof, changed old-binary source, and stale versions equivalently", async () => {
    const { game, lines, season } = await fixture();
    expect((await fetchGamesForPlayers(["player-0"])).map((g) => g.id)).toEqual([game.id]);
    await rebuild(game);
    expect((await fetchGamesForPlayers(["player-0"], season.id)).map((g) => g.id)).toEqual([game.id]);
    lines[0].userId = "changed";
    await prisma.game.update({ where: { id: game.id }, data: { players: JSON.stringify(lines) } });
    expect(await fetchGamesForPlayers(["player-0"])).toEqual([]);
    expect((await fetchGamesForPlayers(["changed"])).map((g) => g.id)).toEqual([game.id]);
    await prisma.game.update({ where: { id: game.id }, data: { participantVersion: 0 } });
    expect((await fetchGamesForPlayers(["changed"]))).toHaveLength(1);
    expect(await fetchGamesForPlayers(["changed"], "another-season")).toEqual([]);
  });
  it("narrows covered JSON but still checks unrelated uncovered data", async () => {
    const { game, lines } = await fixture(); await rebuild(game);
    await prisma.game.create({ data: { matchId: game.matchId, dotaMatchId: "other", radiantWin: false,
      players: JSON.stringify(lines.map((p) => ({ ...p, userId: `other-${p.userId}` }))) } });
    const spy = vi.spyOn(prisma.game, "findMany");
    expect((await fetchGamesForPlayers(["player-0"]))).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ where: { AND: expect.any(Array) }, select: { players: true } });
    spy.mockClear(); expect(await fetchGamesForPlayers([])).toEqual([]); expect(spy).not.toHaveBeenCalled();
  });
  it("executes the indexed and uncovered branches in one actual SQL statement", async () => {
    const { game } = await fixture(); await rebuild(game);
    const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    const queries: string[] = [];
    client.$on("query", (event) => { queries.push(event.query); });
    try {
      expect((await fetchGamesForPlayers(["player-0"], undefined, client))).toHaveLength(1);
      expect(queries.filter((query) => /^SELECT\b/i.test(query.trim()))).toHaveLength(1);
      expect(queries[0]).toContain("GameParticipant");
    } finally { await client.$disconnect(); }
  });
  it("keeps original source offsets and incomplete games out of public rollups", async () => {
    const { game, lines } = await fixture();
    const players = JSON.stringify([null, ...lines]);
    await prisma.game.update({ where: { id: game.id }, data: { players } });
    await rebuild({ ...game, players });
    expect((await prisma.gameParticipant.findMany({ where: { gameId: game.id }, orderBy: { sourceLineIndex: "asc" } }))[0].sourceLineIndex).toBe(1);
    expect(await fetchGamesForPlayers(["player-0"])).toEqual([]);
  });
  it("rolls proof and children back together when child replacement fails", async () => {
    const { game } = await fixture();
    setRaceHook(onceAt("gameParticipants.beforeRows", async () => { throw new Error("injected"); }));
    await expect(rebuild(game)).rejects.toThrow("injected");
    expect(await prisma.gameParticipant.count()).toBe(0);
    expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).participantSource).toBeNull();
  });
  it("stale rebuild cannot delete a newer projection, and game deletion cascades", async () => {
    const { game, lines } = await fixture();
    lines[0].userId = "new"; const players = JSON.stringify(lines);
    await prisma.game.update({ where: { id: game.id }, data: { players } });
    await rebuild({ ...game, players });
    expect(await rebuild(game)).toBe(false);
    expect(await prisma.gameParticipant.count({ where: { userId: "new" } })).toBe(1);
    await prisma.game.delete({ where: { id: game.id } });
    expect(await prisma.gameParticipant.count()).toBe(0);
  });
});

describe("bounded backfill", () => {
  it("resumes batches, covers malformed sources once, and never changes public revision", async () => {
    const { game } = await fixture();
    await prisma.game.create({ data: { matchId: game.matchId, dotaMatchId: "malformed", radiantWin: true, players: "bad" } });
    const first = await backfillGameParticipants({ limit: 1 });
    expect(first).toMatchObject({ scanned: 1, rebuilt: 1, remaining: 1 });
    const second = await backfillGameParticipants({ limit: 1, cursor: first.nextCursor! });
    expect(second).toMatchObject({ scanned: 1, rebuilt: 1, remaining: 0 });
    expect(first.invalid + second.invalid).toBe(1);
    expect((await backfillGameParticipants()).scanned).toBe(0);
    expect(await prisma.setting.findUnique({ where: { key: SETTING_KEYS.PUBLIC_GAME_REVISION } })).toBeNull();
  });
  it("respects deadlines and loses cleanly to an edited/deleted source", async () => {
    const { game } = await fixture();
    expect(await backfillGameParticipants({ deadlineMs: Date.now() - 1 })).toMatchObject({ scanned: 0, remaining: 1, deadlineReached: true });
    setRaceHook(onceAt("gameParticipants.backfillBeforeWrite", async () => { await prisma.game.delete({ where: { id: game.id } }); }));
    expect(await backfillGameParticipants()).toMatchObject({ scanned: 1, changed: 1, remaining: 0 });
  });
});

describe("audited game identity correction", () => {
  async function correction() {
    const data = await fixture(); const admin = await makeUser("Admin", "ADMIN"), replacement = await makeUser("Replacement");
    await rebuild(data.game);
    return { ...data, admin, replacement, input: { actorId: admin.id, gameId: data.game.id, sourceLineIndex: 0,
      expectedSourceDigest: gamePlayersDigest(data.game.players), userId: replacement.id, teamId: data.home.id, reason: "Verified the recorded account" } };
  }
  it("changes source/projection/audit/revision together and invalidates prior honors", async () => {
    const { game, match, input } = await correction();
    await prisma.setting.create({ data: { key: honorsAnnouncedKey(match.seasonId, match.week), value: "sent" } });
    expect((await correctGameIdentity(input)).changed).toBe(true);
    const updated = await prisma.game.findUniqueOrThrow({ where: { id: game.id } });
    expect(JSON.parse(updated.players)[0]).toMatchObject({ userId: input.userId, teamId: input.teamId, accountId: 4294967200 });
    expect(updated.participantSource).toBe(updated.players);
    expect(await prisma.gameParticipant.count({ where: { userId: input.userId } })).toBe(1);
    const audit = await prisma.adminAction.findFirstOrThrow({ where: { action: "correctGameIdentity" } });
    expect(JSON.parse(audit.detailsJson!)).toMatchObject({ before: { userId: "player-0" }, after: { userId: input.userId }, reason: input.reason });
    expect(await prisma.setting.findUnique({ where: { key: SETTING_KEYS.PUBLIC_GAME_REVISION } })).not.toBeNull();
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: honorsAnnouncedKey(match.seasonId, match.week) } })).value).toMatch(/^stale:/);
  });
  it("audit failure rolls back source, participants and public revision", async () => {
    const { game, input } = await correction();
    setRaceHook(onceAt("gameIdentity.beforeAudit", async () => { throw new Error("audit unavailable"); }));
    await expect(correctGameIdentity(input)).rejects.toThrow("audit unavailable");
    expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).players).toBe(game.players);
    expect(await prisma.gameParticipant.count({ where: { userId: "player-0" } })).toBe(1);
    expect(await prisma.adminAction.count()).toBe(0);
    expect(await prisma.setting.findUnique({ where: { key: SETTING_KEYS.PUBLIC_GAME_REVISION } })).toBeNull();
  });
  it("rejects revoked admin, stale source, wrong side and a missing reason", async () => {
    const { input, away } = await correction();
    await expect(correctGameIdentity({ ...input, reason: " " })).rejects.toThrow("reason");
    await expect(correctGameIdentity({ ...input, teamId: away.id })).rejects.toThrow("fixture side");
    await expect(correctGameIdentity({ ...input, expectedSourceDigest: "f".repeat(64) })).rejects.toThrow("changed");
    await prisma.user.update({ where: { id: input.actorId }, data: { role: "USER" } });
    await expect(correctGameIdentity(input)).rejects.toThrow("administrator");
  });
  it("allows the current production allowlist for correction and backfill without changing a stored USER role", async () => {
    const { input, admin, game } = await correction();
    await prisma.user.update({ where: { id: admin.id }, data: { role: "USER" } });
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("ADMIN_STEAM_IDS", ` ${admin.steamId} `);
    expect((await correctGameIdentity(input)).changed).toBe(true);
    await prisma.game.update({ where: { id: game.id }, data: { participantSource: null } });
    expect(await backfillGameParticipants({ actorId: admin.id })).toMatchObject({ rebuilt: 1, remaining: 0 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe("USER");
  });
  it("rejects a stale stored ADMIN excluded from the current allowlist, including direct backfill", async () => {
    const { input, game } = await correction();
    await prisma.game.update({ where: { id: game.id }, data: { participantSource: null } });
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("ADMIN_STEAM_IDS", "76561199999999999");
    await expect(correctGameIdentity(input)).rejects.toThrow("administrator");
    await expect(backfillGameParticipants({ actorId: input.actorId })).rejects.toThrow("administrator");
    vi.stubEnv("ADMIN_STEAM_IDS", "");
    await expect(correctGameIdentity(input)).rejects.toThrow("administrator");
    await expect(backfillGameParticipants({ actorId: input.actorId })).rejects.toThrow("administrator");
    expect(await prisma.adminAction.count()).toBe(0);
    expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } }))).toMatchObject({ players: game.players, participantSource: null });
  });
  it.skipIf(!ON_POSTGRES)("a local administrator demoted after the read cannot claim a correction", async () => {
    const { input, game } = await correction();
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("ADMIN_STEAM_IDS", "");
    setRaceHook(onceAt("gameIdentity.beforeClaim", async () => {
      await prisma.user.update({ where: { id: input.actorId }, data: { role: "USER" } });
    }));
    await expect(correctGameIdentity(input)).rejects.toThrow();
    expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).players).toBe(game.players);
    expect(await prisma.adminAction.count()).toBe(0);
  });
  it.skipIf(!ON_POSTGRES)("a concurrent old-binary edit wins over a stale correction transaction", async () => {
    const { input, game, lines } = await correction();
    const newerPlayers = JSON.stringify(lines.map((line, i) => i === 0 ? { ...line, userId: "concurrent" } : line));
    setRaceHook(onceAt("gameIdentity.beforeClaim", async () => {
      await prisma.game.update({ where: { id: game.id }, data: { players: newerPlayers } });
    }));
    await expect(correctGameIdentity(input)).rejects.toThrow();
    expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).players).toBe(newerPlayers);
    expect(await prisma.adminAction.count()).toBe(0);
    expect((await fetchGamesForPlayers(["concurrent"]))).toHaveLength(1);
  });
});
