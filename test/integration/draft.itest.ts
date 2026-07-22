import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  getDraftState,
  nominatePlayer,
  pauseDraft,
  placeBid,
  resolveExpiredNomination,
  resolveStalledNomination,
  resumeDraft,
  undoLastSale,
} from "@/lib/draft-service";
import { DRAFT_STATUS } from "@/lib/constants";
import {
  expireClock,
  expireNominationClock,
  makeCaptain,
  makePlayer,
  makeSeason,
  makeUser,
  sessionFor,
  startDraftState,
} from "./factories";

// Stub the sender (formatters stay real) so tests can assert what would have
// been announced — the inhouse.itest pattern.
vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return { ...actual, sendDiscordMessage: vi.fn(async () => true) };
});
import { sendDiscordMessage } from "@/lib/discord";
const mockSend = vi.mocked(sendDiscordMessage);

beforeEach(() => {
  mockSend.mockClear();
});

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

// ---------------------------------------------------------------------------
// Guarded claims: every resolver/nomination transition must fire exactly once
// no matter how many concurrent pollers reach it (the inhouse hardening bar).

describe("draft auction — claim guards", () => {
  it("a second expired-nomination resolve is a no-op: one sale, one decrement, one announcement", async () => {
    const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 5000);
    await startDraftState(season.id);

    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 7);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);
    expect(await resolveExpiredNomination(season.id)).toBe(false); // claim lost

    const members = await prisma.teamMember.findMany({
      where: { seasonId: season.id, userId: star.id },
    });
    expect(members).toHaveLength(1);
    const teamA = await prisma.team.findUniqueOrThrow({
      where: { id: capA.team.id },
    });
    expect(teamA.budget).toBe(93); // decremented exactly once

    // The 💰 sale announcement fires once (the recap may also name the
    // player — that's a different message).
    const saleSends = mockSend.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.startsWith("💰") && m.includes("Star"));
    expect(saleSends).toHaveLength(1);
  });

  it("the stall resolver auto-nominates once — one opening bid row, second call no-ops", async () => {
    const season = await makeSeason({ teamSize: 3 });
    await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    await makePlayer(season.id, "Top", 5000);
    await makePlayer(season.id, "Mid", 4000);
    await startDraftState(season.id);

    await expireNominationClock(season.id);
    expect(await resolveStalledNomination(season.id)).toBe(true);
    expect(await resolveStalledNomination(season.id)).toBe(false);

    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.nominatedUserId).not.toBeNull();
    const bids = await prisma.bid.findMany({ where: { seasonId: season.id } });
    expect(bids).toHaveLength(1); // exactly one auto opening bid
  });

  it("a nomination can't replace a live lot", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    const p1 = await makePlayer(season.id, "P1", 3000);
    const p2 = await makePlayer(season.id, "P2", 2900);
    await startDraftState(season.id);

    expect((await nominatePlayer(season.id, sessionFor(capA.user), p1.id, 1)).ok).toBe(true);
    const second = await nominatePlayer(season.id, sessionFor(capA.user), p2.id, 1);
    expect(second.ok).toBe(false);
    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.nominatedUserId).toBe(p1.id); // the live lot survived
  });

  it("completion announces the recap alongside the complete message", async () => {
    // teamSize 2 → each captain needs exactly one player.
    const season = await makeSeason({ teamSize: 2, draftBudget: 50 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    const p1 = await makePlayer(season.id, "First Buy", 4000);
    const p2 = await makePlayer(season.id, "Last Buy", 3000);
    await startDraftState(season.id);

    await nominatePlayer(season.id, sessionFor(capA.user), p1.id, 9);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);
    await nominatePlayer(season.id, sessionFor(capB.user), p2.id, 3);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);

    expect(
      (await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } }))
        .status,
    ).toBe(DRAFT_STATUS.COMPLETE);

    const sends = mockSend.mock.calls.map((c) => String(c[0]));
    expect(sends.some((m) => m.includes("draft is complete"))).toBe(true);
    const recap = sends.find((m) => m.includes("Draft night in numbers"));
    expect(recap).toBeTruthy();
    expect(recap).toContain("First Buy"); // $9 — the biggest buy
  });
});

describe("draft auction — clocks, rotation, pause", () => {
  it("every bid resets the bid clock", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 5000);
    await startDraftState(season.id);

    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 1);
    const before = (
      await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } })
    ).bidEndsAt!;
    // Age the clock, then bid — the deadline must jump forward again.
    await prisma.draft.update({
      where: { seasonId: season.id },
      data: { bidEndsAt: new Date(before.getTime() - 20_000) },
    });
    expect((await placeBid(season.id, sessionFor(capB.user), 2)).ok).toBe(true);
    const after = (
      await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } })
    ).bidEndsAt!;
    expect(after.getTime()).toBeGreaterThan(before.getTime() - 20_000 + 1000);
  });

  it("the stalled auto-nomination picks the TOP-MMR available player", async () => {
    const season = await makeSeason({ teamSize: 3 });
    await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    await makePlayer(season.id, "Low", 2000);
    const top = await makePlayer(season.id, "Top", 5200);
    await makePlayer(season.id, "Mid", 3600);
    await startDraftState(season.id);

    await expireNominationClock(season.id);
    expect(await resolveStalledNomination(season.id)).toBe(true);
    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.nominatedUserId).toBe(top.id);
  });

  it("the rotation skips a team that filled early", async () => {
    // teamSize 3: captain + 2 buys. B fills fast by winning on A's lot too.
    const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    const capC = await makeCaptain(season.id, "Captain C", 100, 2);
    const players = [];
    for (let i = 0; i < 6; i++) {
      players.push(await makePlayer(season.id, `P${i}`, 4000 - i * 100));
    }
    await startDraftState(season.id);

    // A nominates, B outbids and wins → B roster 2.
    await nominatePlayer(season.id, sessionFor(capA.user), players[0].id, 1);
    await placeBid(season.id, sessionFor(capB.user), 3);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);
    // Rotation: after A comes B.
    let draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.nominatorTeamId).toBe(capB.team.id);
    // B nominates and wins unopposed → B full (3).
    await nominatePlayer(season.id, sessionFor(capB.user), players[1].id, 1);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);
    // C's turn; C wins one.
    draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.nominatorTeamId).toBe(capC.team.id);
    await nominatePlayer(season.id, sessionFor(capC.user), players[2].id, 1);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);
    // After C comes A again; A wins one.
    draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.nominatorTeamId).toBe(capA.team.id);
    await nominatePlayer(season.id, sessionFor(capA.user), players[3].id, 1);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);
    // After A the rotation must SKIP the full B and land on C.
    draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.nominatorTeamId).toBe(capC.team.id);
  });

  it("pause parks the clocks (nothing can sell) and resume restarts them fresh", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 5000);
    const admin = sessionFor(await makeUser("Boss", "ADMIN"));
    await startDraftState(season.id);

    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 4);
    expect((await pauseDraft(season.id, admin)).ok).toBe(true);

    // Paused: bids rejected, resolvers no-op, the lot survives.
    expect((await placeBid(season.id, sessionFor(capB.user), 9)).ok).toBe(false);
    expect(await resolveExpiredNomination(season.id)).toBe(false);
    const paused = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(paused.status).toBe(DRAFT_STATUS.PAUSED);
    expect(paused.nominatedUserId).toBe(star.id);
    expect(paused.bidEndsAt).toBeNull();

    // Non-admin can't pause or resume.
    expect((await resumeDraft(season.id, sessionFor(capA.user))).ok).toBe(false);

    // Resume: fresh bid clock for the live lot, bidding works again.
    expect((await resumeDraft(season.id, admin)).ok).toBe(true);
    const resumed = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(resumed.status).toBe(DRAFT_STATUS.IN_PROGRESS);
    expect(resumed.bidEndsAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await placeBid(season.id, sessionFor(capB.user), 9)).ok).toBe(true);
  });
});

describe("draft auction — bid trail + undo", () => {
  it("exposes the current lot's bid trail, newest first", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 5000);
    await startDraftState(season.id);

    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 2);
    await placeBid(season.id, sessionFor(capB.user), 6);

    const state = await getDraftState(season.id, null);
    expect(state?.lotBids.map((b) => b.amount)).toEqual([6, 2]);
    expect(state?.lotBids[0].teamId).toBe(capB.team.id);
  });

  it("undoLastSale refunds the buyer, frees the player, and hands them the nomination", async () => {
    const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 5000);
    const admin = sessionFor(await makeUser("Boss", "ADMIN"));
    await startDraftState(season.id);

    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 12);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);

    const res = await undoLastSale(season.id, admin);
    expect(res.ok).toBe(true);

    const teamA = await prisma.team.findUniqueOrThrow({
      where: { id: capA.team.id },
      include: { members: true },
    });
    expect(teamA.budget).toBe(100); // refunded
    expect(teamA.members.some((m) => m.userId === star.id)).toBe(false);
    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.status).toBe(DRAFT_STATUS.IN_PROGRESS);
    expect(draft.nominatorTeamId).toBe(capA.team.id); // buyer re-nominates
    // The player is back in the pool.
    const state = await getDraftState(season.id, null);
    expect(state?.available.some((p) => p.userId === star.id)).toBe(true);
  });

  it("undoLastSale re-opens a COMPLETE draft, and refuses during a live lot / with nothing to undo", async () => {
    const season = await makeSeason({ teamSize: 2, draftBudget: 50 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    const only = await makePlayer(season.id, "Only", 4000);
    const admin = sessionFor(await makeUser("Boss", "ADMIN"));
    await startDraftState(season.id);

    // Nothing sold yet → nothing to undo.
    expect((await undoLastSale(season.id, admin)).ok).toBe(false);

    await nominatePlayer(season.id, sessionFor(capA.user), only.id, 4);
    // Live lot → refuse.
    expect((await undoLastSale(season.id, admin)).ok).toBe(false);

    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);
    // capB still needs 1 but the pool is dry → COMPLETE.
    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.status).toBe(DRAFT_STATUS.COMPLETE);

    // Undo re-opens the draft with the buyer on the clock.
    expect((await undoLastSale(season.id, admin)).ok).toBe(true);
    const reopened = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(reopened.status).toBe(DRAFT_STATUS.IN_PROGRESS);
    expect(reopened.nominatorTeamId).toBe(capA.team.id);
    // Non-admin can't touch it.
    expect((await undoLastSale(season.id, sessionFor(capB.user))).ok).toBe(false);
  });
});
