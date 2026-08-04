// Captain-to-captain rescheduling rules, separated from the server actions
// so the guards are integration-testable (same pattern as draft-service).
// Every expected rule violation throws UserFacingError; the action boundary
// never serializes arbitrary database or provider exception text.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS } from "@/lib/constants";
import { clashesAfterRetime } from "./standin-service";
import { matchLogisticsOpen } from "./league-lifecycle";
import { weekReminderKey } from "./settings";
import { singleActiveSeason } from "./season";
import { UserFacingError } from "./user-facing-error";

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
  /**
   * Standins ASSIGNED to this match — their personally-@-mentioned assignment
   * message embedded the OLD kickoff, and the acceptance broadcast is the one
   * message that carries the new one, so the action mentions them alongside
   * the proposer. User ids, not snowflakes (the notifyUserId rule).
   */
  standinUserIds: string[];
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

export type DeclinedReschedule = {
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  /** The time that was refused — named so a channel that has seen several
   *  proposals go by can tell WHICH one this closes. */
  proposedTime: Date;
  /** The PROPOSER. They asked a question and have been waiting; a decline is
   *  addressed to exactly one person, same as the proposal was. */
  notifyUserId: string;
};

/**
 * Discriminated so the action can send the right message without a null check
 * that silently means "declined" — which is exactly how the decline went
 * unannounced for as long as it did: `respondReschedule` returned null and the
 * action's `if (accepted)` skipped every send.
 */
export type RescheduleOutcome =
  | (AcceptedReschedule & { accepted: true })
  | (DeclinedReschedule & { accepted: false });

// Sanity bounds for a proposed time: a datetime-local typo (year 0002 from
// typing "2", 20268 from a stray digit) or a past date would otherwise sail
// straight into Match.scheduledAt on acceptance.
const PAST_GRACE_MS = 60 * 60 * 1000; // "tonight, an hour ago" is fine
const MAX_AHEAD_MS = 180 * 24 * 60 * 60 * 1000; // no league pauses half a year

function assertSaneProposedTime(proposedTime: Date, now = new Date()): void {
  if (!Number.isFinite(proposedTime.getTime()))
    throw new UserFacingError("Choose a valid proposed time");
  if (proposedTime.getTime() < now.getTime() - PAST_GRACE_MS)
    throw new UserFacingError("That time is in the past");
  if (proposedTime.getTime() > now.getTime() + MAX_AHEAD_MS)
    throw new UserFacingError("That time is too far out — check the year");
}

/** Create (or supersede) the match's open proposal. Captains only. */
export async function proposeReschedule(
  userId: string,
  matchId: string,
  proposedTime: Date,
): Promise<ProposedReschedule> {
  assertSaneProposedTime(proposedTime);

  // Replace any open proposal — the newest ask is the only live one.
  // SERIALIZABLE because there is no unique constraint enforcing "at most one
  // PENDING per match": on Postgres read-committed, two captains proposing in
  // the same instant each cancel what they can see and then both insert,
  // leaving TWO open proposals. The loser was a zombie the other captain could
  // accept days later, retiming the match out from under everyone.
  try {
    return await prisma.$transaction(
      async (tx) => {
        // These are authority reads, not presentation data: season turnover,
        // a phase advance, a result sync, or a captain replacement between a
        // page render and this click must be decisive here at write time.
        const [activeSeason, match] = await Promise.all([
          tx.season
            .findMany({
              where: { isActive: true },
              orderBy: { createdAt: "desc" },
              take: 2,
              select: {
                id: true,
                status: true,
                draft: { select: { status: true } },
              },
            })
            .then(singleActiveSeason),
          tx.match.findUnique({
            where: { id: matchId },
            include: { homeTeam: true, awayTeam: true },
          }),
        ]);
        if (!match) throw new UserFacingError("Match not found");
        if (
          match.homeTeam.captainId !== userId &&
          match.awayTeam.captainId !== userId
        )
          throw new UserFacingError("Only the two captains can propose a time");
        // An archived season's unplayed match keeps its captains. Opening a
        // negotiation there would also send a live Discord mention about a
        // dead fixture. Decline/withdraw remain legal cleanup below.
        if (!activeSeason || match.seasonId !== activeSeason.id)
          throw new UserFacingError(
            "This match belongs to an archived season",
          );
        if (
          !matchLogisticsOpen(
            activeSeason.status,
            activeSeason.draft?.status,
            match.status,
          )
        ) {
          if (match.status === MATCH_STATUS.COMPLETED)
            throw new UserFacingError("This match is already played");
          if (match.status === MATCH_STATUS.LIVE)
            throw new UserFacingError("This match is already live");
          throw new UserFacingError(
            "Rescheduling is not open in this league phase",
          );
        }
        // An unscheduled SCHEDULED match may use a proposal to receive its
        // first kickoff. Once it has one, proposing that exact instant creates
        // a notification and approval task that cannot change anything.
        if (match.scheduledAt?.getTime() === proposedTime.getTime())
          throw new UserFacingError("That is already this match's kickoff");

        await tx.rescheduleRequest.updateMany({
          where: { matchId, status: "PENDING" },
          data: { status: "CANCELLED" },
        });
        await tx.rescheduleRequest.create({
          data: { matchId, proposedById: userId, proposedTime },
        });

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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if ((error as { code?: string }).code === "P2034")
      throw new UserFacingError(
        "That match just changed — reload and try again",
      );
    throw error;
  }
}

/**
 * Accept or decline the open proposal. Only the opposing captain may respond;
 * accepting retimes the match. Returns announcement data on acceptance.
 */
export async function respondReschedule(
  userId: string,
  requestId: string,
  accept: boolean,
): Promise<RescheduleOutcome> {
  let outcome;
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        const request = await tx.rescheduleRequest.findUnique({
          where: { id: requestId },
          include: { match: { include: { homeTeam: true, awayTeam: true } } },
        });
        if (!request || request.status !== "PENDING")
          throw new UserFacingError("That proposal is no longer open");
        const { match } = request;
        const isCaptain =
          match.homeTeam.captainId === userId ||
          match.awayTeam.captainId === userId;
        if (!isCaptain || request.proposedById === userId)
          throw new UserFacingError("Only the opposing captain can respond");

        if (!accept) {
          // Decline is cleanup, so it stays legal after a phase change, result,
          // or season archival. Authority and request state are still read and
          // claimed in this transaction so an old page cannot override a
          // concurrent supersede/withdraw.
          const declined = await tx.rescheduleRequest.updateMany({
            where: { id: requestId, status: "PENDING" },
            data: { status: "DECLINED" },
          });
          if (declined.count === 0)
            throw new UserFacingError("That proposal is no longer open");
          return {
            accepted: false as const,
            homeName: match.homeTeam.name,
            awayName: match.awayTeam.name,
            week: match.week,
            isPlayoff: match.phase !== MATCH_PHASE.REGULAR,
            proposedTime: request.proposedTime,
            notifyUserId: request.proposedById,
          };
        }

        // Accepting mutates the fixture, so unlike decline it must still be an
        // active, post-draft, SCHEDULED match at this exact write decision.
        const activeSeason = await tx.season
          .findMany({
            where: { isActive: true },
            orderBy: { createdAt: "desc" },
            take: 2,
            select: {
              id: true,
              status: true,
              draft: { select: { status: true } },
            },
          })
          .then(singleActiveSeason);
        if (!activeSeason || match.seasonId !== activeSeason.id)
          throw new UserFacingError(
            "This match belongs to an archived season",
          );
        if (
          !matchLogisticsOpen(
            activeSeason.status,
            activeSeason.draft?.status,
            match.status,
          )
        ) {
          if (match.status === MATCH_STATUS.COMPLETED)
            throw new UserFacingError("This match is already played");
          if (match.status === MATCH_STATUS.LIVE)
            throw new UserFacingError("This match is already live");
          throw new UserFacingError(
            "Rescheduling is not open in this league phase",
          );
        }

        // A proposal may have sat open while the time aged out or an admin
        // independently moved the match. Recheck both against fresh state.
        assertSaneProposedTime(request.proposedTime);
        if (match.scheduledAt?.getTime() === request.proposedTime.getTime())
          throw new UserFacingError("That is already this match's kickoff");

        const accepted = await tx.rescheduleRequest.updateMany({
          where: { id: requestId, status: "PENDING" },
          data: { status: "ACCEPTED" },
        });
        if (accepted.count === 0)
          throw new UserFacingError("That proposal is no longer open");
        const retimed = await tx.match.updateMany({
          where: { id: match.id, status: MATCH_STATUS.SCHEDULED },
          // New kickoff ⇒ new detection window: clear the backoff accrued
          // against the old one so the moved night is scanned promptly.
          data: {
            scheduledAt: request.proposedTime,
            autoSyncedAt: null,
            autoSyncAttempts: 0,
          },
        });
        if (retimed.count === 0)
          throw new UserFacingError(
            "That match is no longer awaiting play",
          );

        // Every RSVP answered the OLD night. Clear them and release the old
        // reminder marker atomically with the retime.
        const [cleared, standins] = await Promise.all([
          tx.matchAvailability.deleteMany({ where: { matchId: match.id } }),
          tx.standinAssignment.findMany({
            where: { matchId: match.id },
            select: { standinUserId: true },
          }),
          tx.setting.deleteMany({
            where: {
              OR: [
                { key: weekReminderKey(match.seasonId, match.week) },
                {
                  key: {
                    startsWith: `${weekReminderKey(match.seasonId, match.week)}:`,
                  },
                },
              ],
            },
          }),
        ]);

        return {
          accepted: true as const,
          homeName: match.homeTeam.name,
          awayName: match.awayTeam.name,
          week: match.week,
          isPlayoff: match.phase !== MATCH_PHASE.REGULAR,
          newTime: request.proposedTime,
          notifyUserId: request.proposedById,
          clearedRsvps: cleared.count,
          standinUserIds: standins.map((s) => s.standinUserId),
          matchId: match.id,
          seasonId: match.seasonId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if ((error as { code?: string }).code === "P2034")
      throw new UserFacingError(
        "That proposal or match just changed — reload and try again",
      );
    throw error;
  }

  if (!outcome.accepted) return outcome;
  // Accepting a reschedule moves the fixture, which can put a standin on two
  // games the same night — standinConflict is only checked when cover is
  // arranged, never when a match later moves onto that night. Reported, not
  // refused: the reschedule is the legitimate act.
  const standinClashes = await clashesAfterRetime(outcome.seasonId, [
    outcome.matchId,
  ]);
  return {
    accepted: true,
    homeName: outcome.homeName,
    awayName: outcome.awayName,
    week: outcome.week,
    isPlayoff: outcome.isPlayoff,
    newTime: outcome.newTime,
    notifyUserId: outcome.notifyUserId,
    clearedRsvps: outcome.clearedRsvps,
    standinUserIds: outcome.standinUserIds,
    standinClashes,
  };
}

/** Withdraw an open proposal — the proposer or an admin. */
export async function cancelReschedule(
  userId: string,
  requestId: string,
  isAdmin: boolean,
): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        const request = await tx.rescheduleRequest.findUnique({
          where: { id: requestId },
        });
        if (!request || request.status !== "PENDING")
          throw new UserFacingError("That proposal is no longer open");
        if (request.proposedById !== userId && !isAdmin)
          throw new UserFacingError("Only the proposer can withdraw it");
        const cancelled = await tx.rescheduleRequest.updateMany({
          where: { id: requestId, status: "PENDING" },
          data: { status: "CANCELLED" },
        });
        if (cancelled.count === 0)
          throw new UserFacingError("That proposal is no longer open");
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if ((error as { code?: string }).code === "P2034")
      throw new UserFacingError(
        "That proposal just changed — reload and try again",
      );
    throw error;
  }
}
