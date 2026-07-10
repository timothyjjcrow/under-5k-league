import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  getDraftState,
  nominatePlayer,
  placeBid,
  resolveExpiredNomination,
} from "@/lib/draft-service";
import { DRAFT_STATUS } from "@/lib/constants";
import {
  expireClock,
  expireNominationClock,
  makeCaptain,
  makePlayer,
  makeSeason,
  sessionFor,
  startDraftState,
} from "./factories";

describe("draft auction — full lifecycle", () => {
  it("drives a 2-team draft to completion with full rosters, correct budgets, no double-picks", async () => {
    const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    for (let i = 0; i < 4; i++) {
      await makePlayer(season.id, `Player ${i}`, 3000 - i * 100);
    }
    await startDraftState(season.id);

    const captainSession = new Map([
      [capA.team.id, sessionFor(capA.user)],
      [capB.team.id, sessionFor(capB.user)],
    ]);

    for (let step = 0; step < 20; step++) {
      const state = await getDraftState(season.id, null);
      if (!state || state.status === DRAFT_STATUS.COMPLETE) break;
      const nominatorId = state.nominatorTeamId!;
      const session = captainSession.get(nominatorId)!;
      const pick = state.available[0];
      expect(pick, "a player should be available while the draft is live").toBeTruthy();

      const nom = await nominatePlayer(season.id, session, pick.userId, 1);
      expect(nom.ok).toBe(true);

      await expireClock(season.id);
      expect(await resolveExpiredNomination(season.id)).toBe(true);
    }

    const final = await getDraftState(season.id, null);
    expect(final?.status).toBe(DRAFT_STATUS.COMPLETE);

    const teams = await prisma.team.findMany({
      where: { seasonId: season.id },
      include: { members: true },
    });
    for (const t of teams) {
      expect(t.members).toHaveLength(3); // captain + 2 drafted
      expect(t.budget).toBeGreaterThanOrEqual(0);
    }

    const members = await prisma.teamMember.findMany({
      where: { seasonId: season.id },
    });
    expect(members).toHaveLength(6);
    expect(new Set(members.map((m) => m.userId)).size).toBe(6); // no double-picks
  });

  it("awards the player to the highest bidder and deducts exactly that amount", async () => {
    const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 5000);
    await startDraftState(season.id);

    expect((await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5)).ok).toBe(true);
    expect((await placeBid(season.id, sessionFor(capB.user), 20)).ok).toBe(true);

    await expireClock(season.id);
    await resolveExpiredNomination(season.id);

    const teamB = await prisma.team.findUniqueOrThrow({
      where: { id: capB.team.id },
      include: { members: true },
    });
    expect(teamB.budget).toBe(80);
    expect(teamB.members.some((m) => m.userId === star.id)).toBe(true);
  });

  it("rejects a captain bidding against their own high bid", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 5000);
    await startDraftState(season.id);

    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5);
    expect((await placeBid(season.id, sessionFor(capA.user), 10)).ok).toBe(false);
  });

  it("won't let a captain overspend below the reserve for their empty slots", async () => {
    const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 5000);
    await startDraftState(season.id);

    // 2 empty slots → must reserve 1 for the last slot → max opening bid is 99.
    expect((await nominatePlayer(season.id, sessionFor(capA.user), star.id, 100)).ok).toBe(false);
    expect((await nominatePlayer(season.id, sessionFor(capA.user), star.id, 99)).ok).toBe(true);
  });

  it("won't nominate an already-drafted player", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 5000);
    await startDraftState(season.id);

    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5);
    await expireClock(season.id);
    await resolveExpiredNomination(season.id); // capA now owns Star; nominator -> capB

    const dup = await nominatePlayer(season.id, sessionFor(capB.user), star.id, 5);
    expect(dup.ok).toBe(false);
  });

  it("completes (not deadlocks) when the pool runs dry with seats still open", async () => {
    // 2 teams × (3-1) = 4 open seats but only 2 signed-up players.
    const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    const p1 = await makePlayer(season.id, "Player 1", 3000);
    const p2 = await makePlayer(season.id, "Player 2", 2900);
    await startDraftState(season.id);

    // Sell both players.
    await nominatePlayer(season.id, sessionFor(capA.user), p1.id, 1);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);
    await nominatePlayer(season.id, sessionFor(capB.user), p2.id, 1);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);

    // Pool is dry, teams are still short — the draft must be COMPLETE.
    const state = await getDraftState(season.id, null);
    expect(state?.status).toBe(DRAFT_STATUS.COMPLETE);
  });

  it("completes via the stall resolver when the nominator has nobody to pick", async () => {
    const season = await makeSeason({ teamSize: 3 });
    await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    // No pool at all — the first nomination clock expires with nobody to nominate.
    await startDraftState(season.id);
    await expireNominationClock(season.id);

    const state = await getDraftState(season.id, null);
    expect(state?.status).toBe(DRAFT_STATUS.COMPLETE);
  });
});
