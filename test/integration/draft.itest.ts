import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  abortDraft,
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
import { onceAt, setRaceHook } from "@/lib/race-hook";
import {
  ON_POSTGRES,
  expireClock,
  expireNominationClock,
  makeCaptain,
  makePlayer,
  makeSeason,
  makeUser,
  raceAll,
  raceN,
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
    // RACED, not sequential. A second SEQUENTIAL call returns false from the
    // top-of-transaction read (`nominatedUserId` is already null by then), so
    // the claim's WHERE is never issued twice and the test passed with the
    // claim reduced to a blind write. Firing them together is the only way the
    // predicate does any work — and only on Postgres, since SQLite serializes
    // writers (`npm run test:pg`).
    const results = await raceN(6, () => resolveExpiredNomination(season.id));
    expect(results.filter(Boolean)).toHaveLength(1); // exactly one winner

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
    // Raced for the same reason as the sale resolver above: a sequential
    // second call bails at the read (`nominatedUserId` is now set), so it
    // never exercises the auto-nomination claim.
    const fired = await raceN(6, () => resolveStalledNomination(season.id));
    expect(fired.filter(Boolean)).toHaveLength(1);

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

  // Pause -> Undo is the single most likely draft-night sequence there is: a lot
  // sells, the captains dispute it, the admin parks the clocks to settle it, and
  // THEN reaches for Undo. Flattening the status to IN_PROGRESS here silently
  // resumed the auction with a live 90-second nomination clock — while the room
  // showed nothing but the Pause button having swapped to Resume.
  it("undoLastSale leaves a PAUSED auction paused, with no clock running", async () => {
    const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 5000);
    // Keep the pool stocked: a one-player pool goes dry on the first sale and
    // the draft completes, which is a different undo path (and one pauseDraft
    // rightly refuses). Draft night pauses happen mid-auction.
    for (const n of ["Spare A", "Spare B", "Spare C"]) {
      await makePlayer(season.id, n, 3000);
    }
    const admin = sessionFor(await makeUser("Boss", "ADMIN"));
    await startDraftState(season.id);

    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 12);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);

    expect((await pauseDraft(season.id, admin)).ok).toBe(true);
    const res = await undoLastSale(season.id, admin);
    expect(res.ok).toBe(true);
    expect(res.ok && res.paused).toBe(true); // the toast has to be able to say so

    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.status).toBe(DRAFT_STATUS.PAUSED);
    expect(draft.nominationEndsAt).toBeNull();
    // The undo itself still happened — this is a status fix, not a refusal.
    expect(draft.nominatorTeamId).toBe(capA.team.id);
    const teamA = await prisma.team.findUniqueOrThrow({
      where: { id: capA.team.id },
    });
    expect(teamA.budget).toBe(100);
  });

  it("undoLastSale still reopens a LIVE auction with a fresh clock", async () => {
    const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 5000);
    for (const n of ["Spare A", "Spare B", "Spare C"]) {
      await makePlayer(season.id, n, 3000);
    }
    const admin = sessionFor(await makeUser("Boss", "ADMIN"));
    await startDraftState(season.id);

    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 12);
    await expireClock(season.id);
    await resolveExpiredNomination(season.id);

    const res = await undoLastSale(season.id, admin);
    expect(res.ok && res.paused).toBe(false);
    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.status).toBe(DRAFT_STATUS.IN_PROGRESS);
    expect(draft.nominationEndsAt).not.toBeNull();
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
    // Live lot → refuse. Assert the REASON: with no sale on the books yet this
    // call also refuses via the "no auction sale to undo" branch, so a bare
    // `.ok === false` passed even with the live-lot guard deleted.
    const live = await undoLastSale(season.id, admin);
    expect(live.ok).toBe(false);
    expect(!live.ok && live.error).toMatch(/lot is live/i);

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

// ---------------------------------------------------------------------------
// Every remaining draft claim, tested the only way that works: race N callers
// and require exactly one to win. Delete the guard and all N win — that is the
// assertion. Real interleaving only happens under `npm run test:pg`.
// ---------------------------------------------------------------------------

describe("draft auction — claims fire exactly once under contention", () => {
  /** A live auction with two captains and a pool. */
  async function liveDraft(tag: string) {
    const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
    const capA = await makeCaptain(season.id, `CapA${tag}`, 100, 0);
    const capB = await makeCaptain(season.id, `CapB${tag}`, 100, 1);
    const pool = [];
    for (let i = 0; i < 4; i++) {
      pool.push(await makePlayer(season.id, `P${tag}${i}`, 4000 - i * 100));
    }
    await startDraftState(season.id);
    return { season, capA, capB, pool };
  }

  it("pauseDraft: only one of N simultaneous pauses may park the clocks", async () => {
    const { season } = await liveDraft("Pause");
    const admin = sessionFor(await makeUser("AdminPz", "ADMIN"));
    const res = await raceN(3, () => pauseDraft(season.id, admin));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(
      (await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } })).status,
    ).toBe(DRAFT_STATUS.PAUSED);
  });

  it("resumeDraft: only one of N simultaneous resumes may restart the clock", async () => {
    const { season } = await liveDraft("Resume");
    const admin = sessionFor(await makeUser("AdminRz", "ADMIN"));
    expect((await pauseDraft(season.id, admin)).ok).toBe(true);
    const res = await raceN(3, () => resumeDraft(season.id, admin));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(
      (await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } })).status,
    ).toBe(DRAFT_STATUS.IN_PROGRESS);
  });

  it("nominatePlayer: two captains nominating at once open ONE lot", async () => {
    const { season, capA, capB, pool } = await liveDraft("Nom");
    const admin = sessionFor(await makeUser("AdminNm", "ADMIN"));
    void capA;
    void capB;
    // Both go through the admin path so neither is refused for being off the
    // clock — the nomination CLAIM is what must arbitrate, not the turn check.
    const res = await raceAll([
      () => nominatePlayer(season.id, admin, pool[0].id, 1),
      () => nominatePlayer(season.id, admin, pool[1].id, 1),
      () => nominatePlayer(season.id, admin, pool[2].id, 1),
    ]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.nominatedUserId).not.toBeNull();
    // One lot means one opening bid row, not three.
    expect(await prisma.bid.count({ where: { seasonId: season.id } })).toBe(1);
  });

  it("the stall resolver ADVANCES the rotation exactly once for a broke nominator", async () => {
    // The nominator can't afford MIN_BID, so the resolver takes the advance
    // branch rather than auto-nominating. Its claim is separate from the
    // auto-nomination one and had no coverage.
    const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
    const capA = await makeCaptain(season.id, "BrokeCap", 0, 0);
    await makeCaptain(season.id, "RichCap", 100, 1);
    await makePlayer(season.id, "PoolA", 4000);
    await makePlayer(season.id, "PoolB", 3900);
    await startDraftState(season.id);
    await expireNominationClock(season.id);

    const res = await raceN(4, () => resolveStalledNomination(season.id));
    expect(res.filter(Boolean)).toHaveLength(1);
    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    // The clock moved off the broke captain exactly once.
    expect(draft.nominatorTeamId).not.toBe(capA.team.id);
  });

  it("the stall resolver completes a draft NO team can afford, exactly once", async () => {
    // The other completion branch: the nominator can't afford MIN_BID AND
    // neither can anyone else, so nextNominatorIndex returns -1. Distinct claim
    // from the pool-dry one below, and separately uncovered.
    const season = await makeSeason({ teamSize: 3, draftBudget: 0 });
    await makeCaptain(season.id, "BrokeA", 0, 0);
    await makeCaptain(season.id, "BrokeB", 0, 1);
    await makePlayer(season.id, "Unsellable", 4000);
    await startDraftState(season.id);
    await expireNominationClock(season.id);

    const res = await raceN(4, () => resolveStalledNomination(season.id));
    expect(res.filter(Boolean)).toHaveLength(1);
    expect(
      (await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } })).status,
    ).toBe(DRAFT_STATUS.COMPLETE);
  });

  it("abortDraft: only one of N simultaneous aborts may tear the draft down", async () => {
    const { season, pool } = await liveDraft("Abort");
    const admin = sessionFor(await makeUser("AdminAb", "ADMIN"));
    // Land a sale so the teardown has budget to credit back.
    expect((await nominatePlayer(season.id, admin, pool[0].id, 5)).ok).toBe(true);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);

    const res = await raceN(4, () => abortDraft(season.id, admin));
    expect(res.filter((r) => r.ok)).toHaveLength(1);

    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.status).toBe(DRAFT_STATUS.NOT_STARTED);
    // Credited back ONCE, not once per aborting admin.
    const teams = await prisma.team.findMany({ where: { seasonId: season.id } });
    for (const t of teams) expect(t.budget).toBe(100);
  });

  it("the stall resolver COMPLETES a pool-dry draft exactly once", async () => {
    const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
    await makeCaptain(season.id, "DryA", 100, 0);
    await makeCaptain(season.id, "DryB", 100, 1);
    await startDraftState(season.id); // no pool at all
    await expireNominationClock(season.id);

    const res = await raceN(4, () => resolveStalledNomination(season.id));
    expect(res.filter(Boolean)).toHaveLength(1);
    expect(
      (await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } })).status,
    ).toBe(DRAFT_STATUS.COMPLETE);
    // One completion means one announcement.
    expect(
      mockSend.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("draft")),
    ).not.toHaveLength(0);
  });
});

describe("draft — a mid-lot type flip voids the sale instead of rostering a standin", () => {
  it("no charge, no roster row, rotation advances, when the nominee turned STANDIN", async () => {
    // saveRegistration refuses type changes during a live draft now, but this
    // resolver check is the write-time backstop — staged is honest here, since
    // the resolver's own in-transaction read is exactly what catches it.
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Flipper", 4000);
    await makePlayer(season.id, "Rest", 3000);
    await startDraftState(season.id);

    expect(
      (await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5)).ok,
    ).toBe(true);
    await prisma.registration.update({
      where: { seasonId_userId: { seasonId: season.id, userId: star.id } },
      data: { type: "STANDIN" },
    });

    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);

    const teamA = await prisma.team.findUniqueOrThrow({
      where: { id: capA.team.id },
      include: { members: true },
    });
    expect(teamA.budget).toBe(100); // never charged
    expect(teamA.members.some((m) => m.userId === star.id)).toBe(false);
    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.nominatedUserId).toBeNull(); // lot cleared…
    expect(draft.nominatorTeamId).toBe(capB.team.id); // …and the clock moved on
  });

  it("no charge, no roster row, rotation advances, when the nominee WITHDREW mid-lot", async () => {
    // The STATUS half of the same void guard (`nomReg.status === "ACTIVE"`).
    // Reachable cross-path: both withdraw paths check on-the-block only at
    // read time, so a nomination committing in their gate→write gap leaves a
    // WITHDRAWN player as the live lot. Without this test, deleting the
    // status conjunct passed the whole suite — only the type half was pinned.
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Leaver", 4000);
    await makePlayer(season.id, "Rest", 3000);
    await startDraftState(season.id);

    expect(
      (await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5)).ok,
    ).toBe(true);
    await prisma.registration.update({
      where: { seasonId_userId: { seasonId: season.id, userId: star.id } },
      data: { status: "WITHDRAWN" },
    });

    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);

    const teamA = await prisma.team.findUniqueOrThrow({
      where: { id: capA.team.id },
      include: { members: true },
    });
    expect(teamA.budget).toBe(100); // never charged
    expect(teamA.members.some((m) => m.userId === star.id)).toBe(false);
    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.nominatedUserId).toBeNull(); // lot cleared…
    expect(draft.nominatorTeamId).toBe(capB.team.id); // …and the clock moved on
  });
});

describe("undoLastSale — two racing undos stay a toast, never a crash", () => {
  it("exactly one undo wins; the loser gets a typed refusal and the refund lands once", async () => {
    // The loser used to die on a raw P2025 (delete-by-unique on a row the
    // winner already removed), which blew the admin panel to the error page
    // mid-dispute. deleteMany + count makes it a typed refusal. On SQLite the
    // pair serializes (the loser sees "No sale to undo"); Postgres is where
    // the P2025 path was reachable — `npm run test:pg` runs this for real.
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Disputed", 4000);
    await makePlayer(season.id, "Rest", 3000);
    await startDraftState(season.id);
    const admin = sessionFor(await makeUser("UndoAdmin", "ADMIN"));

    expect(
      (await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5)).ok,
    ).toBe(true);
    await expireClock(season.id);
    expect(await resolveExpiredNomination(season.id)).toBe(true);

    // Must RESOLVE — an unhandled P2025 would reject the whole race.
    const res = await raceN(2, () => undoLastSale(season.id, admin));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    const loser = res.find((r) => !r.ok) as { ok: false; error: string };
    expect(loser.error).toMatch(/already undone|No sale to undo/);

    // Refunded exactly once.
    const teamA = await prisma.team.findUniqueOrThrow({
      where: { id: capA.team.id },
    });
    expect(teamA.budget).toBe(100);
    expect(
      await prisma.teamMember.count({
        where: { seasonId: season.id, userId: star.id },
      }),
    ).toBe(0);
  });
});

describe.skipIf(!ON_POSTGRES)(
  "nominatePlayer — the claim re-asserts the TURN it authorized against",
  () => {
    afterEach(() => setRaceHook(null));

    it("a nomination in flight while undoLastSale repoints the rotation is refused, not landed out of turn", async () => {
      // The one rival that moves the turn while leaving the lot EMPTY:
      // undoLastSale repoints nominatorTeamId to the refunded buyer with a
      // fresh clock. `nominatedUserId: null` alone still matched, so the
      // stale nomination opened a lot out of turn and the buyer the undo
      // promised the next nomination never got it. Postgres-only: the rival
      // commits on a second connection while this transaction is open.
      const season = await makeSeason({ teamSize: 3 });
      const capA = await makeCaptain(season.id, "Captain A", 100, 0);
      const capB = await makeCaptain(season.id, "Captain B", 100, 1);
      const sold = await makePlayer(season.id, "SoldFirst", 4000);
      const next = await makePlayer(season.id, "NextUp", 3500);
      await makePlayer(season.id, "Rest", 3000);
      await startDraftState(season.id);
      const admin = sessionFor(await makeUser("TurnAdmin", "ADMIN"));

      // A sale to team A, so the rotation moves on to team B and Undo has a
      // target to refund.
      expect(
        (await nominatePlayer(season.id, sessionFor(capA.user), sold.id, 5)).ok,
      ).toBe(true);
      await expireClock(season.id);
      expect(await resolveExpiredNomination(season.id)).toBe(true);
      const before = await prisma.draft.findUniqueOrThrow({
        where: { seasonId: season.id },
      });
      expect(before.nominatorTeamId).toBe(capB.team.id);

      let fired = false;
      setRaceHook(
        onceAt("draft.nominatePlayer.beforeClaim", async () => {
          fired = true;
          const undone = await undoLastSale(season.id, admin);
          if (!undone.ok) throw new Error(`rival undo failed: ${undone.error}`);
        }),
      );

      const res = await nominatePlayer(
        season.id,
        sessionFor(capB.user),
        next.id,
        1,
      );

      expect(fired).toBe(true);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/draft just changed/i);

      const draft = await prisma.draft.findUniqueOrThrow({
        where: { seasonId: season.id },
      });
      // The undo's repoint stands: no lot open, team A (the refunded buyer)
      // holds the make-good nomination.
      expect(draft.nominatedUserId).toBeNull();
      expect(draft.nominatorTeamId).toBe(capA.team.id);
      // And the refused nomination left no opening-bid audit row behind.
      expect(
        await prisma.bid.count({ where: { seasonId: season.id, userId: next.id } }),
      ).toBe(0);
    });
  },
);
