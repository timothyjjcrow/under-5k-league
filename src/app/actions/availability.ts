"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { parseAvailabilityStatus } from "@/lib/availability";
import { playerOutMessage, sendDiscordMessage } from "@/lib/discord";
import { mentionUsers } from "@/lib/discord-mentions";
import { claimThrottle } from "@/lib/settings";
import { MATCH_STATUS, RSVP_OUT_PING_THROTTLE_SECONDS } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";

/**
 * Record the signed-in player's match-night RSVP (IN | OUT) for a scheduled
 * match they're rostered in (or assigned to as a standin).
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

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      standins: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  });
  if (!match) return { error: "Unknown match" };
  if (match.status === MATCH_STATUS.COMPLETED) {
    return { error: "That match is already finished" };
  }

  const onRoster = await prisma.teamMember.findFirst({
    where: {
      seasonId: match.seasonId,
      userId: user.id,
      teamId: { in: [match.homeTeamId, match.awayTeamId] },
    },
    select: { id: true, teamId: true },
  });
  const standinSeat = match.standins.find((s) => s.standinUserId === user.id);
  if (!onRoster && !standinSeat) {
    return { error: "You're not playing in this match" };
  }
  // Which side loses a player — the roster seat, or the team a standin was
  // covering for. This is who has to go and find replacement cover.
  const affectedTeamId = onRoster?.teamId ?? standinSeat?.teamId ?? null;

  // Prior answer, so only a NEW "out" pings Discord — flipping IN↔OUT while
  // deciding must not spam the channel with duplicate alerts.
  const prior = await prisma.matchAvailability.findUnique({
    where: { matchId_userId: { matchId, userId: user.id } },
    select: { status: true },
  });

  await prisma.matchAvailability.upsert({
    where: { matchId_userId: { matchId, userId: user.id } },
    create: { matchId, userId: user.id, status },
    update: { status },
  });

  // An OUT demands a human response (standin hunt) — announce it the moment
  // it's declared instead of letting it hide until match night. Best-effort:
  // sendDiscordMessage never throws, so the RSVP itself can't fail here.
  //
  // The throttle backs up the was-it-already-OUT check: that one misses
  // OUT→IN→OUT, which is a duplicate line in the channel but a SECOND phone
  // buzz now that the message actually mentions the captain.
  if (
    status === "OUT" &&
    prior?.status !== "OUT" &&
    (await claimThrottle(
      `outPing:${matchId}:${user.id}`,
      RSVP_OUT_PING_THROTTLE_SECONDS,
      Date.now(),
    ))
  ) {
    // The message ends by telling the captain to line up cover, so send it to
    // the captain rather than to a channel and hope. Nobody else is mentioned:
    // a withdrawal is not the rest of the league's problem.
    const captain = affectedTeamId
      ? await prisma.team.findUnique({
          where: { id: affectedTeamId },
          select: { captainId: true },
        })
      : null;
    await sendDiscordMessage(
      playerOutMessage({
        playerName: user.name,
        homeName: match.homeTeam.name,
        awayName: match.awayTeam.name,
        week: match.week,
        isPlayoff: match.phase !== "REGULAR",
        whenMs: match.scheduledAt?.getTime() ?? null,
      }),
      // Never ping the captain about their OWN withdrawal — they just clicked
      // the button and are looking at the toast.
      await mentionUsers([
        captain?.captainId === user.id ? null : captain?.captainId,
      ]),
    );
  }

  revalidatePath("/", "layout");
  return {
    message:
      status === "IN"
        ? "You're confirmed for the match ✓"
        : "Marked as unavailable — your captain and the admin can line up a standin",
  };
}
