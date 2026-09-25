import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { effectiveDotaAccountId } from "./dota-account";
import { matchCheckinOpen } from "./league-lifecycle";
import { singleActiveSeason } from "./season";
import { UserFacingError } from "./user-facing-error";
import { stampResultChange } from "./settings";
import { parseAdminSteamIds, resolveSessionRole } from "./users";

type LineupDb = Pick<Prisma.TransactionClient, "match" | "matchLineup">;
export type LineupActor = { id: string; name: string; role: string };
export type LineupSelection = { userId: string; position: number | null };

/** Close future validity only. Prior seats and their earlier game-time proof
 * remain immutable, including when a player leaves during a live series. */
export async function invalidateMatchLineups(
  tx: LineupDb, matchId: string, reason: string, now = new Date(), teamId?: string,
): Promise<void> {
  const changed = await tx.match.updateMany({
    where: { id: matchId, status: { in: ["SCHEDULED", "LIVE"] } },
    data: { logisticsRevision: { increment: 1 } },
  });
  if (!changed.count) return;
  await tx.matchLineup.updateMany({
    where: { matchId, ...(teamId ? { teamId } : {}), activeKey: { not: null }, status: "CONFIRMED" },
    data: { status: "SUPERSEDED", activeKey: null, supersededAt: now, reason },
  });
}

export async function invalidateTeamLineups(
  tx: LineupDb, teamId: string, reason: string, now = new Date(),
): Promise<void> {
  const matches = await tx.match.findMany({
    where: {
      status: { in: ["SCHEDULED", "LIVE"] },
      OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
    },
    select: { id: true },
  });
  for (const match of matches) await invalidateMatchLineups(tx, match.id, reason, now, teamId);
}

/** Shared server-side candidate projection. A legacy booking proves an
 * assignment, never the standin's acceptance of an offer that did not exist. */
export async function loadLineupCandidates(
  db: Pick<Prisma.TransactionClient, "teamMember" | "standinAssignment" | "registration" | "matchAvailability" | "rosterTenure">,
  match: { id: string; seasonId: string; scheduleRevision: number },
  teamId: string,
) {
  const [members, assignments] = await Promise.all([
    db.teamMember.findMany({ where: { seasonId: match.seasonId, teamId }, include: { user: true }, orderBy: { createdAt: "asc" } }),
    db.standinAssignment.findMany({ where: { matchId: match.id, teamId }, include: { standin: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const memberIds = new Set(members.map((member) => member.userId));
  const applicable = assignments.filter((a) => a.replacingUserId == null || memberIds.has(a.replacingUserId));
  const replaced = new Set(applicable.map((a) => a.replacingUserId));
  const candidates = [
    ...members.filter((member) => !replaced.has(member.userId)).map((member) => ({
      user: member.user, seatKey: `roster:${member.userId}`, entryKind: "ROSTER",
      acceptanceStatusSnapshot: "NOT_APPLICABLE", replacingUserId: null as string | null,
      assignmentId: null as string | null, sourceMembershipId: member.id,
    })),
    ...applicable.map((assignment) => ({
      user: assignment.standin,
      seatKey: assignment.replacingUserId ? `roster:${assignment.replacingUserId}` : `vacant:${assignment.id}`,
      entryKind: "STANDIN", acceptanceStatusSnapshot: "UNKNOWN",
      replacingUserId: assignment.replacingUserId, assignmentId: assignment.id,
      sourceMembershipId: null as string | null,
    })),
  ];
  const ids = candidates.map((candidate) => candidate.user.id);
  const [registrations, availability, tenures, seasonMemberships] = await Promise.all([
    db.registration.findMany({ where: { seasonId: match.seasonId, userId: { in: ids } }, select: { userId: true, mmr: true, status: true } }),
    db.matchAvailability.findMany({ where: { matchId: match.id, scheduleRevision: match.scheduleRevision, userId: { in: ids } } }),
    db.rosterTenure.findMany({ where: { sourceMembershipId: { in: members.map((member) => member.id) }, closedAt: null }, select: { id: true, sourceMembershipId: true } }),
    db.teamMember.findMany({ where: { seasonId: match.seasonId, userId: { in: ids } }, select: { userId: true } }),
  ]);
  const registrationOf = new Map(registrations.map((r) => [r.userId, r]));
  const availabilityOf = new Map(availability.map((r) => [r.userId, r]));
  const tenureOf = new Map(tenures.map((r) => [r.sourceMembershipId, r.id]));
  const rostered = new Set(seasonMemberships.map((member) => member.userId));
  return candidates.map(({ user, sourceMembershipId, ...candidate }) => ({
    ...candidate, userId: user.id, userName: user.name,
    accountId: effectiveDotaAccountId(user),
    mmr: registrationOf.get(user.id)?.mmr || null,
    eligible: candidate.entryKind === "ROSTER" || ((!registrationOf.has(user.id) || registrationOf.get(user.id)?.status === "ACTIVE") && !rostered.has(user.id)),
    availability: availabilityOf.get(user.id) ?? null,
    sourceTenureId: sourceMembershipId ? tenureOf.get(sourceMembershipId) ?? null : null,
  }));
}

export async function confirmMatchLineup(opts: {
  actor: LineupActor; matchId: string; teamId: string;
  expectedScheduleRevision: number; expectedLogisticsRevision: number;
  expectedLineupRevision: number; selections: LineupSelection[];
}) {
  if (!opts.matchId || !opts.teamId ||
      ![opts.expectedScheduleRevision, opts.expectedLogisticsRevision, opts.expectedLineupRevision].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new UserFacingError("Reload the match before confirming its lineup.");
  }
  if (opts.selections.some((s) => !s.userId || (s.position != null && (!Number.isInteger(s.position) || s.position < 1 || s.position > 5)))) {
    throw new UserFacingError("Choose valid players and optional planned positions 1–5.");
  }
  return prisma.$transaction(async (tx) => {
    const [active, match, actor] = await Promise.all([
      tx.season.findMany({ where: { isActive: true }, take: 2, orderBy: { createdAt: "desc" }, select: { id: true } }).then(singleActiveSeason),
      tx.match.findUnique({ where: { id: opts.matchId }, include: {
        season: { include: { draft: { select: { status: true } } } },
        homeTeam: { select: { captainId: true, withdrawn: true } },
        awayTeam: { select: { captainId: true, withdrawn: true } },
      } }),
      tx.user.findUnique({ where: { id: opts.actor.id }, select: { id: true, name: true, steamId: true, role: true } }),
    ]);
    if (!match || !active || active.id !== match.seasonId) throw new UserFacingError("That match is not in the active season.");
    const team = opts.teamId === match.homeTeamId ? match.homeTeam : opts.teamId === match.awayTeamId ? match.awayTeam : null;
    const isAdmin = actor && resolveSessionRole({ steamId: actor.steamId, storedRole: actor.role, adminSteamIds: parseAdminSteamIds(process.env.ADMIN_STEAM_IDS), production: process.env.NODE_ENV === "production" }) === "ADMIN";
    if (!actor || !team || (!isAdmin && team.captainId !== actor.id)) throw new UserFacingError("Only this team's captain or an admin can confirm its lineup.");
    if (team.withdrawn) throw new UserFacingError("A withdrawn team cannot confirm a playing lineup.");
    const now = new Date();
    if (!matchCheckinOpen(match.season.status, match.season.draft?.status, match.status, match.scheduledAt, now.getTime())) {
      throw new UserFacingError("Lineup confirmation is closed for this fixture. Check the league phase and published kickoff.");
    }
    if (match.scheduleRevision !== opts.expectedScheduleRevision || match.logisticsRevision !== opts.expectedLogisticsRevision) {
      throw new UserFacingError("The kickoff or playing roster changed — reload and review the current check-ins.");
    }
    const latest = await tx.matchLineup.findFirst({ where: { matchId: match.id, teamId: opts.teamId }, orderBy: { revision: "desc" } });
    if ((latest?.revision ?? 0) !== opts.expectedLineupRevision) throw new UserFacingError("Another lineup was saved — reload before replacing it.");
    if (opts.selections.length !== match.season.teamSize || new Set(opts.selections.map((s) => s.userId)).size !== match.season.teamSize) {
      throw new UserFacingError(`Select exactly ${match.season.teamSize} different players for this team.`);
    }
    const positions = opts.selections.flatMap((s) => s.position == null ? [] : [s.position]);
    if (new Set(positions).size !== positions.length) throw new UserFacingError("Each planned position can be assigned to only one player.");
    const candidates = await loadLineupCandidates(tx, match, opts.teamId);
    const selected = opts.selections.map((selection) => {
      const matches = candidates.filter((candidate) => candidate.userId === selection.userId);
      if (matches.length !== 1 || !matches[0].eligible) throw new UserFacingError("A selected player no longer has an eligible roster or cover assignment.");
      const candidate = matches[0];
      if (candidate.availability?.status !== "IN") throw new UserFacingError(`${candidate.userName} must check in for the current kickoff before the lineup can be confirmed.`);
      return { ...candidate, position: selection.position };
    });
    if (new Set(selected.map((s) => s.seatKey)).size !== selected.length) throw new UserFacingError("Two selected players cover the same seat. Correct the assignments first.");
    const accounts = selected.flatMap((s) => s.accountId == null ? [] : [s.accountId]);
    if (new Set(accounts).size !== accounts.length) throw new UserFacingError("Two selected players share a Dota account. Correct their account links first.");
    const compositionFingerprint = createHash("sha256").update(JSON.stringify(selected.map((s) => [s.seatKey, s.userId, s.accountId, s.position, s.assignmentId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex");
    if (latest?.activeKey && latest.compositionFingerprint === compositionFingerprint && latest.scheduleRevision === match.scheduleRevision) return latest;
    // A real conditional write makes confirmation contend with RSVP, cover,
    // roster and retime changes, while preserving the opposite side's plan.
    const claimed = await tx.match.updateMany({
      where: { id: match.id, status: match.status, scheduleRevision: opts.expectedScheduleRevision, logisticsRevision: opts.expectedLogisticsRevision },
      data: { logisticsRevision: { increment: 0 } },
    });
    if (claimed.count !== 1) throw new UserFacingError("The match just changed — reload and confirm again.");
    await tx.matchLineup.updateMany({ where: { matchId: match.id, teamId: opts.teamId, activeKey: { not: null } }, data: {
      status: "SUPERSEDED", activeKey: null, supersededAt: now, reason: "Captain confirmed a replacement lineup",
    } });
    const lineup = await tx.matchLineup.create({ data: {
      matchId: match.id, teamId: opts.teamId, revision: (latest?.revision ?? 0) + 1,
      activeKey: JSON.stringify([match.id, opts.teamId]),
      scheduleRevision: match.scheduleRevision, logisticsRevision: match.logisticsRevision,
      scheduledAtSnapshot: match.scheduledAt!, createdAt: now, createdById: actor.id,
      confirmedAt: now, confirmedById: actor.id, confirmedByName: actor.name,
      compositionFingerprint,
      seats: { create: selected.map((s) => ({
        seatKey: s.seatKey, userId: s.userId, userNameSnapshot: s.userName,
        accountId: s.accountId, replacingUserId: s.replacingUserId, entryKind: s.entryKind,
        acceptanceStatusSnapshot: s.acceptanceStatusSnapshot, position: s.position,
        mmr: s.mmr, mmrSource: s.mmr == null ? null : "REGISTRATION_AT_CONFIRMATION", ratingAt: s.mmr == null ? null : now,
        assignmentId: s.assignmentId, sourceTenureId: s.sourceTenureId,
        availabilityAt: s.availability!.updatedAt,
        eligibilitySnapshot: JSON.stringify({ source: s.entryKind, scheduleRevision: match.scheduleRevision, consent: s.acceptanceStatusSnapshot }),
      })) },
    } });
    await stampResultChange(tx);
    return lineup;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
