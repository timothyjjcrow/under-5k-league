import { randomUUID } from "node:crypto";
import type { Bid, Draft, DraftLot, DraftRun, Prisma, TeamMember } from "@prisma/client";
import { DEFAULTS } from "./constants";
import type { DraftedPlayer } from "./draft-recap";
import { captureRosterTenure, type HistoryActor, recordHistoryAction } from "./roster-history";
import { raceHook } from "./race-hook";

type Tx = Prisma.TransactionClient;
type BidReceipt = { bidId: string; teamId: string; teamName: string; amount: number; at: string };
type BidSnapshot = { version: 1; provenance: "COMMAND" | "LEGACY_UNPARTITIONED"; bids: BidReceipt[] };

export class DraftHistoryRaceError extends Error {}

function readObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DRAFT_HISTORY_INVALID_SNAPSHOT");
  return value as Record<string, unknown>;
}

export function readAcceptedBids(raw: string): BidSnapshot {
  const value = readObject(raw);
  if (value.version !== 1 || !["COMMAND", "LEGACY_UNPARTITIONED"].includes(String(value.provenance)) ||
      !Array.isArray(value.bids) || !value.bids.every((bid: unknown) => {
        if (!bid || typeof bid !== "object") return false;
        const b = bid as Record<string, unknown>;
        return typeof b.bidId === "string" && typeof b.teamId === "string" && typeof b.teamName === "string" &&
          Number.isSafeInteger(b.amount) && Number(b.amount) > 0 && typeof b.at === "string" && Number.isFinite(Date.parse(b.at));
      })) throw new Error("DRAFT_HISTORY_INVALID_BIDS");
  return value as unknown as BidSnapshot;
}

async function nextRunNumber(tx: Tx, seasonId: string) {
  const last = await tx.draftRun.findFirst({ where: { seasonId }, orderBy: { runNumber: "desc" }, select: { runNumber: true } });
  return (last?.runNumber ?? 0) + 1;
}

export async function startDraftRun(tx: Tx, input: {
  seasonId: string; actor: HistoryActor;
  rules: { teamSize: number; draftBudget: number; budgetMmrWeight: number };
  teams: { id: string; name: string; captainId: string; draftOrder: number }[];
  registrations: { userId: string; mmr: number; roles: string }[];
  budgets: Map<string, number>;
}, now = new Date()) {
  const byUser = new Map(input.registrations.map((r) => [r.userId, r]));
  const run = await tx.draftRun.create({ data: {
    seasonId: input.seasonId, runNumber: await nextRunNumber(tx, input.seasonId),
    provenance: "COMMAND", status: "RUNNING", startedAt: now, startedById: input.actor.id,
    rulesSnapshot: JSON.stringify({ version: 1, ...input.rules, minimumBid: DEFAULTS.MIN_BID,
      bidTimerSeconds: DEFAULTS.BID_TIMER_SECONDS, nominationTimerSeconds: DEFAULTS.NOMINATION_TIMER_SECONDS,
      budgetAlgorithm: "mmrWeightedBudgets-v1" }),
    openingTeamsSnapshot: JSON.stringify({ version: 1, teams: input.teams.map((team) => ({
      ...team, captainMmr: byUser.get(team.captainId)?.mmr || null,
      ratingSource: "REGISTRATION_AT_START", ratingAt: now.toISOString(), budget: input.budgets.get(team.id),
    })) }),
    poolSnapshot: JSON.stringify({ version: 1, observedAt: now.toISOString(), players: input.registrations }),
  } });
  await tx.draft.update({ where: { seasonId: input.seasonId }, data: { activeRunId: run.id, currentLotId: null } });
  return run;
}

/** Capture only facts still present. Missing prior bids, opening budgets and
 * old run boundaries stay explicitly unknown. Call after the command's claim,
 * before destructive Bid sweeps; pass a pre-delete member for legacy undo. */
export async function ensureDraftRun(tx: Tx, draft: Draft, removedMember?: TeamMember, now = new Date()): Promise<DraftRun> {
  const current = await tx.draft.findUniqueOrThrow({ where: { id: draft.id } });
  const id = current.activeRunId ?? draft.activeRunId;
  if (id) return tx.draftRun.findUniqueOrThrow({ where: { id } });
  // Undo can reach history after deleting its member but before its final
  // Draft claim. Serialize legacy bootstrap on the singleton before choosing
  // a run number: a unique-conflict catch after create cannot recover a
  // PostgreSQL transaction, and could hide an unrelated integrity failure.
  await raceHook("draft.ensureDraftRun.beforeClaim");
  const claimed = await tx.draft.updateMany({
    where: { id: current.id, activeRunId: null, updatedAt: current.updatedAt },
    // This write acquires the row lock without changing the caller's clock
    // version. The actual history pointer write below advances it as usual.
    data: { updatedAt: current.updatedAt },
  });
  if (claimed.count !== 1) throw new DraftHistoryRaceError("The auction history just changed — reload and try again.");
  const [bids, members] = await Promise.all([
    tx.bid.findMany({ where: { draftId: draft.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    tx.teamMember.findMany({ where: { seasonId: draft.seasonId } }),
  ]);
  if (removedMember && !members.some((member) => member.id === removedMember.id)) members.push(removedMember);
  const run = await tx.draftRun.create({ data: {
    seasonId: draft.seasonId, runNumber: await nextRunNumber(tx, draft.seasonId),
    provenance: "LEGACY_OBSERVATION", status: draft.status === "COMPLETE" ? "COMPLETE" : "RUNNING",
    recordedAt: now, legacySnapshot: JSON.stringify({ version: 1, observedAt: now.toISOString(),
      completeness: "REMAINING_ROWS_ONLY", draft, bids, members }),
  } });
  await tx.draft.update({ where: { id: draft.id }, data: { activeRunId: run.id } });
  return run;
}

async function lotSnapshots(tx: Tx, userId: string, teamId: string | null, seasonId: string, exact: boolean, now: Date) {
  const [user, team, reg] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } }),
    teamId ? tx.team.findUnique({ where: { id: teamId }, select: { name: true } }) : null,
    tx.registration.findUnique({ where: { seasonId_userId: { seasonId, userId } }, select: { mmr: true, roles: true } }),
  ]);
  return {
    nomineeSnapshot: JSON.stringify({ version: 1, userId, name: user.name,
      mmr: exact ? reg?.mmr || null : null, roles: exact ? reg?.roles ?? null : null,
      factsObservedAt: now.toISOString() }),
    nominatorSnapshot: JSON.stringify({ version: 1, teamId, name: team?.name ?? null }),
  };
}

export async function openDraftLot(tx: Tx, draft: Draft, input: {
  userId: string; teamId: string; kind: "MANUAL" | "AUTOMATIC"; actorId?: string;
}, now = new Date()) {
  const run = await ensureDraftRun(tx, draft, undefined, now);
  const sequence = run.nextLotSequence;
  const claimed = await tx.draftRun.updateMany({ where: { id: run.id, nextLotSequence: sequence, status: "RUNNING" },
    data: { nextLotSequence: { increment: 1 } } });
  if (claimed.count !== 1) throw new Error("DRAFT_HISTORY_RUN_CHANGED");
  const lot = await tx.draftLot.create({ data: {
    id: randomUUID(), runId: run.id, sequence, provenance: "COMMAND", openedAt: now,
    openedById: input.actorId ?? null, openingKind: input.kind, nominatedUserId: input.userId,
    nominatorTeamId: input.teamId, status: "OPEN",
    ...await lotSnapshots(tx, input.userId, input.teamId, draft.seasonId, true, now),
    acceptedBidsSnapshot: JSON.stringify({ version: 1, provenance: "COMMAND", bids: [] }),
  } });
  await tx.draft.update({ where: { id: draft.id }, data: { currentLotId: lot.id } });
  return lot;
}

/** Exact tracked lots are mandatory; only a genuinely legacy state can create
 * an observation of its currently open lot. Its remaining Bid rows have no
 * trustworthy nomination boundary, so their provenance says so. */
export async function ensureCurrentDraftLot(tx: Tx, draft: Draft, now = new Date()): Promise<DraftLot> {
  if (draft.currentLotId) {
    const lot = await tx.draftLot.findUniqueOrThrow({ where: { id: draft.currentLotId } });
    if (lot.status !== "OPEN" || lot.nominatedUserId !== draft.nominatedUserId || lot.runId !== draft.activeRunId) {
      throw new Error("DRAFT_HISTORY_LOT_CHANGED");
    }
    return lot;
  }
  const run = await ensureDraftRun(tx, draft, undefined, now);
  if (run.provenance !== "LEGACY_OBSERVATION" || !draft.nominatedUserId) throw new Error("DRAFT_HISTORY_MISSING_LOT");
  const bids = await tx.bid.findMany({ where: { draftId: draft.id, userId: draft.nominatedUserId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { team: { select: { name: true } } } });
  const lot = await tx.draftLot.create({ data: {
    id: randomUUID(), runId: run.id, sequence: null, provenance: "LEGACY_OBSERVATION",
    recordedAt: now, openingKind: "LEGACY_OBSERVATION", nominatedUserId: draft.nominatedUserId,
    nominatorTeamId: draft.nominatorTeamId, status: "OPEN",
    ...await lotSnapshots(tx, draft.nominatedUserId, draft.nominatorTeamId, draft.seasonId, false, now),
    acceptedBidsSnapshot: JSON.stringify({ version: 1, provenance: "LEGACY_UNPARTITIONED",
      bids: bids.map((bid) => ({ bidId: bid.id, teamId: bid.teamId, teamName: bid.team.name, amount: bid.amount, at: bid.createdAt.toISOString() })) }),
  } });
  await tx.draft.update({ where: { id: draft.id }, data: { currentLotId: lot.id } });
  return lot;
}

export async function appendAcceptedDraftBid(tx: Tx, lot: DraftLot, bid: Bid, teamName: string) {
  const snapshot = readAcceptedBids(lot.acceptedBidsSnapshot);
  if (snapshot.bids.some((receipt) => receipt.bidId === bid.id)) throw new Error("DRAFT_HISTORY_DUPLICATE_BID");
  snapshot.bids.push({ bidId: bid.id, teamId: bid.teamId, teamName, amount: bid.amount, at: bid.createdAt.toISOString() });
  const changed = await tx.draftLot.updateMany({
    where: { id: lot.id, status: "OPEN", acceptedBidsSnapshot: lot.acceptedBidsSnapshot },
    data: { acceptedBidsSnapshot: JSON.stringify(snapshot) },
  });
  if (changed.count !== 1) throw new Error("DRAFT_HISTORY_BID_CHANGED");
}

/** A previous application binary may have accepted operational bids without
 * dual-writing receipts. Preserve them before closure, but do not invent a
 * nomination boundary for unexplained rows sharing this player ID. */
async function preserveUnrecordedOpenBids(tx: Tx, draft: Draft, lot: DraftLot) {
  const snapshot = readAcceptedBids(lot.acceptedBidsSnapshot);
  const known = new Set(snapshot.bids.map((bid) => bid.bidId));
  const rows = await tx.bid.findMany({
    where: { draftId: draft.id, userId: lot.nominatedUserId ?? "" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { team: { select: { name: true } } },
  });
  const missing = rows.filter((row) => !known.has(row.id));
  if (!missing.length) return;
  snapshot.provenance = "LEGACY_UNPARTITIONED";
  snapshot.bids.push(...missing.map((bid) => ({ bidId: bid.id, teamId: bid.teamId,
    teamName: bid.team.name, amount: bid.amount, at: bid.createdAt.toISOString() })));
  snapshot.bids.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.bidId.localeCompare(b.bidId));
  const changed = await tx.draftLot.updateMany({
    where: { id: lot.id, status: "OPEN", acceptedBidsSnapshot: lot.acceptedBidsSnapshot },
    data: { acceptedBidsSnapshot: JSON.stringify(snapshot) },
  });
  if (changed.count !== 1) throw new Error("DRAFT_HISTORY_BID_CHANGED");
}

export async function settleDraftLot(tx: Tx, draft: Draft, member: TeamMember, mmr: number, roles: string, now = new Date()) {
  const lot = await ensureCurrentDraftLot(tx, draft, now);
  await preserveUnrecordedOpenBids(tx, draft, lot);
  const team = await tx.team.findUniqueOrThrow({ where: { id: member.teamId }, select: { name: true } });
  const changed = await tx.draftLot.updateMany({ where: { id: lot.id, status: "OPEN" }, data: {
    status: "SOLD", closedAt: now, soldAt: now, soldPrice: member.price,
    soldTeamId: member.teamId, soldTeamNameSnapshot: team.name, sourceMembershipId: member.id,
  } });
  if (changed.count !== 1) throw new Error("DRAFT_HISTORY_SALE_CHANGED");
  await captureRosterTenure(tx, member, { kind: "AUCTION", mmr: mmr || null, roles, draftLotId: lot.id }, now);
  await tx.draft.update({ where: { id: draft.id }, data: { currentLotId: null } });
}

export async function voidDraftLot(tx: Tx, draft: Draft, reason: string, actorId: string | null, now = new Date()) {
  const lot = await ensureCurrentDraftLot(tx, draft, now);
  await preserveUnrecordedOpenBids(tx, draft, lot);
  const changed = await tx.draftLot.updateMany({ where: { id: lot.id, status: "OPEN" },
    data: { status: "VOIDED", closedAt: now, closeReason: reason, closedById: actorId } });
  if (changed.count !== 1) throw new Error("DRAFT_HISTORY_LOT_CHANGED");
  await tx.draft.update({ where: { id: draft.id }, data: { currentLotId: null } });
}

export async function setDraftRunStatus(tx: Tx, draft: Draft, status: "RUNNING" | "COMPLETE", now = new Date()) {
  const run = await ensureDraftRun(tx, draft, undefined, now);
  await tx.draftRun.update({ where: { id: run.id }, data: { status, endedAt: status === "COMPLETE" ? now : null } });
}

export async function undoDraftSaleHistory(tx: Tx, draft: Draft, member: TeamMember, actor: HistoryActor, now = new Date()) {
  const run = await ensureDraftRun(tx, draft, member, now);
  const lot = await tx.draftLot.findUnique({ where: { sourceMembershipId: member.id } });
  if (!lot) {
    if (run.provenance !== "LEGACY_OBSERVATION") throw new Error("DRAFT_HISTORY_MISSING_SALE");
    await recordHistoryAction(tx, actor, draft.seasonId, "undoLegacyDraftSale", "Undid an observed legacy roster purchase; original lot is unknown", {
      sourceMembershipId: member.id, userId: member.userId, teamId: member.teamId, observedPrice: member.price,
    });
    return;
  }
  if (lot.status !== "SOLD" || lot.soldTeamId !== member.teamId || lot.soldPrice !== member.price || lot.runId !== run.id) {
    throw new Error("DRAFT_HISTORY_SALE_CHANGED");
  }
  const known = new Set(readAcceptedBids(lot.acceptedBidsSnapshot).bids.map((bid) => bid.bidId));
  const unexplained = (await tx.bid.findMany({ where: { draftId: draft.id, userId: member.userId } }))
    .filter((bid) => !known.has(bid.id));
  if (unexplained.length) {
    // A closed receipt is immutable: retain extra old-binary rows in a
    // separately labeled audit instead of changing the settled collection.
    await recordHistoryAction(tx, actor, draft.seasonId, "preserveUnpartitionedDraftBids",
      "Preserved operational bids with unknown lot boundaries before undo", {
        runId: run.id, lotId: lot.id, provenance: "LEGACY_UNPARTITIONED", bids: unexplained,
      });
  }
  await tx.draftLot.update({ where: { id: lot.id }, data: {
    status: "UNDONE", reversedAt: now, reversalReason: "ADMIN_UNDO", reversedById: actor.id,
  } });
}

export async function abortDraftHistory(tx: Tx, draft: Draft, members: TeamMember[], actor: HistoryActor, now = new Date()) {
  const run = await ensureDraftRun(tx, draft, undefined, now);
  if (draft.nominatedUserId) {
    const lot = await ensureCurrentDraftLot(tx, { ...draft, activeRunId: run.id }, now);
    await preserveUnrecordedOpenBids(tx, draft, lot);
    await tx.draftLot.update({ where: { id: lot.id }, data: {
      status: "ABORTED", closedAt: now, closeReason: "DRAFT_ABORT", closedById: actor.id,
    } });
  }
  // Reverse only acquisitions still refunded by this abort. A player released
  // earlier already got a release refund; their original sale stays historical.
  await tx.draftLot.updateMany({ where: { runId: run.id, status: "SOLD", sourceMembershipId: { in: members.map((m) => m.id) } },
    data: { status: "ABORTED", reversedAt: now, reversalReason: "DRAFT_ABORT", reversedById: actor.id } });
  await tx.draftRun.update({ where: { id: run.id }, data: { status: "ABORTED", endedAt: now } });
  await recordHistoryAction(tx, actor, draft.seasonId, "abortDraftHistory",
    "Aborted the draft run while preserving its bids, sales and roster acquisitions", {
      runId: run.id, provenance: run.provenance, effectiveAt: now.toISOString(),
      observedMembershipIds: members.map((member) => member.id),
      // Preserve even unexplained old-binary rows before the whole operational
      // Bid table is swept. These are observed rows, not inferred exact lots.
      remainingOperationalBids: await tx.bid.findMany({ where: { draftId: draft.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    });
  await tx.draft.update({ where: { id: draft.id }, data: { activeRunId: null, currentLotId: null } });
}

export function draftLotPlayer(lot: DraftLot): DraftedPlayer & { at: number } {
  const nominee = readObject(lot.nomineeSnapshot);
  if (nominee.version !== 1 || typeof nominee.name !== "string" || lot.soldPrice == null || !lot.soldAt) throw new Error("DRAFT_HISTORY_INVALID_SALE");
  return { name: nominee.name, ...(lot.soldTeamId ? { teamId: lot.soldTeamId } : {}), teamName: lot.soldTeamNameSnapshot ?? "Former team", price: lot.soldPrice,
    isCaptain: false, mmr: typeof nominee.mmr === "number" && nominee.mmr > 0 ? nominee.mmr : null, at: lot.soldAt.getTime() };
}

export async function readDraftSales(tx: Pick<Tx, "draftLot">, runId: string) {
  return (await tx.draftLot.findMany({ where: { runId, status: "SOLD" }, orderBy: [{ soldAt: "desc" }, { sequence: "desc" }, { id: "desc" }] }))
    .map(draftLotPlayer);
}
