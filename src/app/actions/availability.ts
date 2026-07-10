"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { parseAvailabilityStatus } from "@/lib/availability";
import { MATCH_STATUS } from "@/lib/constants";
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
    include: { standins: true },
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
    select: { id: true },
  });
  const isStandin = match.standins.some((s) => s.standinUserId === user.id);
  if (!onRoster && !isStandin) {
    return { error: "You're not playing in this match" };
  }

  await prisma.matchAvailability.upsert({
    where: { matchId_userId: { matchId, userId: user.id } },
    create: { matchId, userId: user.id, status },
    update: { status },
  });

  revalidatePath("/", "layout");
  return {
    message:
      status === "IN"
        ? "You're confirmed for the match ✓"
        : "Marked as unavailable — your captain and the admin can line up a standin",
  };
}
