"use server";

// Thin auth/toast wrappers around standin-service (which holds the
// integration-tested guards) — the reschedule-actions pattern. Captains line
// up their own match cover; admins passing through here get the any-team
// override, same as their panel. The Discord announcement stays here — a
// webhook failure must never affect the assignment itself.

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import {
  assignStandinGuarded,
  removeStandinGuarded,
} from "@/lib/standin-service";
import { sendDiscordMessage } from "@/lib/discord";
import type { ActionResult } from "@/lib/action-result";

function refresh() {
  revalidatePath("/", "layout");
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
  const seat = target.startsWith("seat:") ? target.slice(5) : null;
  const res = await assignStandinGuarded({
    matchId: str(formData, "matchId"),
    standinUserId: str(formData, "standinUserId"),
    replacingUserId: seat ? null : target,
    teamId: seat ?? undefined,
    actingCaptainId: user.role === "ADMIN" ? null : user.id,
  });
  if (!res.ok) return { error: res.error };
  await sendDiscordMessage(res.announcement, res.mentions);
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
  });
  if (!res.ok) return { error: res.error };
  await sendDiscordMessage(res.announcement, res.mentions);
  refresh();
  return { message: res.message };
}
