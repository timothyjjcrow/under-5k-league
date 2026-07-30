/**
 * The two community-feature mutations (fantasy roster, pick'em) carried their
 * locks as read-time checks only — the exact class CLAUDE.md's concurrency
 * rule 1 names, with auto-sync (any page view) as the rival that flips the
 * state mid-request. Both locks now live at the write: fantasy re-counts
 * games INSIDE its transaction, pick'em carries predictionOpenWhere in the
 * WHERE of its update. Deliberately NO read-time copies remain — a staged
 * test would stop at the copy and pass with the real guard deleted (the
 * saveRegistration lesson). Each guard here was sabotage-verified: delete
 * the in-tx count / the match WHERE and the matching test goes red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { saveFantasyRoster } from "@/app/actions/fantasy";
import { savePrediction } from "@/app/actions/pickem";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import {
  makePlayer,
  makeSeason,
  makeTeam,
  makeUser,
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
const empty: ActionResult = {};

beforeEach(resetDb);

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

describe("saveFantasyRoster — the lock is the in-transaction count", () => {
  it("refuses once a game exists, and writes no picks", async () => {
    const { match, playerIds } = await draftedSeason();
    await stageGame(match.id, "900001");

    const res = await saveFantasyRoster(empty, fd({ picks: playerIds }));

    expect(res?.error).toMatch(/locked/i);
    expect(await prisma.fantasyPick.count()).toBe(0);
  });

  it("saves normally while no game is imported", async () => {
    const { playerIds } = await draftedSeason();

    const res = await saveFantasyRoster(empty, fd({ picks: playerIds }));

    expect(res?.error).toBeUndefined();
    expect(await prisma.fantasyPick.count()).toBe(5);
  });
});

describe("savePrediction — the lock rides in the WHERE of the write", () => {
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
});
