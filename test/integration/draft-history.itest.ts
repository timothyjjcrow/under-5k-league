import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(), getSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/discord", async (original) => ({
  ...await original<typeof import("@/lib/discord")>(), sendDiscordMessage: vi.fn(async () => true),
}));
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { addCaptain, removeCaptain, startDraft, releasePlayer, signFreeAgent, transferCaptaincy } from "@/app/actions/admin";
import { abortDraft, getDraftState, nominatePlayer, pauseDraft, placeBid, resolveExpiredNomination, resolveStalledNomination, resumeDraft, undoLastSale, voidCurrentLot } from "@/lib/draft-service";
import { readAcceptedBids } from "@/lib/draft-history";
import { backfillRosterTenures, captureRosterTenure } from "@/lib/roster-history";
import { expireClock, expireNominationClock, makeCaptain, makePlayer, makeSeason, makeUser, ON_POSTGRES, sessionFor, startDraftState } from "./factories";

const form = (values: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(values)) body.set(key, value);
  return body;
};
let failTenureWrite = false;
let failRunIntegrity = false;
let beforeBidClaim: (() => Promise<void>) | null = null;
prisma.$use(async (params, next) => {
  if (beforeBidClaim && params.model === "Draft" && params.action === "updateMany" && params.args?.data?.currentBid === 5) {
    const rival = beforeBidClaim; beforeBidClaim = null; await rival();
  }
  if (failTenureWrite && params.model === "RosterTenure" && params.action === "create") throw new Error("history storage unavailable");
  if (failRunIntegrity && params.model === "DraftRun" && params.action === "create") {
    throw Object.assign(new Error("unrelated history unique constraint"), { code: "P2002", meta: { target: ["id"] } });
  }
  return next(params);
});
beforeEach(() => { failTenureWrite = false; failRunIntegrity = false; beforeBidClaim = null; });

async function setup(teamSize = 2) {
  const actor = sessionFor(await makeUser("History admin", "ADMIN"));
  vi.mocked(requireAdmin).mockResolvedValue(actor);
  const season = await makeSeason({ teamSize, status: "SIGNUPS", budgetMmrWeight: 30 });
  const a = await makeCaptain(season.id, "Captain A", 100, 0);
  const b = await makeCaptain(season.id, "Captain B", 100, 1);
  const p = await makePlayer(season.id, "Purchase", 3300, { roles: "4,5" });
  const q = await makePlayer(season.id, "Second", 2800);
  return { actor, season, a, b, p, q };
}
async function start(f: Awaited<ReturnType<typeof setup>>) {
  expect(await startDraft(null, form({ expectedActiveSeasonId: f.season.id }))).toHaveProperty("message");
}
async function expectation(seasonId: string) {
  const draft = await prisma.draft.findUniqueOrThrow({ where: { seasonId } });
  return { currentLotId: draft.currentLotId, draftVersion: draft.updatedAt.getTime(),
    nominatedUserId: draft.nominatedUserId!, currentBid: draft.currentBid,
    currentBidTeamId: draft.currentBidTeamId!, bidEndsAt: draft.bidEndsAt!.getTime() };
}
async function sell(f: Awaited<ReturnType<typeof setup>>, userId = f.p.id, price = 7) {
  const current = await prisma.draft.findUniqueOrThrow({ where: { seasonId: f.season.id } });
  const captain = current.nominatorTeamId === f.a.team.id ? f.a.user : f.b.user;
  expect((await nominatePlayer(f.season.id, sessionFor(captain), userId, price)).ok).toBe(true);
  await expireClock(f.season.id);
  expect(await resolveExpiredNomination(f.season.id)).toBe(true);
}

describe("durable draft and roster history", () => {
  it.skipIf(!ON_POSTGRES)("a pause committed after a tracked bid read cannot rearm its clock or append a bid receipt", async () => {
    const f = await setup(); await start(f);
    await nominatePlayer(f.season.id, sessionFor(f.a.user), f.p.id, 3);
    const pinned = await expectation(f.season.id);
    beforeBidClaim = async () => { expect((await pauseDraft(f.season.id, f.actor)).ok).toBe(true); };
    expect((await placeBid(f.season.id, sessionFor(f.b.user), 5, pinned)).ok).toBe(false);
    expect(await prisma.draft.findUniqueOrThrow({ where: { seasonId: f.season.id } })).toMatchObject({ status: "PAUSED", bidEndsAt: null, currentBid: 3 });
    const lot = await prisma.draftLot.findUniqueOrThrow({ where: { id: pinned.currentLotId! } });
    expect(readAcceptedBids(lot.acceptedBidsSnapshot).bids.map((bid) => bid.amount)).toEqual([3]);
    expect(await prisma.bid.count({ where: { amount: 5 } })).toBe(0);
  });
  it("records opening policy, every accepted bid, sale and tenure while rejecting an omitted lot UUID on new runs", async () => {
    const f = await setup(); await start(f);
    const before = await prisma.draftRun.findFirstOrThrow();
    expect(JSON.parse(before.rulesSnapshot!).budgetMmrWeight).toBe(30);
    expect(JSON.parse(before.openingTeamsSnapshot!).teams[0].captainMmr).toBe(3000);
    expect((await nominatePlayer(f.season.id, sessionFor(f.a.user), f.p.id, 3)).ok).toBe(true);
    const pinned = await expectation(f.season.id);
    expect(pinned.currentLotId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await placeBid(f.season.id, sessionFor(f.b.user), 5)).ok).toBe(false);
    expect((await placeBid(f.season.id, sessionFor(f.b.user), 5, { ...pinned, currentLotId: null })).ok).toBe(false);
    expect((await placeBid(f.season.id, sessionFor(f.b.user), 5, { ...pinned, currentLotId: "previous-lot" })).ok).toBe(false);
    expect((await placeBid(f.season.id, sessionFor(f.b.user), 5, pinned)).ok).toBe(true);
    await expireClock(f.season.id); await resolveExpiredNomination(f.season.id);
    const lot = await prisma.draftLot.findFirstOrThrow();
    expect(lot).toMatchObject({ status: "SOLD", soldPrice: 5, soldTeamId: f.b.team.id });
    expect(readAcceptedBids(lot.acceptedBidsSnapshot).bids.map((bid) => bid.amount)).toEqual([3, 5]);
    const tenure = await prisma.rosterTenure.findFirstOrThrow({ where: { userId: f.p.id } });
    expect(tenure).toMatchObject({ acquisitionKind: "AUCTION", acquisitionMmr: 3300,
      rolesSnapshot: "4,5", isCaptainAtJoin: false, draftLotId: lot.id });
    await prisma.registration.update({ where: { seasonId_userId: { seasonId: f.season.id, userId: f.p.id } }, data: { mmr: 4500, roles: "1" } });
    await prisma.user.update({ where: { id: f.p.id }, data: { name: "Renamed later" } });
    expect((await getDraftState(f.season.id, null))!.recentSales[0]).toMatchObject({ name: "Purchase", price: 5 });
    expect(JSON.parse((await prisma.draftRun.findUniqueOrThrow({ where: { id: before.id } })).poolSnapshot!).players.find((p: { userId: string }) => p.userId === f.p.id).mmr).toBe(3300);
  });

  it("preserves void and undo receipts when the same player is nominated again", async () => {
    const f = await setup(); await start(f);
    await nominatePlayer(f.season.id, sessionFor(f.a.user), f.p.id, 9);
    const first = await prisma.draftLot.findFirstOrThrow();
    await pauseDraft(f.season.id, f.actor); await voidCurrentLot(f.season.id, f.actor); await resumeDraft(f.season.id, f.actor);
    await sell(f, f.p.id, 7);
    const sold = await prisma.draftLot.findFirstOrThrow({ where: { status: "SOLD" } });
    expect((await undoLastSale(f.season.id, f.actor)).ok).toBe(true);
    await nominatePlayer(f.season.id, sessionFor(f.a.user), f.p.id, 1);
    const old = await prisma.draftLot.findMany({ orderBy: { sequence: "asc" } });
    expect(old.map((lot) => lot.status)).toEqual(["VOIDED", "UNDONE", "OPEN"]);
    expect(old[0].id).toBe(first.id);
    expect(old[1]).toMatchObject({ id: sold.id, soldPrice: 7, reversalReason: "ADMIN_UNDO" });
    expect(old.map((lot) => readAcceptedBids(lot.acceptedBidsSnapshot).bids[0].amount)).toEqual([9, 7, 1]);
    expect((await getDraftState(f.season.id, null))!.lotBids.map((bid) => bid.amount)).toEqual([1]);
    expect(await prisma.rosterTenure.findUnique({ where: { sourceMembershipId: sold.sourceMembershipId! } })).toMatchObject({ endReason: "DRAFT_UNDO", openKey: null });
  });

  it("keeps a purchased captain's tenure and original paid sale through abort and restart", async () => {
    const f = await setup(); await start(f); await sell(f); await sell(f, f.q.id, 2);
    expect(await prisma.draftRun.findFirst()).toMatchObject({ status: "COMPLETE", endedAt: expect.any(Date) });
    const member = await prisma.teamMember.findUniqueOrThrow({ where: { seasonId_userId: { seasonId: f.season.id, userId: f.p.id } } });
    expect(await transferCaptaincy(null, form({ expectedActiveSeasonId: f.season.id, teamId: member.teamId,
      newCaptainUserId: f.p.id, expectedCaptainUserId: f.a.user.id }))).toHaveProperty("message");
    const tenureBefore = await prisma.rosterTenure.findUniqueOrThrow({ where: { sourceMembershipId: member.id } });
    expect((await abortDraft(f.season.id, f.actor)).ok).toBe(true);
    expect(await prisma.teamMember.findUnique({ where: { id: member.id } })).toMatchObject({ price: 0, isCaptain: true });
    expect(await prisma.rosterTenure.findUnique({ where: { id: tenureBefore.id } })).toMatchObject({ closedAt: null, acquisitionPrice: 7, isCaptainAtJoin: false });
    expect(await prisma.draftLot.findUnique({ where: { sourceMembershipId: member.id } })).toMatchObject({ status: "ABORTED", soldPrice: 7, reversalReason: "DRAFT_ABORT" });
    expect((await prisma.bid.count())).toBe(0);
    await start(f);
    const runs = await prisma.draftRun.findMany({ orderBy: { runNumber: "asc" } });
    expect(runs.map((run) => run.status)).toEqual(["ABORTED", "RUNNING"]);
    expect(runs[1].id).not.toBe(runs[0].id);
  });

  it("records automatic lots and an ineligible nominee as a void without a sale", async () => {
    const f = await setup(); await start(f);
    await expireNominationClock(f.season.id); await resolveStalledNomination(f.season.id);
    const lot = await prisma.draftLot.findFirstOrThrow();
    expect(lot.openingKind).toBe("AUTOMATIC");
    expect(readAcceptedBids(lot.acceptedBidsSnapshot).bids).toHaveLength(1);
    await prisma.registration.update({ where: { seasonId_userId: { seasonId: f.season.id, userId: lot.nominatedUserId! } }, data: { status: "WITHDRAWN" } });
    await expireClock(f.season.id); await resolveExpiredNomination(f.season.id);
    expect(await prisma.draftLot.findUnique({ where: { id: lot.id } })).toMatchObject({ status: "VOIDED", closeReason: "NOMINEE_NO_LONGER_ELIGIBLE", soldAt: null });
    expect(await prisma.teamMember.count({ where: { userId: lot.nominatedUserId! } })).toBe(0);
    expect(await prisma.bid.count({ where: { userId: lot.nominatedUserId! } })).toBe(0);
  });

  it("rolls back a claimed settlement when history storage fails", async () => {
    const f = await setup(); await start(f);
    await nominatePlayer(f.season.id, sessionFor(f.a.user), f.p.id, 12); await expireClock(f.season.id);
    const before = await prisma.draft.findUniqueOrThrow({ where: { seasonId: f.season.id } });
    const budget = (await prisma.team.findUniqueOrThrow({ where: { id: f.a.team.id } })).budget;
    failTenureWrite = true;
    await expect(resolveExpiredNomination(f.season.id)).rejects.toThrow("history storage unavailable");
    failTenureWrite = false;
    expect(await prisma.teamMember.count({ where: { userId: f.p.id } })).toBe(0);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: f.a.team.id } })).budget).toBe(budget);
    expect(await prisma.draftLot.findUnique({ where: { id: before.currentLotId! } })).toMatchObject({ status: "OPEN", soldPrice: null });
    expect(await prisma.draft.findUnique({ where: { seasonId: f.season.id } })).toMatchObject({ nominatedUserId: f.p.id, currentBid: 12, currentLotId: before.currentLotId });
  });

  it("closes a release and opens a free-agent tenure without erasing the original sale", async () => {
    const f = await setup(); await start(f); await sell(f); await sell(f, f.q.id, 2);
    const first = await prisma.teamMember.findUniqueOrThrow({ where: { seasonId_userId: { seasonId: f.season.id, userId: f.p.id } } });
    const second = await prisma.teamMember.findUniqueOrThrow({ where: { seasonId_userId: { seasonId: f.season.id, userId: f.q.id } } });
    for (const member of [first, second]) expect(await releasePlayer(null, form({ memberId: member.id }))).toHaveProperty("message");
    expect(await signFreeAgent(null, form({ userId: f.p.id, teamId: second.teamId }))).toHaveProperty("message");
    const tenures = await prisma.rosterTenure.findMany({ where: { userId: f.p.id }, orderBy: { joinedAt: "asc" } });
    expect(tenures).toHaveLength(2);
    expect(tenures[0]).toMatchObject({ teamId: first.teamId, endReason: "RELEASE", acquisitionPrice: 7 });
    expect(tenures[1]).toMatchObject({ teamId: second.teamId, acquisitionKind: "FREE_AGENT", acquisitionPrice: 0, closedAt: null });
    const originalSale = await prisma.draftLot.findUniqueOrThrow({ where: { sourceMembershipId: first.id } });
    expect(originalSale).toMatchObject({ status: "SOLD", soldPrice: 7 });
    // Abort refunds current memberships. The earlier released purchase is
    // history, even when the same person was subsequently signed elsewhere.
    expect((await abortDraft(f.season.id, f.actor)).ok).toBe(true);
    expect(await prisma.draftLot.findUnique({ where: { id: originalSale.id } })).toEqual(originalSale);
  });

  it("captures captain membership and preserves it when its team is removed", async () => {
    const f = await setup();
    expect(await addCaptain(null, form({ expectedActiveSeasonId: f.season.id, userId: f.p.id }))).toHaveProperty("message");
    const team = await prisma.team.findUniqueOrThrow({ where: { seasonId_captainId: { seasonId: f.season.id, captainId: f.p.id } } });
    expect(await removeCaptain(null, form({ expectedActiveSeasonId: f.season.id, teamId: team.id }))).toHaveProperty("message");
    expect(await prisma.rosterTenure.findFirst({ where: { userId: f.p.id } })).toMatchObject({
      acquisitionKind: "CAPTAIN_DESIGNATION", acquisitionMmr: 3300, isCaptainAtJoin: true,
      endReason: "PRE_DRAFT_TEAM_REMOVED", teamId: null, teamNameSnapshot: "Purchase's Team", openKey: null,
    });
  });

  it("bounds legacy backfill, leaves unknown acquisition facts null, and reconciles old-binary deletions honestly", async () => {
    const f = await setup();
    const first = await backfillRosterTenures({ actorId: f.actor.id, seasonId: f.season.id, limit: 1 });
    expect(first).toEqual({ captured: 1, reconciled: 0, remaining: 1 });
    await backfillRosterTenures({ actorId: f.actor.id, seasonId: f.season.id });
    const tenure = await prisma.rosterTenure.findFirstOrThrow({ where: { userId: f.a.user.id } });
    expect(tenure).toMatchObject({ acquisitionKind: "LEGACY_CAPTURE", acquisitionMmr: null, isCaptainAtJoin: null });
    await prisma.teamMember.delete({ where: { id: tenure.sourceMembershipId } });
    await prisma.teamMember.create({ data: { seasonId: f.season.id, teamId: f.a.team.id, userId: f.a.user.id, isCaptain: true } });
    expect(await backfillRosterTenures({ actorId: f.actor.id, seasonId: f.season.id })).toEqual({ captured: 1, reconciled: 1, remaining: 0 });
    expect(await prisma.rosterTenure.findUnique({ where: { id: tenure.id } })).toMatchObject({ openKey: null, endedAt: null, endProvenance: "OBSERVED_RECONCILIATION", closedAt: expect.any(Date) });
    expect(await backfillRosterTenures({ actorId: f.actor.id })).toEqual({ captured: 0, reconciled: 0, remaining: 0 });
  });

  it("captures an existing legacy draft before destructive undo without inventing opening rules", async () => {
    const f = await setup(); await startDraftState(f.season.id);
    const draft = await prisma.draft.findUniqueOrThrow({ where: { seasonId: f.season.id } });
    const member = await prisma.teamMember.create({ data: { seasonId: f.season.id, teamId: f.a.team.id, userId: f.p.id, price: 9 } });
    await prisma.bid.create({ data: { seasonId: f.season.id, draftId: draft.id, teamId: f.a.team.id, userId: f.p.id, amount: 9 } });
    await prisma.$transaction((tx) => captureRosterTenure(tx, member));
    expect((await undoLastSale(f.season.id, f.actor)).ok).toBe(true);
    const run = await prisma.draftRun.findFirstOrThrow();
    expect(run).toMatchObject({ provenance: "LEGACY_OBSERVATION", startedAt: null, rulesSnapshot: null, openingTeamsSnapshot: null });
    expect(JSON.parse(run.legacySnapshot!).bids).toHaveLength(1);
    expect(JSON.parse(run.legacySnapshot!).members.some((row: { id: string }) => row.id === member.id)).toBe(true);
    expect(await prisma.bid.count()).toBe(0);
  });

  it("does not disguise an unrelated history integrity failure as a harmless bootstrap conflict", async () => {
    const f = await setup(); await startDraftState(f.season.id);
    const draft = await prisma.draft.findUniqueOrThrow({ where: { seasonId: f.season.id } });
    const member = await prisma.teamMember.create({ data: { seasonId: f.season.id, teamId: f.a.team.id, userId: f.p.id, price: 9 } });
    const bid = await prisma.bid.create({ data: { seasonId: f.season.id, draftId: draft.id, teamId: f.a.team.id, userId: f.p.id, amount: 9 } });
    const budget = (await prisma.team.findUniqueOrThrow({ where: { id: f.a.team.id } })).budget;
    failRunIntegrity = true;
    await expect(undoLastSale(f.season.id, f.actor)).rejects.toThrow("unrelated history unique constraint");
    failRunIntegrity = false;
    expect(await prisma.teamMember.findUnique({ where: { id: member.id } })).toEqual(member);
    expect(await prisma.bid.findUnique({ where: { id: bid.id } })).toEqual(bid);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: f.a.team.id } })).budget).toBe(budget);
    expect(await prisma.draft.findUnique({ where: { id: draft.id } })).toEqual(draft);
    expect(await prisma.draftRun.count()).toBe(0);
    expect(await prisma.rosterTenure.count()).toBe(0);
    expect(await prisma.adminAction.count()).toBe(0);
  });

  it("preserves unexplained old-binary bids with honest provenance without rewriting a closed receipt", async () => {
    const f = await setup(); await start(f);
    await nominatePlayer(f.season.id, sessionFor(f.a.user), f.p.id, 3);
    const draft = await prisma.draft.findUniqueOrThrow({ where: { seasonId: f.season.id } });
    await prisma.bid.create({ data: { draftId: draft.id, seasonId: f.season.id, teamId: f.b.team.id, userId: f.p.id, amount: 8 } });
    await prisma.draft.update({ where: { id: draft.id }, data: { currentBid: 8, currentBidTeamId: f.b.team.id } });
    await expireClock(f.season.id); await resolveExpiredNomination(f.season.id);
    const lot = await prisma.draftLot.findUniqueOrThrow({ where: { id: draft.currentLotId! } });
    expect(readAcceptedBids(lot.acceptedBidsSnapshot)).toMatchObject({ provenance: "LEGACY_UNPARTITIONED" });
    expect(readAcceptedBids(lot.acceptedBidsSnapshot).bids.map((bid) => bid.amount)).toEqual([3, 8]);
    const stray = await prisma.bid.create({ data: { draftId: draft.id, seasonId: f.season.id,
      teamId: f.a.team.id, userId: f.p.id, amount: 4 } });
    expect((await undoLastSale(f.season.id, f.actor)).ok).toBe(true);
    expect((await prisma.draftLot.findUniqueOrThrow({ where: { id: lot.id } })).acceptedBidsSnapshot).toBe(lot.acceptedBidsSnapshot);
    const audit = await prisma.adminAction.findFirstOrThrow({ where: { action: "preserveUnpartitionedDraftBids" } });
    expect(JSON.parse(audit.detailsJson!).bids.map((bid: { id: string }) => bid.id)).toEqual([stray.id]);
    expect(await prisma.bid.count({ where: { userId: f.p.id } })).toBe(0);
  });
});
