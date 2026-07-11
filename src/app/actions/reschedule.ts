"use server";

// Captain-to-captain match rescheduling: one captain proposes a new time,
// the opposing captain accepts (retimes the match, announced in Discord) or
// declines. One open proposal per match; the proposer can withdraw it.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { MATCH_STATUS } from "@/lib/constants";
import { rescheduleMessage, sendDiscordMessage } from "@/lib/discord";
import type { ActionResult } from "@/lib/action-result";

function refresh() {
  revalidatePath("/", "layout");
}

/** The match with both teams, or null — plus which side the user captains. */
async function matchForCaptain(matchId: string, userId: string) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { homeTeam: true, awayTeam: true },
  });
  if (!match) return null;
  const isHomeCaptain = match.homeTeam.captainId === userId;
  const isAwayCaptain = match.awayTeam.captainId === userId;
  if (!isHomeCaptain && !isAwayCaptain) return null;
  return { match, isHomeCaptain };
}

export async function proposeReschedule(
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
  const raw = str(formData, "proposedTime");
  const proposedTime = raw ? new Date(raw) : null;
  if (!proposedTime || Number.isNaN(proposedTime.getTime()))
    return { error: "Pick a valid date & time" };

  const found = await matchForCaptain(matchId, user.id);
  if (!found) return { error: "Only the two captains can propose a time" };
  if (found.match.status === MATCH_STATUS.COMPLETED)
    return { error: "This match is already played" };

  // Replace any open proposal — the newest ask is the only live one.
  await prisma.$transaction([
    prisma.rescheduleRequest.updateMany({
      where: { matchId, status: "PENDING" },
      data: { status: "CANCELLED" },
    }),
    prisma.rescheduleRequest.create({
      data: { matchId, proposedById: user.id, proposedTime },
    }),
  ]);
  refresh();
  return {
    ok: true,
    message: "Proposed — the other captain can accept it on this page.",
  };
}

export async function respondReschedule(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const requestId = str(formData, "requestId");
  const accept = str(formData, "response") === "accept";

  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: requestId },
    include: { match: { include: { homeTeam: true, awayTeam: true } } },
  });
  if (!request || request.status !== "PENDING")
    return { error: "That proposal is no longer open" };
  const { match } = request;
  const isCaptain =
    match.homeTeam.captainId === user.id ||
    match.awayTeam.captainId === user.id;
  if (!isCaptain || request.proposedById === user.id)
    return { error: "Only the opposing captain can respond" };
  if (match.status === MATCH_STATUS.COMPLETED)
    return { error: "This match is already played" };

  if (!accept) {
    await prisma.rescheduleRequest.update({
      where: { id: requestId },
      data: { status: "DECLINED" },
    });
    refresh();
    return { ok: true, message: "Declined — the current time stands." };
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
  await sendDiscordMessage(
    rescheduleMessage({
      homeName: match.homeTeam.name,
      awayName: match.awayTeam.name,
      week: match.week,
      isPlayoff: match.phase !== "REGULAR",
      when: request.proposedTime.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    }),
  );
  refresh();
  return { ok: true, message: "Accepted — match retimed for both teams." };
}

export async function cancelReschedule(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const requestId = str(formData, "requestId");
  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: requestId },
  });
  if (!request || request.status !== "PENDING")
    return { error: "That proposal is no longer open" };
  if (request.proposedById !== user.id && user.role !== "ADMIN")
    return { error: "Only the proposer can withdraw it" };
  await prisma.rescheduleRequest.update({
    where: { id: requestId },
    data: { status: "CANCELLED" },
  });
  refresh();
  return { ok: true, message: "Proposal withdrawn." };
}
