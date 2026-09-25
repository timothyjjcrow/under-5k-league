"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath, updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import {
  CHECKIN_REFUSAL_MESSAGE,
  checkinClosedReason,
  outPingThrottleKey,
  parseAvailabilityStatus,
} from "@/lib/availability";
import {
  awayRangeResult,
  parseAwayRange,
  parseSeenFixtures,
} from "@/lib/away-range";
import {
  currentCheckinStatus,
  markAwayRange,
  recordCheckin,
  resolveCheckinSeat,
} from "@/lib/availability-service";
import {
  playerAwayMessage,
  playerOutMessage,
  sendDiscordMessage,
} from "@/lib/discord";
import { mentionUsers } from "@/lib/discord-mentions";
import { claimThrottle } from "@/lib/settings";
import { MATCH_STATUS, RSVP_OUT_PING_THROTTLE_SECONDS } from "@/lib/constants";
import { isPlayoffPhase } from "@/lib/league-lifecycle";
import type { ActionResult } from "@/lib/action-result";
import { singleActiveSeason } from "@/lib/season";
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

        // The fixture half of the gate, then the player half — both shared
        // with markAwayRange so the range can never mark a fixture this
        // action would refuse.
        const closed = checkinClosedReason(
          activeSeason.status,
          activeSeason.draft?.status,
          match,
          Date.now(),
        );
        if (closed) throw new UserFacingError(CHECKIN_REFUSAL_MESSAGE[closed]);
        const [seat, priorStatus] = await Promise.all([
          resolveCheckinSeat(tx, match, user.id),
          currentCheckinStatus(tx, match, user.id),
        ]);
        if ("refusal" in seat) {
          throw new UserFacingError(CHECKIN_REFUSAL_MESSAGE[seat.refusal]);
        }

        if (priorStatus !== status) {
          await recordCheckin(tx, match, user.id, status, seat.teamId);
        }

        // Which side loses a player — the roster seat, or the team a standin
        // was covering for. This is who has to go find replacement cover.
        return { match, priorStatus, affectedCaptainId: seat.captainId };
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
        outPingThrottleKey(matchId, user.id),
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

/**
 * "I'm away": mark the signed-in player OUT for every fixture of theirs whose
 * kickoff falls between two dates, in one go, and tell the captain(s) once.
 *
 * The dates arrive as browser-computed epochs (local midnight of each day —
 * the server's zone is UTC in production and must never read a raw date).
 * `seen` is the fixture list the page showed, with each one's
 * scheduleRevision: a fixture is only answered for the kickoff the player saw.
 */
export async function markAwayDates(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }

  const parsed = parseAwayRange(
    str(formData, "awayFromTs"),
    str(formData, "awayBackTs"),
    Date.now(),
  );
  if ("error" in parsed) return { error: parsed.error };
  const expectedSeasonId = str(formData, "expectedSeasonId");
  if (!expectedSeasonId) return { error: "Reload the page and try again." };

  let outcome;
  try {
    outcome = await markAwayRange({
      userId: user.id,
      expectedSeasonId,
      range: parsed.range,
      seen: parseSeenFixtures(str(formData, "seen")),
      nowMs: Date.now(),
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2034") {
      return { error: "Your fixtures just changed. Reload and try again." };
    }
    return {
      error: actionErrorMessage(
        error,
        "Could not save your away dates. Reload and try again.",
        "availability.away",
      ),
    };
  }

  // ONE message for the whole range, after the write has committed. Each
  // fixture still claims the single-OUT throttle key, so a range followed by
  // a one-match OUT (or the reverse) can never ping twice for one match — and
  // a fixture that lost its claim is left out of the message entirely.
  // Best-effort like setAvailability: nothing here can undo the save.
  try {
    const announce = [];
    for (const fixture of outcome.marked) {
      if (
        await claimThrottle(
          outPingThrottleKey(fixture.matchId, user.id),
          RSVP_OUT_PING_THROTTLE_SECONDS,
          Date.now(),
        )
      ) {
        announce.push(fixture);
      }
    }
    if (announce.length) {
      await sendDiscordMessage(
        playerAwayMessage(
          user.name,
          announce.map((f) => ({
            homeName: f.homeName,
            awayName: f.awayName,
            week: f.week,
            isPlayoff: isPlayoffPhase(f.phase),
            isTiebreaker: f.phase === "TIEBREAKER",
            whenMs: f.whenMs,
            matchId: f.matchId,
          })),
        ),
        // Every captain who now has a seat to fill (a standin's bookings can
        // span teams) — never the player themselves, who is a captain only
        // when they are the one reading the toast.
        await mentionUsers(
          announce.map((f) => (f.captainId === user.id ? null : f.captainId)),
        ),
      );
    }
  } catch {
    // The OUTs are committed; a throttle or mention lookup outage must not
    // turn a saved range into an error that invites a second save.
  }

  if (outcome.marked.length) {
    updateTag(AUTOMATION_GATE_TAG);
    revalidatePath("/", "layout");
  }
  return awayRangeResult(outcome);
}
