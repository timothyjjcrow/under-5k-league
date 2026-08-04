import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import {
  nominatePlayer,
  pauseDraft,
  placeBid,
  resumeDraft,
  voidCurrentLot,
} from "@/lib/draft-service";
import { DRAFT_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  makeUser,
  sessionFor,
  startDraftState,
} from "./factories";

async function liveDraft() {
  const season = await makeSeason({ teamSize: 3, draftBudget: 100 });
  const capA = await makeCaptain(season.id, "Captain A", 100, 0);
  const capB = await makeCaptain(season.id, "Captain B", 100, 1);
  const star = await makePlayer(season.id, "Star", 5000);
  const spare = await makePlayer(season.id, "Spare", 3500);
  await startDraftState(season.id);
  return { season, capA, capB, star, spare };
}

const admin = () => makeUser("Draft Admin", "ADMIN").then(sessionFor);

describe("voidCurrentLot — paused-auction recovery", () => {
  it("voids only the disputed lot, keeps the nominator's turn, and resumes on a fresh nomination clock", async () => {
    const { season, capA, capB, star, spare } = await liveDraft();
    const boss = await admin();
    const initialDraft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    // Historical bids for other players remain useful audit history; voiding
    // one disputed lot must not flatten the whole draft trail.
    await prisma.bid.create({
      data: {
        draftId: initialDraft.id,
        seasonId: season.id,
        teamId: capA.team.id,
        userId: spare.id,
        amount: 3,
      },
    });
    expect(
      (await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5)).ok,
    ).toBe(true);
    expect((await placeBid(season.id, sessionFor(capB.user), 12)).ok).toBe(true);
    expect((await pauseDraft(season.id, boss)).ok).toBe(true);
    const paused = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(paused.status).toBe(DRAFT_STATUS.PAUSED);
    expect(paused.nominatedUserId).toBe(star.id);

    const res = await voidCurrentLot(season.id, boss);

    expect(res).toEqual({
      ok: true,
      player: "Star",
      nominator: "Captain A's Team",
    });
    const corrected = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(corrected).toMatchObject({
      status: DRAFT_STATUS.PAUSED,
      nominatedUserId: null,
      currentBid: 0,
      currentBidTeamId: null,
      bidEndsAt: null,
      nominationEndsAt: null,
      nominatorTeamId: capA.team.id,
      nominationIndex: paused.nominationIndex,
    });
    const remainingBids = await prisma.bid.findMany({
      where: { draftId: initialDraft.id },
      select: { userId: true, amount: true },
    });
    expect(remainingBids).toEqual([{ userId: spare.id, amount: 3 }]);
    expect(
      await prisma.teamMember.findUnique({
        where: {
          seasonId_userId: { seasonId: season.id, userId: star.id },
        },
      }),
    ).toBeNull();
    expect(
      (await prisma.team.findUniqueOrThrow({ where: { id: capA.team.id } })).budget,
    ).toBe(100);
    expect(
      (await prisma.team.findUniqueOrThrow({ where: { id: capB.team.id } })).budget,
    ).toBe(100);

    expect((await resumeDraft(season.id, boss)).ok).toBe(true);
    const resumed = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(resumed.status).toBe(DRAFT_STATUS.IN_PROGRESS);
    expect(resumed.nominatorTeamId).toBe(capA.team.id);
    expect(resumed.nominatedUserId).toBeNull();
    expect(resumed.bidEndsAt).toBeNull();
    expect(resumed.nominationEndsAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses non-admin and unpaused requests without touching the live lot", async () => {
    const { season, capA, star } = await liveDraft();
    expect(
      (await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5)).ok,
    ).toBe(true);
    const before = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });

    const unauthorized = await voidCurrentLot(season.id, sessionFor(capA.user));
    expect(unauthorized).toMatchObject({ ok: false });
    if (!unauthorized.ok) expect(unauthorized.error).toMatch(/admins only/i);
    const unpaused = await voidCurrentLot(season.id, await admin());
    expect(unpaused).toMatchObject({ ok: false });
    if (!unpaused.ok) expect(unpaused.error).toMatch(/pause the auction/i);

    const after = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(after).toMatchObject({
      status: DRAFT_STATUS.IN_PROGRESS,
      nominatedUserId: before.nominatedUserId,
      currentBid: before.currentBid,
      currentBidTeamId: before.currentBidTeamId,
    });
    expect(await prisma.bid.count({ where: { draftId: before.id } })).toBe(1);
  });

  it("refuses a paused auction with no live lot", async () => {
    const { season } = await liveDraft();
    const boss = await admin();
    expect((await pauseDraft(season.id, boss)).ok).toBe(true);

    const res = await voidCurrentLot(season.id, boss);

    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/no live lot/i);
    expect(
      (await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } })).status,
    ).toBe(DRAFT_STATUS.PAUSED);
  });

  it("refuses after the season leaves DRAFT and preserves the paused lot", async () => {
    const { season, capA, star } = await liveDraft();
    const boss = await admin();
    expect(
      (await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5)).ok,
    ).toBe(true);
    expect((await pauseDraft(season.id, boss)).ok).toBe(true);
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.REGULAR_SEASON },
    });

    const res = await voidCurrentLot(season.id, boss);

    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/not in the Draft phase/i);
    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft).toMatchObject({
      status: DRAFT_STATUS.PAUSED,
      nominatedUserId: star.id,
      currentBid: 5,
      currentBidTeamId: capA.team.id,
    });
    expect(await prisma.bid.count({ where: { draftId: draft.id } })).toBe(1);
  });
});

describe("draft service — client state expectations", () => {
  it("accepts current turn and lot expectations", async () => {
    const { season, capA, capB, star } = await liveDraft();
    const turn = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    if (!turn.nominatorTeamId || !turn.nominationEndsAt) {
      throw new Error("expected a nomination turn");
    }

    const nomination = await nominatePlayer(
      season.id,
      sessionFor(capA.user),
      star.id,
      5,
      {
        draftVersion: turn.updatedAt.getTime(),
        nominatorTeamId: turn.nominatorTeamId,
        nominationEndsAt: turn.nominationEndsAt.getTime(),
      },
    );
    expect(nomination.ok).toBe(true);

    const lot = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    if (!lot.nominatedUserId || !lot.currentBidTeamId || !lot.bidEndsAt) {
      throw new Error("expected a live lot");
    }
    const bid = await placeBid(season.id, sessionFor(capB.user), 10, {
      draftVersion: lot.updatedAt.getTime(),
      nominatedUserId: lot.nominatedUserId,
      currentBid: lot.currentBid,
      currentBidTeamId: lot.currentBidTeamId,
      bidEndsAt: lot.bidEndsAt.getTime(),
    });
    expect(bid.ok).toBe(true);
  });

  it("rejects a nomination composed for a stale turn without opening a lot", async () => {
    const { season, capA, star } = await liveDraft();
    const oldTurn = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    if (!oldTurn.nominatorTeamId || !oldTurn.nominationEndsAt) {
      throw new Error("expected a nomination turn");
    }
    const expected = {
      draftVersion: oldTurn.updatedAt.getTime(),
      nominatorTeamId: oldTurn.nominatorTeamId,
      nominationEndsAt: oldTurn.nominationEndsAt.getTime(),
    };
    // Same team, new clock: without the expectation this captain is still
    // authorized, so the rejection specifically proves stale-turn protection.
    const newClock = new Date(oldTurn.nominationEndsAt.getTime() + 15_000);
    await prisma.draft.update({
      where: { seasonId: season.id },
      data: { nominationEndsAt: newClock },
    });

    const res = await nominatePlayer(
      season.id,
      sessionFor(capA.user),
      star.id,
      5,
      expected,
    );

    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/nomination turn changed/i);
    const after = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(after).toMatchObject({
      nominatedUserId: null,
      currentBid: 0,
      currentBidTeamId: null,
    });
    expect(after.nominationEndsAt?.getTime()).toBe(newClock.getTime());
    expect(await prisma.bid.count({ where: { draftId: after.id } })).toBe(0);
  });

  it("rejects a bid composed for a stale price without overwriting the newer bid", async () => {
    const { season, capA, capB, star } = await liveDraft();
    expect(
      (await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5)).ok,
    ).toBe(true);
    const oldLot = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    if (!oldLot.nominatedUserId || !oldLot.currentBidTeamId || !oldLot.bidEndsAt) {
      throw new Error("expected a live lot");
    }
    const expected = {
      draftVersion: oldLot.updatedAt.getTime(),
      nominatedUserId: oldLot.nominatedUserId,
      currentBid: oldLot.currentBid,
      currentBidTeamId: oldLot.currentBidTeamId,
      bidEndsAt: oldLot.bidEndsAt.getTime(),
    };
    expect((await placeBid(season.id, sessionFor(capB.user), 10)).ok).toBe(true);

    // Captain A is no longer the high bidder and 15 is otherwise valid; only
    // the old lot expectation should stop this delayed click.
    const stale = await placeBid(
      season.id,
      sessionFor(capA.user),
      15,
      expected,
    );

    expect(stale).toMatchObject({ ok: false });
    if (!stale.ok) expect(stale.error).toMatch(/auction lot changed/i);
    const after = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(after).toMatchObject({
      nominatedUserId: star.id,
      currentBid: 10,
      currentBidTeamId: capB.team.id,
    });
    const bids = await prisma.bid.findMany({
      where: { draftId: after.id, userId: star.id },
      orderBy: { amount: "asc" },
      select: { amount: true, teamId: true },
    });
    expect(bids).toEqual([
      { amount: 5, teamId: capA.team.id },
      { amount: 10, teamId: capB.team.id },
    ]);
  });
});
