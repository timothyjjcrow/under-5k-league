"use server";

// Thin auth/toast wrappers around standin-service (which holds the
// integration-tested guards) — the reschedule-actions pattern. Captains line
// up their own match cover; admins passing through here get the any-team
// override, same as their panel. The Discord announcement stays here — a
// webhook failure must never affect the assignment itself.

import { revalidatePath, updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { refreshLeagueStatus } from "@/lib/league-status-service";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { parseSeatTarget } from "@/lib/standin";
import {
  approveStandinRequest,
  assignStandinGuarded,
  cancelStandinRequest,
  declineStandinRequest,
  removeStandinGuarded,
} from "@/lib/standin-service";
import { sendDiscordMessage } from "@/lib/discord";
import { reachabilityNote, withReachabilityNote } from "@/lib/discord-roles";
import type { ActionResult } from "@/lib/action-result";

function refresh() {
  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/", "layout");
  // The #schedule status card lists this week's standins.
  void refreshLeagueStatus();
}

/** A captain assigns a standin to cover a player on THEIR team for a match. */
export async function captainAssignStandin(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  // Same encoding as the admin form: a plain userId covers that player,
  // `seat:<teamId>` fills an EMPTY seat on a short roster. The service still
  // checks that the acting captain owns the team either way.
  const target = str(formData, "replacingUserId");
  const seat = parseSeatTarget(target);
  const res = await assignStandinGuarded({
    matchId: str(formData, "matchId"),
    standinUserId: str(formData, "standinUserId"),
    replacingUserId: seat ? null : target,
    teamId: seat ?? undefined,
    actingCaptainId: user.role === "ADMIN" ? null : user.id,
    actingUserId: user.id,
    // The captain's card follows the captains' rule even for an admin who
    // captains: a standin over the MMR allowance waits for the other
    // captain. Only the admin panel books over it.
    overLimit: "ask",
  });
  if (!res.ok) return { error: res.error };
  await sendDiscordMessage(res.announcement, res.mentions);
  refresh();
  // If the announcement structurally can't reach whoever must act on it (the
  // standin, or the other captain for a request: unlinked, not in the server,
  // stuck behind the rules screen), the captain finds out NOW, not on match
  // night. "" when reachable or unknowable.
  return {
    message: withReachabilityNote(
      res.message,
      await reachabilityNote(res.reachUserId ?? str(formData, "standinUserId")),
    ),
  };
}

/**
 * The other captain agrees to a standin over the MMR allowance, which books
 * them. Always as a captain, never the admin override: an admin agrees from
 * the admin panel, where it is logged.
 */
export async function captainApproveStandinRequest(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const res = await approveStandinRequest({
    requestId: str(formData, "requestId"),
    actingCaptainId: user.id,
    actingUserId: user.id,
  });
  if (!res.ok) return { error: res.error };
  await sendDiscordMessage(res.announcement, res.mentions);
  refresh();
  return {
    message: withReachabilityNote(
      res.message,
      res.reachUserId ? await reachabilityNote(res.reachUserId) : "",
    ),
  };
}

/** The other captain declines a standin request; the asking captain is told. */
export async function captainDeclineStandinRequest(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const res = await declineStandinRequest({
    requestId: str(formData, "requestId"),
    actingCaptainId: user.id,
    actingUserId: user.id,
  });
  if (!res.ok) return { error: res.error };
  await sendDiscordMessage(res.announcement, res.mentions);
  refresh();
  return { message: res.message };
}

/** The asking captain withdraws their request, freeing the seat. */
export async function captainCancelStandinRequest(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const res = await cancelStandinRequest({
    requestId: str(formData, "requestId"),
    actingCaptainId: user.id,
    actingUserId: user.id,
  });
  if (!res.ok) return { error: res.error };
  refresh();
  return { message: res.message };
}

/** A captain removes a standin assignment from their own team. */
export async function captainRemoveStandin(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const res = await removeStandinGuarded({
    assignmentId: str(formData, "assignmentId"),
    actingCaptainId: user.role === "ADMIN" ? null : user.id,
    actingUserId: user.id,
  });
  if (!res.ok) return { error: res.error };
  await sendDiscordMessage(res.announcement, res.mentions);
  refresh();
  return { message: res.message };
}
