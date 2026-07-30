// Captain-to-captain rescheduling rules, separated from the server actions
// so the guards are integration-testable (same pattern as draft-service).
// Every function throws Error with a player-facing message on a violation.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS } from "@/lib/constants";
import { clashesAfterRetime } from "./standin-service";
import { weekReminderKey } from "./settings";

export type AcceptedReschedule = {
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  newTime: Date;
  /** The captain who PROPOSED it — they asked and have been waiting. */
  notifyUserId: string | null;
  /** RSVPs the retime invalidated. Announced, never swallowed. */
  clearedRsvps: number;
  /** Standins now double-booked because this match moved — surfaced in the toast. */
  standinClashes: string[];
};

// Announcement data for a fresh proposal (mirrors AcceptedReschedule) — the
// action layer does the Discord send, so a webhook failure can never affect
// the proposal write itself.
export type ProposedReschedule = {
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  proposedTime: Date;
  /**
   * The captain who owes an answer (the OTHER one). A proposal is a question
   * addressed to exactly one person; the action resolves this to a mention so
   * it doesn't sit unread in a channel until kickoff. User id, not a snowflake
   * — the service stays free of Discord concerns.
   */
  notifyUserId: string | null;
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
): Promise<ProposedReschedule> {
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
  // SERIALIZABLE because there is no unique constraint enforcing "at most one
  // PENDING per match": on Postgres read-committed, two captains proposing in
  // the same instant each cancel what they can see and then both insert,
  // leaving TWO open proposals. The loser was a zombie the other captain could
  // accept days later, retiming the match out from under everyone.
  await prisma.$transaction(
    async (tx) => {
      await tx.rescheduleRequest.updateMany({
        where: { matchId, status: "PENDING" },
        data: { status: "CANCELLED" },
      });
      await tx.rescheduleRequest.create({
        data: { matchId, proposedById: userId, proposedTime },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  return {
    homeName: match.homeTeam.name,
    awayName: match.awayTeam.name,
    week: match.week,
    isPlayoff: match.phase !== MATCH_PHASE.REGULAR,
    proposedTime,
    // The proposer is one of the two captains (asserted above), so the
    // counterpart is simply the other one.
    notifyUserId:
      match.homeTeam.captainId === userId
        ? match.awayTeam.captainId
        : match.homeTeam.captainId,
  };
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

  // Re-validate on ACCEPT, not just on propose: a proposal sat on for two
  // weeks would otherwise move the match to a night that has already passed
  // (which also drops it outside its own auto-sync window).
  assertSaneProposedTime(request.proposedTime);

  let clearedRsvps = 0;
  await prisma.$transaction(async (tx) => {
    // Same conditional-write rule for accept: only a still-PENDING request
    // may retime the match.
    const accepted = await tx.rescheduleRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: { status: "ACCEPTED" },
    });
    if (accepted.count === 0)
      throw new Error("That proposal is no longer open");
    // The "not already played" check happened against a row read before this
    // transaction opened, and auto-sync completes matches from any visitor's
    // page view — so re-assert it at the write. Otherwise accepting a stale
    // proposal could stamp a FUTURE kickoff onto a match that just finished
    // (and wipe its RSVPs), putting a completed series outside its own
    // detection window. Throwing rolls the ACCEPTED flip back with it.
    const retimed = await tx.match.updateMany({
      where: { id: match.id, status: { not: MATCH_STATUS.COMPLETED } },
      // New kickoff ⇒ new detection window: clear the backoff accrued
      // against the old one so the moved night is scanned promptly.
      data: {
        scheduledAt: request.proposedTime,
        autoSyncedAt: null,
        autoSyncAttempts: 0,
      },
    });
    if (retimed.count === 0) throw new Error("This match is already played");
    // The night changed — every RSVP was an answer about the OLD night.
    // Clearing them re-prompts the rosters instead of carrying 8 stale ✓s
    // into a night nobody actually agreed to play.
    //
    // The COUNT rides out to the announcement: silently deleting ten players'
    // check-ins produces a match that looks unstaffed to its own captain and
    // an eight-to-ten-person roster who each believe they already answered.
    // Nothing else on the site tells them.
    const cleared = await tx.matchAvailability.deleteMany({
      where: { matchId: match.id },
    });
    clearedRsvps = cleared.count;

    // The week's reminder has already gone out quoting the OLD kickoff, and a
    // Discord edit wouldn't notify anyone even if we edited it. Dropping the
    // idempotency marker lets maybeAnnounceUpcomingWeek re-fire for this week
    // once the NEW time comes inside its window — with correct times and a
    // fresh (now empty) check-in count.
    await tx.setting.deleteMany({
      where: { key: weekReminderKey(match.seasonId, match.week) },
    });
  });
  // Accepting a reschedule moves the fixture, which can put a standin on two
  // games the same night — standinConflict is only checked when cover is
  // arranged, never when a match later moves onto that night. Reported, not
  // refused: the reschedule is the legitimate act.
  const standinClashes = await clashesAfterRetime(match.seasonId, [match.id]);
  return {
    homeName: match.homeTeam.name,
    awayName: match.awayTeam.name,
    week: match.week,
    isPlayoff: match.phase !== MATCH_PHASE.REGULAR,
    newTime: request.proposedTime,
    notifyUserId: request.proposedById,
    clearedRsvps,
    standinClashes,
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
