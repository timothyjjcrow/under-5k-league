import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { effectiveDotaAccountId } from "./dota-account";
import { postAuctionWorkOpen } from "./league-lifecycle";
import { parseAdminSteamIds, resolveSessionRole } from "./users";
import { singleActiveSeason } from "./season";
import { standinConflict, STANDIN_MMR_FLAG_GAP } from "./standin";
import { UserFacingError } from "./user-facing-error";

export const COVER_POLICY_VERSION = "COVER_V1";
export type CoverAdvisory = { code: "NAMED_SEAT_MMR_GAP" | "ABOVE_REVIEW_THRESHOLD"; message: string };
export type CoverEligibilityPreview = {
  version: 1; requestId: string; targetUserId: string; requestRevision: number; scheduleRevision: number;
  kickoff: string; candidate: { name: string; mmr: number | null; mmrSource: string | null };
  coveredSeat: { replacingUserId: string | null; name: string | null; mmr: number | null };
  eligible: boolean; blockers: { code: string; message: string }[]; advisories: CoverAdvisory[];
  acknowledgementFingerprint: string;
};
export const coverDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const isCoverUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const isCoverRevision = (value: number) => Number.isSafeInteger(value) && value >= 0;

export async function loadCoverMatch(tx: Prisma.TransactionClient, matchId: string, actorId: string, teamId: string, manager = true) {
  const [match, actor, active] = await Promise.all([
    tx.match.findUnique({ where: { id: matchId }, include: {
      season: { include: { draft: { select: { status: true } } } },
      homeTeam: { select: { id: true, captainId: true, name: true, withdrawn: true } },
      awayTeam: { select: { id: true, captainId: true, name: true, withdrawn: true } },
    } }),
    tx.user.findUnique({ where: { id: actorId }, select: { id: true, name: true, steamId: true, role: true } }),
    tx.season.findMany({ where: { isActive: true }, take: 2, select: { id: true } }).then(singleActiveSeason),
  ]);
  if (!match || !actor) throw new UserFacingError("This match or your account is no longer available.");
  const team = teamId === match.homeTeamId ? match.homeTeam : teamId === match.awayTeamId ? match.awayTeam : null;
  const isAdmin = resolveSessionRole({ steamId: actor.steamId, storedRole: actor.role,
    adminSteamIds: parseAdminSteamIds(process.env.ADMIN_STEAM_IDS), production: process.env.NODE_ENV === "production" }) === "ADMIN";
  if (!team || (manager && !isAdmin && team.captainId !== actor.id)) throw new UserFacingError("Only this team's captain or an admin can manage its cover.");
  return { match, actor, team, isAdmin, active: active?.id === match.seasonId };
}
export async function loadCoverContext(tx: Prisma.TransactionClient, requestId: string, actorId: string, manager = true) {
  const request = await tx.coverRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new UserFacingError("This cover request no longer exists.");
  return { ...await loadCoverMatch(tx, request.matchId, actorId, request.teamId, manager), request };
}
export type CoverContext = Awaited<ReturnType<typeof loadCoverContext>>;

export function coverWindowProblem(context: Pick<CoverContext, "match" | "team" | "active">, now = new Date()) {
  const { match, team, active } = context;
  if (!active) return { code: "ARCHIVED", message: "This fixture is not in the active season." };
  if (team.withdrawn) return { code: "TEAM_WITHDRAWN", message: "This team has withdrawn." };
  if (!postAuctionWorkOpen(match.season.status, match.season.draft?.status) || !["SCHEDULED", "LIVE"].includes(match.status)) {
    return { code: "CLOSED", message: "Cover is closed for this fixture or league phase." };
  }
  if (!match.scheduledAt) return { code: "NO_KICKOFF", message: "Publish a kickoff before arranging cover." };
  if (match.status === "SCHEDULED" && match.scheduledAt <= now) return { code: "KICKOFF_PASSED", message: "The scheduled kickoff has passed. Update the fixture before arranging cover." };
  return null;
}

export function coverOfferExpiresAt(match: { status: string; scheduledAt: Date | null }, kind: string, now = new Date()) {
  const duration = match.status === "LIVE" ? 10 * 60_000 : kind === "RECONFIRMATION" ? 2 * 3600_000 : 30 * 60_000;
  return new Date(Math.min(now.getTime() + duration, match.status === "LIVE" ? Infinity : match.scheduledAt?.getTime() ?? now.getTime()));
}

/** Only stable policy facts enter the acknowledgement. Observation time and
 * capacity are audited separately and hard eligibility is always rechecked. */
export function coverAdvisoryFingerprint(input: {
  requestId: string; teamId: string; seatKey: string; targetUserId: string;
  candidateMmr: number | null; replacedUserId: string | null; replacedMmr: number | null;
  maxMmr: number; scheduledAt: Date; scheduleRevision: number; advisoryCodes: string[];
}) {
  return coverDigest([COVER_POLICY_VERSION, input.requestId, input.teamId, input.seatKey, input.targetUserId,
    input.candidateMmr, "REGISTRATION", input.replacedUserId, input.replacedMmr, "REGISTRATION", input.maxMmr,
    input.scheduledAt.toISOString(), input.scheduleRevision, [...input.advisoryCodes].sort()]);
}

export async function evaluateCoverEligibility(tx: Prisma.TransactionClient, context: CoverContext, targetUserId: string,
  options: { ignoreAssignmentId?: string; now?: Date } = {}) {
  const { request, match, team } = context; const now = options.now ?? new Date();
  const [user, registration, members, assignments, bookings, replacedRegistration] = await Promise.all([
    tx.user.findUnique({ where: { id: targetUserId }, select: { id: true, name: true, steamId: true, dotaAccountIdV2: true, legacyDotaAccountId: true, discordId: true } }),
    tx.registration.findUnique({ where: { seasonId_userId: { seasonId: match.seasonId, userId: targetUserId } }, select: { status: true, type: true, mmr: true } }),
    tx.teamMember.findMany({ where: { seasonId: match.seasonId, OR: [{ teamId: team.id }, { userId: targetUserId }] }, select: { id: true, userId: true, teamId: true, user: { select: { name: true } } } }),
    tx.standinAssignment.findMany({ where: { matchId: match.id, ...(options.ignoreAssignmentId ? { id: { not: options.ignoreAssignmentId } } : {}) } }),
    tx.standinAssignment.findMany({ where: { standinUserId: targetUserId, matchId: { not: match.id }, match: { seasonId: match.seasonId, status: { not: "COMPLETED" } } }, select: { matchId: true, match: { select: { scheduledAt: true, week: true } } } }),
    request.replacingUserId ? tx.registration.findUnique({ where: { seasonId_userId: { seasonId: match.seasonId, userId: request.replacingUserId } }, select: { mmr: true } }) : null,
  ]);
  const blockers: CoverEligibilityPreview["blockers"] = [];
  const add = (code: string, message: string) => { blockers.push({ code, message }); };
  const problem = coverWindowProblem(context, now); if (problem) blockers.push(problem);
  if (!request.activeSeatKey || !["OPEN", "FILLED"].includes(request.status)) add("REQUEST_CLOSED", "This cover request is closed.");
  if (request.scheduleRevision !== match.scheduleRevision) add("KICKOFF_CHANGED", "The kickoff changed. Review the current request.");
  if (!user || !registration || registration.status !== "ACTIVE" || !["PLAYER", "STANDIN"].includes(registration.type)) add("INACTIVE_REGISTRATION", "That player has no active eligible signup this season.");
  if (members.some((member) => member.userId === targetUserId)) add("ROSTERED", "That player is already on a season roster.");
  if (targetUserId === request.replacingUserId) add("SAME_PLAYER", "A player cannot cover their own seat.");
  const ownMembers = members.filter((member) => member.teamId === team.id);
  const replaced = ownMembers.find((member) => member.userId === request.replacingUserId);
  if (request.replacingUserId && !replaced) add("SEAT_REMOVED", "The named player no longer holds this roster seat.");
  if (assignments.some((assignment) => assignment.standinUserId === targetUserId)) add("ALREADY_BOOKED", "That player is already assigned to this fixture.");
  if (request.replacingUserId && assignments.some((assignment) => assignment.replacingUserId === request.replacingUserId)) add("SEAT_TAKEN", "This player already has cover.");
  const filledVacancies = assignments.filter((assignment) => assignment.teamId === team.id && !assignment.replacingUserId).length;
  if (!request.replacingUserId && ownMembers.length + filledVacancies >= match.season.teamSize) add("FULL_ROSTER", "This team has no unfilled roster seat.");
  const conflicts = bookings.filter((booking) => standinConflict(match, booking.match));
  if (conflicts.length) add("BOOKING_CONFLICT", "That player already covers another fixture within four hours (or in the same unscheduled week).");
  const mmr = registration?.mmr && registration.mmr > 0 ? registration.mmr : null;
  const replacedMmr = replacedRegistration?.mmr && replacedRegistration.mmr > 0 ? replacedRegistration.mmr : null;
  const advisories: CoverAdvisory[] = [];
  if (mmr && replacedMmr && mmr - replacedMmr >= STANDIN_MMR_FLAG_GAP) advisories.push({ code: "NAMED_SEAT_MMR_GAP", message: `A ${mmr} MMR standin would cover a ${replacedMmr} MMR player. Acknowledge the difference and coordinate with the other captain.` });
  else if (mmr && !replacedMmr && match.season.maxMmr > 0 && mmr > match.season.maxMmr) advisories.push({ code: "ABOVE_REVIEW_THRESHOLD", message: `${mmr} MMR is above this season's ${match.season.maxMmr} MMR review threshold.` });
  const fingerprint = coverAdvisoryFingerprint({ requestId: request.id, teamId: team.id, seatKey: request.seatKey,
    targetUserId, candidateMmr: mmr, replacedUserId: request.replacingUserId, replacedMmr, maxMmr: match.season.maxMmr,
    scheduledAt: match.scheduledAt ?? request.scheduledAtSnapshot, scheduleRevision: match.scheduleRevision, advisoryCodes: advisories.map((a) => a.code) });
  const preview: CoverEligibilityPreview = { version: 1, requestId: request.id, targetUserId, requestRevision: request.revision,
    scheduleRevision: match.scheduleRevision, kickoff: (match.scheduledAt ?? request.scheduledAtSnapshot).toISOString(),
    candidate: { name: user?.name ?? "Unavailable player", mmr, mmrSource: mmr === null ? null : "REGISTRATION" },
    coveredSeat: { replacingUserId: request.replacingUserId, name: replaced?.user.name ?? null, mmr: replacedMmr },
    eligible: blockers.length === 0, blockers, advisories, acknowledgementFingerprint: fingerprint };
  return { preview, user, accountId: user ? effectiveDotaAccountId(user) : null, facts: {
    version: 1, observedAt: now.toISOString(), matchId: match.id, teamId: team.id, seatKey: request.seatKey,
    registration, activeSeason: context.active, phase: match.season.status, draftStatus: match.season.draft?.status ?? null,
    rosterCount: ownMembers.length, filledVacancies, conflicts: conflicts.map((c) => ({ matchId: c.matchId, kickoff: c.match.scheduledAt?.toISOString() ?? null })),
    ...preview,
  } };
}
