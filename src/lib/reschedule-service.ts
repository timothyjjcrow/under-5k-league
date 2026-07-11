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
    await prisma.rescheduleRequest.update({
      where: { id: requestId },
      data: { status: "DECLINED" },
    });
    return null;
  }

  await prisma.$transaction([
    prisma.rescheduleRequest.update({
      where: { id: requestId },
      data: { status: "ACCEPTED" },
    }),
    prisma.match.update({
      where: { id: match.id },
      data: { scheduledAt: request.proposedTime },
    }),
  ]);
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
  await prisma.rescheduleRequest.update({
    where: { id: requestId },
    data: { status: "CANCELLED" },
  });
}
