// Captain-to-captain rescheduling rules, separated from the server actions
// so the guards are integration-testable (same pattern as draft-service).
// Every function throws Error with a player-facing message on a violation.

import { prisma } from "@/lib/prisma";
import { MATCH_STATUS } from "@/lib/constants";

export type AcceptedReschedule = {
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  newTime: Date;
};

// Sanity bounds for a proposed time: a datetime-local typo (year 0002 from
// typing "2", 20268 from a stray digit) or a past date would otherwise sail
// straight into Match.scheduledAt on acceptance.
const PAST_GRACE_MS = 60 * 60 * 1000; // "tonight, an hour ago" is fine
const MAX_AHEAD_MS = 180 * 24 * 60 * 60 * 1000; // no league pauses half a year

function assertSaneProposedTime(proposedTime: Date, now = new Date()): void {
  if (proposedTime.getTime() < now.getTime() - PAST_GRACE_MS)
    throw new Error("That time is in the past");
  if (proposedTime.getTime() > now.getTime() + MAX_AHEAD_MS)
    throw new Error("That time is too far out — check the year");
}

/** Create (or supersede) the match's open proposal. Captains only. */
export async function proposeReschedule(
  userId: string,
  matchId: string,
  proposedTime: Date,
): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { homeTeam: true, awayTeam: true },
  });
  if (!match) throw new Error("Match not found");
  if (
    match.homeTeam.captainId !== userId &&
    match.awayTeam.captainId !== userId
  )
    throw new Error("Only the two captains can propose a time");
  if (match.status === MATCH_STATUS.COMPLETED)
    throw new Error("This match is already played");
  assertSaneProposedTime(proposedTime);

  // Replace any open proposal — the newest ask is the only live one.
  await prisma.$transaction([
    prisma.rescheduleRequest.updateMany({
      where: { matchId, status: "PENDING" },
      data: { status: "CANCELLED" },
    }),
    prisma.rescheduleRequest.create({
      data: { matchId, proposedById: userId, proposedTime },
    }),
  ]);
}

/**
 * Accept or decline the open proposal. Only the opposing captain may respond;
 * accepting retimes the match. Returns announcement data on acceptance.
 */
export async function respondReschedule(
  userId: string,
  requestId: string,
  accept: boolean,
): Promise<AcceptedReschedule | null> {
  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: requestId },
    include: { match: { include: { homeTeam: true, awayTeam: true } } },
  });
  if (!request || request.status !== "PENDING")
    throw new Error("That proposal is no longer open");
  const { match } = request;
  const isCaptain =
    match.homeTeam.captainId === userId ||
    match.awayTeam.captainId === userId;
  if (!isCaptain || request.proposedById === userId)
    throw new Error("Only the opposing captain can respond");
  if (match.status === MATCH_STATUS.COMPLETED)
    throw new Error("This match is already played");

  if (!accept) {
    // Conditional write — a concurrent withdraw/supersede must not be
    // flipped to DECLINED after the fact.
    const declined = await prisma.rescheduleRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: { status: "DECLINED" },
    });
    if (declined.count === 0)
      throw new Error("That proposal is no longer open");
    return null;
  }

  await prisma.$transaction(async (tx) => {
    // Same conditional-write rule for accept: only a still-PENDING request
    // may retime the match.
    const accepted = await tx.rescheduleRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: { status: "ACCEPTED" },
    });
    if (accepted.count === 0)
      throw new Error("That proposal is no longer open");
    await tx.match.update({
      where: { id: match.id },
      data: { scheduledAt: request.proposedTime },
    });
    // The night changed — every RSVP was an answer about the OLD night.
    // Clearing them re-prompts the rosters instead of carrying 8 stale ✓s
    // into a night nobody actually agreed to play.
    await tx.matchAvailability.deleteMany({ where: { matchId: match.id } });
  });
  return {
    homeName: match.homeTeam.name,
    awayName: match.awayTeam.name,
    week: match.week,
    isPlayoff: match.phase !== "REGULAR",
    newTime: request.proposedTime,
  };
}

/** Withdraw an open proposal — the proposer or an admin. */
export async function cancelReschedule(
  userId: string,
  requestId: string,
  isAdmin: boolean,
): Promise<void> {
  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: requestId },
  });
  if (!request || request.status !== "PENDING")
    throw new Error("That proposal is no longer open");
  if (request.proposedById !== userId && !isAdmin)
    throw new Error("Only the proposer can withdraw it");
  const cancelled = await prisma.rescheduleRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  if (cancelled.count === 0)
    throw new Error("That proposal is no longer open");
}
