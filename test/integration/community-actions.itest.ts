/**
 * The two community-feature mutations (fantasy roster, pick'em) carried their
 * locks as read-time checks only — the exact class CLAUDE.md's concurrency
 * rule 1 names, with auto-sync (any page view) as the rival that flips the
 * state mid-request. Both locks now live at the write: Fantasy claims the
 * same Season row first import stamps, and Pick'em conditionally claims the
 * still-open Match before upserting its child row. PostgreSQL Serializable
 * does not turn a parent read into a lock, so the Postgres-only seams below
 * prove those shared-row claims.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { saveFantasyRoster } from "@/app/actions/fantasy";
import { savePrediction } from "@/app/actions/pickem";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import {
  makePlayer,
  makeSeason,
  makeTeam,
  makeUser,
  ON_POSTGRES,
  resetDb,
  sessionFor,
} from "./factories";

const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    for (const item of Array.isArray(v) ? v : [v]) f.append(k, item);
  }
  return f;
};
const fantasyFd = (seasonId: string, picks: string[]) =>
  fd({ expectedSeasonId: seasonId, picks });
function barrierAt(label: string, parties: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async (seen: string) => {
    if (seen !== label) return;
    arrived += 1;
    if (arrived === parties) release();
    await gate;
  };
}
const empty: ActionResult = {};

beforeEach(resetDb);
afterEach(() => setRaceHook(null));

/** A drafted season: one team, five rostered players with registrations. */
async function draftedSeason() {
  const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
  const team = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  const playerIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const p = await makePlayer(season.id, `P${i}`, 3000);
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: team.id, userId: p.id, price: 1 },
    });
    playerIds.push(p.id);
  }
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: team.id,
      awayTeamId: away.id,
      scheduledAt: new Date(Date.now() + 24 * 3600_000),
    },
  });
  const manager = await makeUser("Manager");
  vi.mocked(requireUser).mockResolvedValue(sessionFor(manager));
  return { season, team, away, match, playerIds, manager };
}

const stageGame = (matchId: string, id: string) =>
  prisma.game.create({
    data: {
      matchId,
      dotaMatchId: id,
      radiantWin: true,
      players: "[]",
    },
  });

describe("saveFantasyRoster — lifecycle and first import share a row claim", () => {
  it.each([
    DRAFT_STATUS.NOT_STARTED,
    DRAFT_STATUS.IN_PROGRESS,
    DRAFT_STATUS.PAUSED,
  ])("refuses while the auction is %s", async (draftStatus) => {
    const { season, playerIds } = await draftedSeason();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.DRAFT },
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: draftStatus },
    });

    const res = await saveFantasyRoster(empty, fantasyFd(season.id, playerIds));

    expect(res?.error).toMatch(/auction is complete/i);
    expect(await prisma.fantasyPick.count()).toBe(0);
  });

  it("opens in the DRAFT phase once the auction is complete", async () => {
    const { season, playerIds } = await draftedSeason();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.DRAFT },
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });

    const res = await saveFantasyRoster(empty, fantasyFd(season.id, playerIds));

    expect(res?.error).toBeUndefined();
    expect(await prisma.fantasyPick.count()).toBe(5);
  });

  it("refuses once a game exists, and writes no picks", async () => {
    const { season, match, playerIds } = await draftedSeason();
    await stageGame(match.id, "900001");

    const res = await saveFantasyRoster(empty, fantasyFd(season.id, playerIds));

    expect(res?.error).toMatch(/locked/i);
    expect(await prisma.fantasyPick.count()).toBe(0);
  });

  it("stays locked after the imported game is removed", async () => {
    const { season, match, playerIds } = await draftedSeason();
    const game = await stageGame(match.id, "900001-durable");
    await prisma.season.update({
      where: { id: season.id },
      data: { fantasyLockedAt: new Date() },
    });
    await prisma.game.delete({ where: { id: game.id } });

    const res = await saveFantasyRoster(empty, fantasyFd(season.id, playerIds));

    expect(res?.error).toMatch(/locked/i);
    expect(await prisma.fantasyPick.count()).toBe(0);
  });

  it("saves normally while no game is imported", async () => {
    const { season, playerIds } = await draftedSeason();

    const res = await saveFantasyRoster(empty, fantasyFd(season.id, playerIds));

    expect(res?.error).toBeUndefined();
    expect(await prisma.fantasyPick.count()).toBe(5);
  });

  it("refuses a stale form after the active season rolls over", async () => {
    const { season, playerIds } = await draftedSeason();
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });
    const nextSeason = await makeSeason({
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    const nextTeam = await makeTeam(nextSeason.id, "Next Home", 0);
    await prisma.registration.createMany({
      data: playerIds.map((userId) => ({
        seasonId: nextSeason.id,
        userId,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 3000,
      })),
    });
    await prisma.teamMember.createMany({
      data: playerIds.map((userId) => ({
        seasonId: nextSeason.id,
        teamId: nextTeam.id,
        userId,
        price: 1,
      })),
    });

    const res = await saveFantasyRoster(empty, fantasyFd(season.id, playerIds));

    expect(res?.error).toMatch(/active season changed/i);
    expect(await prisma.fantasyRoster.count()).toBe(0);
  });

  it.skipIf(!ON_POSTGRES)(
    "allows simultaneous valid saves from different managers",
    async () => {
      const { season, playerIds, manager } = await draftedSeason();
      const other = await makeUser("Other fantasy manager");
      vi.mocked(requireUser)
        .mockReset()
        .mockResolvedValueOnce(sessionFor(manager))
        .mockResolvedValueOnce(sessionFor(other));
      setRaceHook(barrierAt("fantasy.save.afterLockRead", 2));

      const results = await Promise.all([
        saveFantasyRoster(empty, fantasyFd(season.id, playerIds)),
        saveFantasyRoster(empty, fantasyFd(season.id, playerIds)),
      ]);

      expect(results.map((result) => result?.error)).toEqual([
        undefined,
        undefined,
      ]);
      expect(await prisma.fantasyRoster.count()).toBe(2);
      expect(await prisma.fantasyPick.count()).toBe(10);
    },
  );

  it.skipIf(!ON_POSTGRES)(
    "loses cleanly when the first game commits after its lock snapshot",
    async () => {
      const { season, match, playerIds } = await draftedSeason();
      setRaceHook(
        onceAt("fantasy.save.afterLockRead", async () => {
          await prisma.$transaction([
            prisma.season.update({
              where: { id: season.id },
              data: { fantasyLockedAt: new Date() },
            }),
            stageGame(match.id, "900001-raced"),
          ]);
        }),
      );

      const res = await saveFantasyRoster(
        empty,
        fantasyFd(season.id, playerIds),
      );

      expect(res?.error).toMatch(/changed|locked/i);
      expect(await prisma.fantasyRoster.count()).toBe(0);
      expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(1);
    },
  );

  it.skipIf(!ON_POSTGRES)(
    "never saves after the completed auction is reopened at the transaction seam",
    async () => {
      const { season, playerIds } = await draftedSeason();
      await prisma.season.update({
        where: { id: season.id },
        data: { status: SEASON_STATUS.DRAFT },
      });
      const draft = await prisma.draft.create({
        data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
      });
      setRaceHook(
        onceAt("fantasy.save.afterLockRead", async () => {
          await prisma.draft.update({
            where: { id: draft.id },
            data: { status: DRAFT_STATUS.IN_PROGRESS },
          });
        }),
      );

      const res = await saveFantasyRoster(
        empty,
        fantasyFd(season.id, playerIds),
      );

      expect(res?.error).toMatch(/changed|auction|locked/i);
      expect(await prisma.fantasyRoster.count()).toBe(0);
    },
  );
});

describe("savePrediction — phase and match locks share the write transaction", () => {
  it.each([
    [SEASON_STATUS.SIGNUPS, null],
    [SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS],
    [SEASON_STATUS.COMPLETE, DRAFT_STATUS.COMPLETE],
  ])(
    "refuses in %s / %s even when a scheduled match exists",
    async (status, draftStatus) => {
      const { season, match, team } = await draftedSeason();
      await prisma.season.update({
        where: { id: season.id },
        data: { status },
      });
      if (draftStatus) {
        await prisma.draft.create({
          data: { seasonId: season.id, status: draftStatus },
        });
      }

      const res = await savePrediction(
        empty,
        fd({ matchId: match.id, pickedTeamId: team.id }),
      );

      expect(res?.error).toMatch(/after the auction|closed|current phase/i);
      expect(await prisma.prediction.count()).toBe(0);
    },
  );

  it("opens during DRAFT once the auction is complete", async () => {
    const { season, match, team } = await draftedSeason();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.DRAFT },
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });

    const res = await savePrediction(
      empty,
      fd({ matchId: match.id, pickedTeamId: team.id }),
    );

    expect(res?.error).toBeUndefined();
    expect(await prisma.prediction.count()).toBe(1);
  });
  it("a LIVE match refuses a CHANGED pick and leaves the old one standing", async () => {
    // Kills the match-WHERE mutant: without predictionOpenWhere on the
    // updateMany, this post-information change lands.
    const { match, team, away, manager } = await draftedSeason();
    await prisma.prediction.create({
      data: { matchId: match.id, userId: manager.id, pickedTeamId: team.id },
    });
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.LIVE },
    });

    const res = await savePrediction(
      empty,
      fd({ matchId: match.id, pickedTeamId: away.id }),
    );

    expect(res?.error).toMatch(/locked/i);
    const row = await prisma.prediction.findUniqueOrThrow({
      where: { matchId_userId: { matchId: match.id, userId: manager.id } },
    });
    expect(row.pickedTeamId).toBe(team.id); // unchanged
  });

  it("a LIVE match refuses a FIRST pick and writes no row", async () => {
    // Kills the create-leg mutant: without the re-read before create, a
    // post-information first pick lands.
    const { match, away } = await draftedSeason();
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.LIVE },
    });

    const res = await savePrediction(
      empty,
      fd({ matchId: match.id, pickedTeamId: away.id }),
    );

    expect(res?.error).toMatch(/locked/i);
    expect(await prisma.prediction.count()).toBe(0);
  });

  it("an open match takes the first pick and a changed pick", async () => {
    const { match, team, away, manager } = await draftedSeason();

    const first = await savePrediction(
      empty,
      fd({ matchId: match.id, pickedTeamId: team.id }),
    );
    expect(first?.error).toBeUndefined();

    const changed = await savePrediction(
      empty,
      fd({ matchId: match.id, pickedTeamId: away.id }),
    );
    expect(changed?.error).toBeUndefined();
    const row = await prisma.prediction.findUniqueOrThrow({
      where: { matchId_userId: { matchId: match.id, userId: manager.id } },
    });
    expect(row.pickedTeamId).toBe(away.id);
  });

  it.skipIf(!ON_POSTGRES)(
    "allows a same-match deadline burst from different users",
    async () => {
      const { match, away, manager } = await draftedSeason();
      const other = await makeUser("Other oracle");
      vi.mocked(requireUser)
        .mockReset()
        .mockResolvedValueOnce(sessionFor(manager))
        .mockResolvedValueOnce(sessionFor(other));
      setRaceHook(barrierAt("pickem.save.afterLockRead", 2));

      const results = await Promise.all([
        savePrediction(empty, fd({ matchId: match.id, pickedTeamId: away.id })),
        savePrediction(empty, fd({ matchId: match.id, pickedTeamId: away.id })),
      ]);

      expect(results.map((result) => result?.error)).toEqual([
        undefined,
        undefined,
      ]);
      expect(await prisma.prediction.count()).toBe(2);
    },
  );

  it.skipIf(!ON_POSTGRES)(
    "never inserts a first pick after the match turns LIVE at the transaction seam",
    async () => {
      const { match, away } = await draftedSeason();
      setRaceHook(
        onceAt("pickem.save.afterLockRead", async () => {
          await prisma.match.update({
            where: { id: match.id },
            data: { status: MATCH_STATUS.LIVE },
          });
        }),
      );

      const res = await savePrediction(
        empty,
        fd({ matchId: match.id, pickedTeamId: away.id }),
      );

      expect(res?.error).toMatch(/changed|locked/i);
      expect(await prisma.prediction.count()).toBe(0);
      expect(
        (await prisma.match.findUniqueOrThrow({ where: { id: match.id } }))
          .status,
      ).toBe(MATCH_STATUS.LIVE);
    },
  );

  it.skipIf(!ON_POSTGRES)(
    "never inserts after the season completes at the transaction seam",
    async () => {
      const { season, match, away } = await draftedSeason();
      setRaceHook(
        onceAt("pickem.save.afterLockRead", async () => {
          await prisma.season.update({
            where: { id: season.id },
            data: { status: SEASON_STATUS.COMPLETE },
          });
        }),
      );

      const res = await savePrediction(
        empty,
        fd({ matchId: match.id, pickedTeamId: away.id }),
      );

      expect(res?.error).toMatch(/changed|phase|closed/i);
      expect(await prisma.prediction.count()).toBe(0);
    },
  );
});
