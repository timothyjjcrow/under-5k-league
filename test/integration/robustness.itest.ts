import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  getDraftState,
  nominatePlayer,
  placeBid,
} from "@/lib/draft-service";
import {
  expireClock,
  makeCaptain,
  makePlayer,
  makeSeason,
  sessionFor,
  startDraftState,
} from "./factories";

describe("draft robustness — auction error paths", () => {
  it("rejects a bid when nothing is up for auction", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "A", 100, 0);
    await makeCaptain(season.id, "B", 100, 1);
    await startDraftState(season.id);
    expect((await placeBid(season.id, sessionFor(capA.user), 5)).ok).toBe(false);
  });

  it("rejects a nomination from a captain who isn't on the clock", async () => {
    const season = await makeSeason({ teamSize: 3 });
    await makeCaptain(season.id, "A", 100, 0); // A is on the clock
    const capB = await makeCaptain(season.id, "B", 100, 1);
    const star = await makePlayer(season.id, "Star", 4000);
    await startDraftState(season.id);
    expect(
      (await nominatePlayer(season.id, sessionFor(capB.user), star.id, 5)).ok,
    ).toBe(false);
  });

  it("resolves the expired nomination (and rejects the late bid) once the clock passes", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "A", 100, 0);
    const capB = await makeCaptain(season.id, "B", 100, 1);
    const star = await makePlayer(season.id, "Star", 4000);
    await startDraftState(season.id);
    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5); // A opens at 5
    await expireClock(season.id);

    // A late bid triggers resolution first: A wins Star at the opening bid, and
    // the stale bid is rejected.
    expect((await placeBid(season.id, sessionFor(capB.user), 10)).ok).toBe(false);
    const member = await prisma.teamMember.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: star.id } },
    });
    expect(member?.teamId).toBe(capA.team.id);
    expect(member?.price).toBe(5);
  });

  it("keeps concurrent bids consistent — exactly one holds the high bid", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "A", 100, 0);
    const capB = await makeCaptain(season.id, "B", 100, 1);
    const capC = await makeCaptain(season.id, "C", 100, 2);
    const star = await makePlayer(season.id, "Star", 4000);
    await startDraftState(season.id);
    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5);

    const results = await Promise.all([
      placeBid(season.id, sessionFor(capB.user), 10),
      placeBid(season.id, sessionFor(capC.user), 10),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1); // only one 10 can win
    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.currentBid).toBe(10);
    expect([capB.team.id, capC.team.id]).toContain(draft.currentBidTeamId);
  });
});

describe("draft robustness — withdrawn players", () => {
  it("excludes a withdrawn player from the pool and blocks nominating them", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "A", 100, 0);
    await makeCaptain(season.id, "B", 100, 1);
    const quitter = await makePlayer(season.id, "Quitter", 4000);
    const stayer = await makePlayer(season.id, "Stayer", 3000);
    await startDraftState(season.id);

    // Simulate the leaveLeague action.
    await prisma.registration.update({
      where: { seasonId_userId: { seasonId: season.id, userId: quitter.id } },
      data: { status: "WITHDRAWN" },
    });

    const state = await getDraftState(season.id, null);
    const availableIds = state!.available.map((p) => p.userId);
    expect(availableIds).toContain(stayer.id);
    expect(availableIds).not.toContain(quitter.id);

    expect(
      (await nominatePlayer(season.id, sessionFor(capA.user), quitter.id, 5)).ok,
    ).toBe(false);
  });
});
