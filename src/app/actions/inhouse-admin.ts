"use server";

// Thin auth/parse/toast wrappers for the inhouse admin controls that live
// outside the room's own API: voiding a result (`voidLastResult`) and an
// admin's inhouse MMR and medal for a player (`saveInhouseRating`). The
// reasoning (the guarded claims, the room publish, the AdminAction record of
// a void, the correction announcement) lives in the services; what belongs
// here is the session, the form, and the toast.
//
// voidInhouseResult exists because the room's void button is gated on
// `state.lastResult`, which is built only for a viewer who PLAYED in the
// completed game and only for 10 minutes after it — so the documented use
// case ("the scan picked up the wrong game", reported by players to an admin
// who wasn't one of the ten, or reported later) had no reachable control
// anywhere. /inhouse/history now renders a per-row Void for admins through
// this action, with the game named in the confirm.

import { revalidatePath, updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { logAdminAction } from "@/lib/admin-log";
import { requireAdmin } from "@/lib/auth";
import { str } from "@/lib/form";
import {
  inhouseRatingLogSummary,
  inhouseRatingSavedMessage,
  parseInhouseRatingForm,
} from "@/lib/inhouse-rating";
import { saveInhouseRating } from "@/lib/inhouse-rating-service";
import { voidLastResult } from "@/lib/inhouse-service";
import type { ActionResult } from "@/lib/action-result";
import { adminOrError, refresh } from "./admin-shared";

export async function voidInhouseResult(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const lobbyId = str(formData, "lobbyId");
  if (!lobbyId) return { error: "Missing game" };
  const res = await voidLastResult(user, lobbyId);
  if (!res.ok) return { error: res.error };
  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/", "layout");
  return {
    message: "Result voided — the ladder recalculates without it",
  };
}

/**
 * Set a player's inhouse MMR and medal from /admin/inhouse-players: any
 * player, signed up for the league or not (Tim, 2026-10-17). The MMR is used
 * by every queue join over their signup's and anything they type; the medal
 * is the site-wide one.
 */
export async function setInhouseRating(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const parsed = parseInhouseRatingForm(formData);
  if (!parsed.ok) return { error: parsed.error };
  const saved = await saveInhouseRating(parsed.input);
  if (!saved.ok) return { error: saved.error };
  // The medal shows on league pages too.
  refresh();
  await logAdminAction({
    action: "setInhouseRating",
    summary: inhouseRatingLogSummary(saved),
  });
  return { message: inhouseRatingSavedMessage(saved) };
}
