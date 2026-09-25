"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath, updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { parseAvailabilityStatus } from "@/lib/availability";
import { playerOutMessage, sendDiscordMessage } from "@/lib/discord";
import { mentionUsers } from "@/lib/discord-mentions";
import { claimThrottle } from "@/lib/settings";
import { MATCH_STATUS, RSVP_OUT_PING_THROTTLE_SECONDS } from "@/lib/constants";
import { isPlayoffPhase, matchCheckinOpen, postAuctionWorkOpen } from "@/lib/league-lifecycle";
import type { ActionResult } from "@/lib/action-result";
import { singleActiveSeason } from "@/lib/season";
import { invalidateMatchLineups, loadLineupCandidates } from "@/lib/match-lineups";
import {
  actionErrorMessage,
  UserFacingError,
} from "@/lib/user-facing-error";

/**
 * Record the signed-in player's match-night RSVP (IN | OUT) for a scheduled
 * match, or readiness for the remaining games of a live series.
 */
export async function setAvailability(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }

  const matchId = str(formData, "matchId");
  const status = parseAvailabilityStatus(str(formData, "status"));
  if (!status) return { error: "Invalid RSVP" };
  const revisionValue = formData.get("expectedScheduleRevision");
  const expectedScheduleRevision = typeof revisionValue === "string" && /^(0|[1-9]\d*)$/.test(revisionValue) ? Number(revisionValue) : NaN;
  if (!Number.isSafeInteger(expectedScheduleRevision)) return { error: "Reload the match to check in for its current kickoff." };

  // Match phase/status, current roster authority, standin cover and the prior
  // answer all belong to one write-time decision. Keeping these reads outside
  // the transaction let an RSVP land after the season archived, the match
  // finished, or this player's seat was replaced. SERIALIZABLE makes those state
  // changes contend with this write instead of accepting a stale snapshot.
  let committed;
  try {
    committed = await prisma.$transaction(
      async (tx) => {
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
            select: {
              id: true,
              seasonId: true,
              week: true,
              phase: true,
              status: true,
              scheduledAt: true,
              scheduleRevision: true,
              homeTeamId: true,
              awayTeamId: true,
              homeTeam: { select: { name: true, captainId: true, withdrawn: true } },
              awayTeam: { select: { name: true, captainId: true, withdrawn: true } },
            },
          }),
        ]);
        if (!match) throw new UserFacingError("Unknown match");
        if (match.scheduleRevision !== expectedScheduleRevision) throw new UserFacingError("The kickoff changed — reload before answering for the new time.");
        // An archived season's unplayed match still lists its rosters, and an
        // OUT here would ping a captain about a fixture nobody is playing.
        if (!activeSeason || match.seasonId !== activeSeason.id) {
          throw new UserFacingError(
            "That match belongs to an archived season",
          );
        }

        const draftStatus = activeSeason.draft?.status;
        if (
          !matchCheckinOpen(
            activeSeason.status,
            draftStatus,
            match.status,
            match.scheduledAt,
            Date.now(),
          )
        ) {
          if (match.status === MATCH_STATUS.COMPLETED)
            throw new UserFacingError("That match is already finished");
          if (!postAuctionWorkOpen(activeSeason.status, draftStatus))
            throw new UserFacingError(
              "Check-in is not open in this league phase",
            );
          if (match.scheduledAt)
            throw new UserFacingError(
              "Check-in is closed because that kickoff has passed — the result is still outstanding",
            );
          throw new UserFacingError(
            "That match does not have a kickoff yet",
          );
        }

        const teamIds = [match.homeTeamId, match.awayTeamId];
        const [onRoster, replacedSeat, standinSeat, prior] = await Promise.all([
          tx.teamMember.findFirst({
            where: {
              seasonId: match.seasonId,
              userId: user.id,
              teamId: { in: teamIds },
            },
            select: { teamId: true },
          }),
          tx.standinAssignment.findFirst({
            where: { matchId, replacingUserId: user.id },
            select: { id: true },
          }),
          tx.standinAssignment.findFirst({
            where: {
              matchId,
              standinUserId: user.id,
              teamId: { in: teamIds },
            },
            select: { teamId: true },
          }),
          tx.matchAvailability.findUnique({
            where: { matchId_userId: { matchId, userId: user.id } },
            select: { status: true, scheduleRevision: true },
          }),
        ]);
        if (onRoster && replacedSeat) {
          throw new UserFacingError(
            "A standin is covering your seat for this match, so you are not in its playing roster",
          );
        }
        if (!onRoster && !standinSeat) {
          throw new UserFacingError("You're not playing in this match");
        }
        const affectedTeamId = onRoster?.teamId ?? standinSeat!.teamId;
        if ((affectedTeamId === match.homeTeamId ? match.homeTeam : match.awayTeam).withdrawn) {
          throw new UserFacingError("A withdrawn team cannot check in for this match.");
        }
        const candidates = await loadLineupCandidates(tx, match, affectedTeamId);
        if (!candidates.some((candidate) => candidate.userId === user.id && candidate.eligible)) {
          throw new UserFacingError("You're not playing in this match — the roster or cover assignment changed.");
        }

        const priorStatus = prior?.scheduleRevision === match.scheduleRevision ? prior.status : null;
        if (priorStatus !== status) {
          await tx.matchAvailability.upsert({
            where: { matchId_userId: { matchId, userId: user.id } },
            create: { matchId, userId: user.id, status, scheduleRevision: match.scheduleRevision },
            update: { status, scheduleRevision: match.scheduleRevision },
          });
          await invalidateMatchLineups(tx, match.id, "A player's check-in changed", new Date(), affectedTeamId);
        }

        // Which side loses a player — the roster seat, or the team a standin
        // was covering for. This is who has to go find replacement cover.
        return {
          match,
          priorStatus,
          affectedCaptainId:
            affectedTeamId === match.homeTeamId
              ? match.homeTeam.captainId
              : affectedTeamId === match.awayTeamId
                ? match.awayTeam.captainId
                : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if ((error as { code?: string }).code === "P2034") {
      return {
        error: "That match just changed — reload and try your RSVP again",
      };
    }
    return {
      error: actionErrorMessage(
        error,
        "Could not save that RSVP — reload and try again",
        "availability.set",
      ),
    };
  }

  const { match, priorStatus, affectedCaptainId } = committed;

  // An OUT demands a human response (standin hunt) — announce it the moment
  // it's declared instead of letting it hide until match night. Best-effort:
  // sendDiscordMessage never throws, so the RSVP itself can't fail here.
  //
  // The throttle backs up the was-it-already-OUT check: that one misses
  // OUT→IN→OUT, which is a duplicate line in the channel but a SECOND phone
  // buzz now that the message actually mentions the captain.
  try {
    if (
      status === "OUT" &&
      priorStatus !== "OUT" &&
      (await claimThrottle(
        `outPing:${matchId}:${user.id}`,
        RSVP_OUT_PING_THROTTLE_SECONDS,
        Date.now(),
      ))
    ) {
      // The message ends by telling the captain to line up cover, so send it
      // to the captain rather than to a channel and hope. Nobody else is
      // mentioned: a withdrawal is not the rest of the league's problem.
      await sendDiscordMessage(
        playerOutMessage({
          playerName: user.name,
          homeName: match.homeTeam.name,
          awayName: match.awayTeam.name,
          week: match.week,
          isPlayoff: isPlayoffPhase(match.phase),
          isTiebreaker: match.phase === "TIEBREAKER",
          whenMs: match.scheduledAt?.getTime() ?? null,
          // Deep link — the mentioned captain lands on the page that holds the
          // Standins card, not on the front door.
          matchId: match.id,
        }),
        // Never ping the captain about their OWN withdrawal — they just
        // clicked the button and are looking at the toast.
        await mentionUsers([
          affectedCaptainId === user.id ? null : affectedCaptainId,
        ]),
      );
    }
  } catch {
    // The RSVP is already committed. A throttle-store or mention lookup
    // outage must not turn that successful write into a misleading 500 that
    // invites the player to submit it again.
  }

  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/", "layout");
  return {
    message:
      status === "IN"
        ? match.status === MATCH_STATUS.LIVE ? "You're ready for the next game ✓" : "You're confirmed for the match ✓"
        : "Marked as unavailable — your captain and the admin can line up a standin",
  };
}
