import { Prisma, type TeamMember } from "@prisma/client";
import { prisma } from "./prisma";
import { requireAdmin } from "./auth";
import { parseAdminSteamIds, resolveSessionRole } from "./users";

type Tx = Prisma.TransactionClient;
export type HistoryActor = { id: string; name: string };
type MemberFacts = Pick<TeamMember, "id" | "seasonId" | "teamId" | "userId" | "price" | "isCaptain" | "createdAt">;

type Acquisition = {
  kind: "CAPTAIN_DESIGNATION" | "AUCTION" | "FREE_AGENT";
  mmr: number | null;
  roles: string | null;
  actorId?: string | null;
  draftLotId?: string | null;
};

/** Called only inside the winning command transaction. Legacy observations do
 * not turn today's MMR/captain flag into an acquisition fact. */
export async function captureRosterTenure(
  tx: Tx,
  member: MemberFacts,
  acquisition?: Acquisition,
  now = new Date(),
) {
  const existing = await tx.rosterTenure.findUnique({ where: { sourceMembershipId: member.id } });
  if (existing) return existing;
  const openKey = JSON.stringify([member.seasonId, member.userId]);
  const previous = await tx.rosterTenure.findUnique({ where: { openKey } });
  if (previous) {
    const source = await tx.teamMember.findUnique({ where: { id: previous.sourceMembershipId }, select: { id: true } });
    if (source) throw new Error("ROSTER_HISTORY_CONFLICT: another membership is still open");
    // An older binary can delete a member without closing its tenure. We know
    // it is gone now, not when it left; never fabricate an exact departure.
    await tx.rosterTenure.update({ where: { id: previous.id }, data: {
      openKey: null, closedAt: now, endedAt: null,
      endProvenance: "OBSERVED_RECONCILIATION", endReason: "MEMBERSHIP_NO_LONGER_PRESENT",
    } });
  }
  const [user, team] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: member.userId }, select: { name: true } }),
    tx.team.findUniqueOrThrow({ where: { id: member.teamId }, select: { name: true } }),
  ]);
  return tx.rosterTenure.create({ data: {
    seasonId: member.seasonId, teamId: member.teamId, userId: member.userId,
    sourceMembershipId: member.id, openKey, joinedAt: member.createdAt,
    recordedAt: now, startProvenance: acquisition ? "COMMAND" : "LEGACY_ROW",
    acquisitionKind: acquisition?.kind ?? "LEGACY_CAPTURE",
    acquisitionPrice: member.price, acquisitionMmr: acquisition?.mmr ?? null,
    rolesSnapshot: acquisition?.roles ?? null,
    isCaptainAtJoin: acquisition ? member.isCaptain : null,
    createdById: acquisition?.actorId ?? null, draftLotId: acquisition?.draftLotId ?? null,
    playerNameSnapshot: user.name, teamNameSnapshot: team.name,
  } });
}

/** The caller supplies the pre-delete row, so capture also works when this
 * command won its deleteMany claim before the backfill reached the member. */
export async function closeRosterTenure(
  tx: Tx, member: MemberFacts, reason: string, actorId: string | null, now = new Date(),
) {
  const tenure = await captureRosterTenure(tx, member, undefined, now);
  const closed = await tx.rosterTenure.updateMany({
    where: { id: tenure.id, closedAt: null },
    data: { openKey: null, endedAt: now, closedAt: now, endProvenance: "COMMAND",
      endReason: reason, endedById: actorId },
  });
  if (closed.count !== 1) throw new Error("ROSTER_HISTORY_CONFLICT: tenure is already closed");
}

/** Required audit for authority changes and legacy recovery whose exact facts
 * cannot be represented as a known original auction lot. No best-effort catch. */
export async function recordHistoryAction(
  tx: Tx, actor: HistoryActor, seasonId: string, action: string,
  summary: string, details: Record<string, unknown>,
) {
  await tx.adminAction.create({ data: {
    actorId: actor.id, actorName: actor.name, seasonId, action,
    summary: summary.slice(0, 500), detailsJson: JSON.stringify({ version: 1, ...details }),
  } });
}


/** Bounded repair of stored membership facts only. Each row gets a short
 * transaction and an authorization recheck; no provider reads or notifications. */
export async function backfillRosterTenures(input: {
  actorId: string; seasonId?: string; limit?: number;
}): Promise<{ captured: number; reconciled: number; remaining: number }> {
  const actor = await requireAdmin();
  if (actor.id !== input.actorId) throw new Error("Not authorized");
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 50) || 50));
  const tenureScope = input.seasonId ? Prisma.sql`AND t."seasonId" = ${input.seasonId}` : Prisma.empty;
  const memberScope = input.seasonId ? Prisma.sql`AND m."seasonId" = ${input.seasonId}` : Prisma.empty;
  const stale = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT t.id FROM "RosterTenure" t LEFT JOIN "TeamMember" m ON m.id = t."sourceMembershipId"
    WHERE t."openKey" IS NOT NULL AND m.id IS NULL ${tenureScope} ORDER BY t.id LIMIT ${limit}`);
  let captured = 0;
  let reconciled = 0;
  const checkActor = async (tx: Tx) => {
    const current = await tx.user.findUnique({ where: { id: actor.id }, select: { role: true, steamId: true } });
    if (!current || resolveSessionRole({ steamId: current.steamId, storedRole: current.role,
      adminSteamIds: parseAdminSteamIds(process.env.ADMIN_STEAM_IDS),
      production: process.env.NODE_ENV === "production" }) !== "ADMIN") throw new Error("Not authorized");
  };
  for (const row of stale) {
    reconciled += await prisma.$transaction(async (tx) => {
      await checkActor(tx);
      const tenure = await tx.rosterTenure.findUnique({ where: { id: row.id } });
      if (!tenure?.openKey || await tx.teamMember.findUnique({ where: { id: tenure.sourceMembershipId } })) return 0;
      return (await tx.rosterTenure.updateMany({ where: { id: tenure.id, openKey: tenure.openKey, closedAt: null }, data: {
        openKey: null, closedAt: new Date(), endedAt: null, endProvenance: "OBSERVED_RECONCILIATION",
        endReason: "MEMBERSHIP_NO_LONGER_PRESENT", endedById: actor.id,
      } })).count;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  const missing = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT m.id FROM "TeamMember" m LEFT JOIN "RosterTenure" t ON t."sourceMembershipId" = m.id
    WHERE t.id IS NULL ${memberScope} ORDER BY m.id LIMIT ${limit - stale.length}`);
  for (const row of missing) {
    captured += await prisma.$transaction(async (tx) => {
      await checkActor(tx);
      const member = await tx.teamMember.findUnique({ where: { id: row.id } });
      if (!member || await tx.rosterTenure.findUnique({ where: { sourceMembershipId: row.id } })) return 0;
      await captureRosterTenure(tx, member);
      return 1;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  const [counts] = await prisma.$queryRaw<{ remaining: bigint | number }[]>(Prisma.sql`
    SELECT (
      (SELECT COUNT(*) FROM "TeamMember" m LEFT JOIN "RosterTenure" t ON t."sourceMembershipId" = m.id WHERE t.id IS NULL ${memberScope}) +
      (SELECT COUNT(*) FROM "RosterTenure" t LEFT JOIN "TeamMember" m ON m.id = t."sourceMembershipId" WHERE t."openKey" IS NOT NULL AND m.id IS NULL ${tenureScope})
    ) AS remaining`);
  return { captured, reconciled, remaining: Number(counts.remaining) };
}
