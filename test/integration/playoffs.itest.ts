import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import {
  advancePlayoffBracket,
  createPlayoffBracket,
} from "@/lib/playoff-service";
import { pickBracketSize } from "@/lib/schedule";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  raceN,
  recordMatch,
} from "./factories";

// The champion ping is a Discord send — stub the sender so it can be counted.
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendDiscordMessage: vi.fn(async () => true),
}));
import { sendDiscordMessage } from "@/lib/discord";
const mockSend = vi.mocked(sendDiscordMessage);

/** Create n teams and play a full regular season so standings are deterministic:
 *  team i beats team j for i < j, making ids[0] the #1 seed. */
async function makeSeededTeams(seasonId: string, n: number) {
  const teams = [];
  for (let i = 0; i < n; i++) teams.push(await makeTeam(seasonId, `Team ${i}`, i));
  const ids = teams.map((t) => t.id);
  const strength = new Map(ids.map((id, i) => [id, i])); // lower index = stronger
  const matches = await generateRegularSchedule(seasonId);
  for (const m of matches) {
    const homeStronger =
      strength.get(m.homeTeamId)! < strength.get(m.awayTeamId)!;
    await recordMatch(m.id, homeStronger ? 2 : 0, homeStronger ? 0 : 2);
  }
  return ids;
}

async function playoffMatches(seasonId: string) {
  return prisma.match.findMany({
    where: { seasonId, phase: { in: ["PLAYOFF", "FINAL"] } },
  });
}

/** Record every open playoff match with the home team winning, advancing after
 *  each result (as recordResult does), until the season is COMPLETE. */
async function driveToChampion(seasonId: string) {
  for (let guard = 0; guard < 10; guard++) {
    const season = await prisma.season.findUniqueOrThrow({
      where: { id: seasonId },
    });
    if (season.status === "COMPLETE") return season;
    const open = await prisma.match.findMany({
      where: {
        seasonId,
        phase: { in: ["PLAYOFF", "FINAL"] },
        status: { not: "COMPLETED" },
      },
    });
    if (open.length === 0) break; // stuck but not complete → bug
    for (const m of open) {
      await recordMatch(m.id, 2, 0); // home (higher seed) wins
      await advancePlayoffBracket(seasonId);
    }
  }
  return prisma.season.findUniqueOrThrow({ where: { id: seasonId } });
}

describe("playoffs bracket + champion (integration)", () => {
  it("seeds 4 teams 1v4/2v3 and crowns the #1 seed", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 4 });
    const ids = await makeSeededTeams(season.id, 4);
    await createPlayoffBracket(season.id);

    const round0 = (await playoffMatches(season.id)).filter((m) =>
      m.bracketSlot?.startsWith("R0"),
    );
    expect(round0).toHaveLength(2);
    const semi0 = round0.find((m) => m.bracketSlot === "R0M0")!;
    expect([semi0.homeTeamId, semi0.awayTeamId]).toEqual([ids[0], ids[3]]);
    const semi1 = round0.find((m) => m.bracketSlot === "R0M1")!;
    expect([semi1.homeTeamId, semi1.awayTeamId]).toEqual([ids[1], ids[2]]);

    const final = await driveToChampion(season.id);
    expect(final.status).toBe("COMPLETE");
    expect(final.championTeamId).toBe(ids[0]);
  });

  it("crowns a champion for an 8-team bracket (QF → SF → F)", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 8 });
    const ids = await makeSeededTeams(season.id, 8);
    await createPlayoffBracket(season.id);
    expect(
      (await playoffMatches(season.id)).filter((m) =>
        m.bracketSlot?.startsWith("R0"),
      ),
    ).toHaveLength(4);
    const final = await driveToChampion(season.id);
    expect(final.status).toBe("COMPLETE");
    expect(final.championTeamId).toBe(ids[0]);
  });

  it("runs a single-match final for 3 teams (bracket size 2)", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 2 });
    const ids = await makeSeededTeams(season.id, 3);
    expect(pickBracketSize(3)).toBe(2);
    await createPlayoffBracket(season.id);
    const pm = await playoffMatches(season.id);
    expect(pm).toHaveLength(1);
    expect(pm[0].phase).toBe("FINAL");
    const final = await driveToChampion(season.id);
    expect(final.championTeamId).toBe(ids[0]);
  });

  it("seeds only the top 4 when 5 teams sign up (non-power-of-two)", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 4 });
    const ids = await makeSeededTeams(season.id, 5);
    expect(pickBracketSize(5)).toBe(4);
    await createPlayoffBracket(season.id);
    const inBracket = (await playoffMatches(season.id))
      .filter((m) => m.bracketSlot?.startsWith("R0"))
      .flatMap((m) => [m.homeTeamId, m.awayTeamId]);
    expect(inBracket).toHaveLength(4);
    expect(inBracket).not.toContain(ids[4]); // lowest seed misses the cut
    const final = await driveToChampion(season.id);
    expect(final.championTeamId).toBe(ids[0]);
  });

  it("uses playoffBestOf for rounds and finalBestOf for the grand final", async () => {
    const season = await makeSeason({
      teamSize: 3,
      minTeams: 4,
      playoffBestOf: 3,
      finalBestOf: 5,
    });
    await makeSeededTeams(season.id, 4);
    await createPlayoffBracket(season.id);

    const semis = (await playoffMatches(season.id)).filter((m) =>
      m.bracketSlot?.startsWith("R0"),
    );
    expect(semis).toHaveLength(2);
    expect(semis.every((m) => m.bestOf === 3 && m.phase === "PLAYOFF")).toBe(true);

    // Play the semifinals so the final is created, then check its length.
    for (const m of semis) {
      await recordMatch(m.id, 2, 0);
      await advancePlayoffBracket(season.id);
    }
    const final = (await playoffMatches(season.id)).find(
      (m) => m.phase === "FINAL",
    );
    expect(final?.bestOf).toBe(5);
  });

  it("refuses to create a bracket with fewer than 2 teams", async () => {
    const season = await makeSeason();
    await makeTeam(season.id, "Solo", 0);
    await expect(createPlayoffBracket(season.id)).rejects.toThrow(/at least 2/);
  });
});

// ---------------------------------------------------------------------------
// Claim guards. advancePlayoffBracket is called from BOTH recordResult and
// every game-import path, so concurrent invocation is routine under auto-sync:
// any visitor's page view can trigger one.
// ---------------------------------------------------------------------------

describe("playoffs — claims fire exactly once under contention", () => {
  it("crowns ONE champion however many callers reach the decided final", async () => {
    mockSend.mockClear();
    const season = await makeSeason({ teamSize: 3 });
    await makeSeededTeams(season.id, 4);
    await createPlayoffBracket(season.id);

    // Play the semis, then the final — but do NOT advance past the final yet.
    for (let round = 0; round < 2; round++) {
      const open = await prisma.match.findMany({
        where: {
          seasonId: season.id,
          phase: { in: ["PLAYOFF", "FINAL"] },
          status: { not: "COMPLETED" },
        },
      });
      if (open.length === 0) break;
      for (const m of open) await recordMatch(m.id, 2, 0);
      if (round === 0) await advancePlayoffBracket(season.id);
    }

    const before = await prisma.season.findUniqueOrThrow({
      where: { id: season.id },
    });
    expect(before.status).toBe("PLAYOFFS");
    expect(before.championTeamId).toBeNull();

    // Every caller sees a decided final; only the one that flips
    // PLAYOFFS→COMPLETE may crown and announce.
    await raceN(4, () => advancePlayoffBracket(season.id));

    const after = await prisma.season.findUniqueOrThrow({
      where: { id: season.id },
    });
    expect(after.status).toBe("COMPLETE");
    expect(after.championTeamId).not.toBeNull();
    expect(
      mockSend.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("champions")),
    ).toHaveLength(1);
  });

  it("builds the next round once, so the final stays reachable", async () => {
    // Two imports deciding the last semi together both see "no next round" —
    // a findFirst matching zero rows takes no predicate lock. A doubled round
    // makes current.length 2 forever, so the crowning branch above becomes
    // unreachable and the season NEVER gets a champion.
    const season = await makeSeason({ teamSize: 3 });
    await makeSeededTeams(season.id, 4);
    await createPlayoffBracket(season.id);
    const semis = await prisma.match.findMany({
      where: { seasonId: season.id, phase: { in: ["PLAYOFF", "FINAL"] } },
    });
    for (const m of semis) await recordMatch(m.id, 2, 0);

    await raceN(4, () => advancePlayoffBracket(season.id));

    const round1 = await prisma.match.findMany({
      where: { seasonId: season.id, bracketSlot: { startsWith: "R1M" } },
    });
    expect(round1).toHaveLength(1); // the final, once
  });
});

// ---------------------------------------------------------------------------
// The playoff-games archive is the ONLY record of a deleted postseason: "Reset
// playoffs" is the sole correction path once a round has advanced, and Game
// cascades with Match. It must only ever GROW — an overwrite destroyed it in
// the most likely repair sequence there is.
// ---------------------------------------------------------------------------
describe("playoffGamesArchive survives repeated resets", () => {
  const archiveOf = async (seasonId: string) => {
    const row = await prisma.setting.findUnique({
      where: { key: `playoffGamesArchive:${seasonId}` },
    });
    return row ? (JSON.parse(row.value) as { dotaMatchId: string }[]) : [];
  };

  async function bracketWithGames(seasonId: string, ids: string[]) {
    const open = await playoffMatches(seasonId);
    for (const [i, m] of open.entries()) {
      await prisma.game.create({
        data: {
          matchId: m.id,
          dotaMatchId: `arch${i}`,
          radiantWin: true,
          winnerTeamId: m.homeTeamId,
          players: "[]",
        },
      });
    }
    return open.length;
  }

  it("archives the ids a reset deletes", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 4 });
    const ids = await makeSeededTeams(season.id, 4);
    await createPlayoffBracket(season.id);
    const n = await bracketWithGames(season.id, ids);
    expect(n).toBeGreaterThan(0);

    await createPlayoffBracket(season.id); // reset

    expect(await archiveOf(season.id)).toHaveLength(n);
  });

  // THE REGRESSION: reset (n archived) → re-import ONE game → reset again.
  // With an overwriting upsert the second reset saw doomedGames.length === 1
  // and wiped the rest, so the postseason became unrecoverable at exactly the
  // moment the admin was trying to repair it.
  it("a second reset with fewer games MERGES rather than replacing", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 4 });
    const ids = await makeSeededTeams(season.id, 4);
    await createPlayoffBracket(season.id);
    const n = await bracketWithGames(season.id, ids);
    await createPlayoffBracket(season.id); // first reset — n ids archived
    expect(await archiveOf(season.id)).toHaveLength(n);

    // The admin re-imports a single game to check something, then resets again.
    const [one] = await playoffMatches(season.id);
    await prisma.game.create({
      data: {
        matchId: one.id,
        dotaMatchId: "arch-late",
        radiantWin: true,
        winnerTeamId: one.homeTeamId,
        players: "[]",
      },
    });
    await createPlayoffBracket(season.id); // second reset

    const after = await archiveOf(season.id);
    expect(after).toHaveLength(n + 1);
    expect(after.map((g) => g.dotaMatchId)).toContain("arch-late");
    expect(after.map((g) => g.dotaMatchId)).toContain("arch0");
  });

  it("never duplicates an id that is archived twice", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 4 });
    const ids = await makeSeededTeams(season.id, 4);
    await createPlayoffBracket(season.id);
    const n = await bracketWithGames(season.id, ids);
    await createPlayoffBracket(season.id);
    // Re-import the SAME ids, then reset again.
    const open = await playoffMatches(season.id);
    for (const [i, m] of open.entries()) {
      await prisma.game.create({
        data: {
          matchId: m.id,
          dotaMatchId: `arch${i}`,
          radiantWin: true,
          winnerTeamId: m.homeTeamId,
          players: "[]",
        },
      });
    }
    await createPlayoffBracket(season.id);

    expect(await archiveOf(season.id)).toHaveLength(n);
  });

  it("tolerates a corrupt archive rather than failing the reset", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 4 });
    const ids = await makeSeededTeams(season.id, 4);
    await createPlayoffBracket(season.id);
    await bracketWithGames(season.id, ids);
    await prisma.setting.create({
      data: { key: `playoffGamesArchive:${season.id}`, value: "{not json" },
    });

    await expect(createPlayoffBracket(season.id)).resolves.not.toThrow();
    expect((await archiveOf(season.id)).length).toBeGreaterThan(0);
  });
});

describe("playoffs — a reset racing an in-flight advance cannot plant a phantom round", () => {
  afterEach(() => setRaceHook(null));

  it("the stale advance no-ops once the reset has torn its inputs down", async () => {
    // The wedge this pins: advance computes winners from pre-transaction
    // reads; Reset deletes the round markers FIRST, so a stale advance's
    // marker create used to SUCCEED and pair pre-reset winners into the
    // brand-new bracket — a phantom R1 that is never COMPLETED, so maxRound
    // points at it forever and no champion can ever be crowned.
    const season = await makeSeason({ teamSize: 3, minTeams: 4 });
    await makeSeededTeams(season.id, 4);
    await createPlayoffBracket(season.id);
    const round0 = (await playoffMatches(season.id)).filter((m) =>
      m.bracketSlot?.startsWith("R0"),
    );
    // Decide both semis WITHOUT advancing — the state an in-flight advance
    // reads just before a reset lands.
    for (const m of round0) await recordMatch(m.id, 2, 0);

    let fired = false;
    setRaceHook(
      onceAt("playoffs.advance.beforeBuild", async () => {
        fired = true;
        await createPlayoffBracket(season.id); // the reset commits mid-advance
      }),
    );
    await advancePlayoffBracket(season.id);
    expect(fired).toBe(true);

    // No phantom round: the fresh bracket is R0-only and fully open.
    const after = await playoffMatches(season.id);
    expect(after.every((m) => m.bracketSlot?.startsWith("R0"))).toBe(true);
    expect(after.every((m) => m.status !== "COMPLETED")).toBe(true);
    expect(
      await prisma.setting.count({
        where: { key: { startsWith: `playoffRoundBuilt:${season.id}:` } },
      }),
    ).toBe(0);

    // And the rebuilt bracket is fully advanceable — the wedge is gone.
    const final = await driveToChampion(season.id);
    expect(final.status).toBe("COMPLETE");
    expect(final.championTeamId).not.toBeNull();
  });

  it("a close-out phase flip mid-advance stops the round build too", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 4 });
    await makeSeededTeams(season.id, 4);
    await createPlayoffBracket(season.id);
    const round0 = (await playoffMatches(season.id)).filter((m) =>
      m.bracketSlot?.startsWith("R0"),
    );
    for (const m of round0) await recordMatch(m.id, 2, 0);

    setRaceHook(
      onceAt("playoffs.advance.beforeBuild", async () => {
        await prisma.season.update({
          where: { id: season.id },
          data: { status: "COMPLETE" },
        });
      }),
    );
    await advancePlayoffBracket(season.id);

    // No round was built into the COMPLETE season.
    expect(
      (await playoffMatches(season.id)).filter((m) =>
        m.bracketSlot?.startsWith("R1"),
      ),
    ).toHaveLength(0);
  });
});

describe("playoffs — a reset bracket stays advanceable to a champion", () => {
  it("reset AFTER an advanced round, then drive the rebuilt bracket to COMPLETE", async () => {
    // Pins playoff-service's round-marker cleanup (the deleteMany inside the
    // reset transaction): without it the rebuilt bracket's R1 marker create
    // P2002s forever — silently swallowed — and every advance no-ops, a
    // permanent dead end. Deleting that cleanup line turns this red.
    const season = await makeSeason({ teamSize: 3, minTeams: 4 });
    const ids = await makeSeededTeams(season.id, 4);
    await createPlayoffBracket(season.id);
    // Play R0 and build R1, so the R1 marker exists.
    const round0 = (await playoffMatches(season.id)).filter((m) =>
      m.bracketSlot?.startsWith("R0"),
    );
    for (const m of round0) {
      await recordMatch(m.id, 2, 0);
      await advancePlayoffBracket(season.id);
    }
    expect(
      (await playoffMatches(season.id)).some((m) =>
        m.bracketSlot?.startsWith("R1"),
      ),
    ).toBe(true);

    // Reset — seeding was wrong, say — then run the whole bracket again.
    await createPlayoffBracket(season.id);
    const final = await driveToChampion(season.id);
    expect(final.status).toBe("COMPLETE");
    expect(final.championTeamId).toBe(ids[0]);
  });
});
