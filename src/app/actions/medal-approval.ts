"use server";

// The player's half of medal approvals (medal-approval.ts): "Ask an admin to
// approve" on /me, for a player whose medal is over the league's line or
// whose account the smurf check flags (smurf-check.ts). The
// service writes the request; the admins hear about it from the bot, after
// the commit and best-effort, and answer on /admin.

import { adminHref } from "@/lib/admin-tabs";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import { runAfterResponse } from "@/lib/after-response";
import { sendDirectMessage } from "@/lib/discord-roles";
import { resolveSiteUrl } from "@/lib/site-url";
import {
  MEDAL_APPROVAL_ASKED_MESSAGE,
  MEDAL_APPROVALS_ANCHOR,
  medalApprovalRequestedDm,
} from "@/lib/medal-approval";
import {
  adminDiscordIds,
  askMedalApproval,
} from "@/lib/medal-approval-service";
import type { ActionResult } from "@/lib/action-result";

export async function askForMedalApproval(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let viewer;
  try {
    viewer = await requireUser();
  } catch {
    return { error: "Sign in to ask." };
  }
  const asked = await askMedalApproval(viewer, str(formData, "note"));
  if (!asked.ok) return { error: asked.error };
  revalidatePath("/me");
  revalidatePath("/admin", "layout");
  // Each admin who must answer, by DM, after the response: a slow or
  // closed Discord never holds up the player's toast, and the request is on
  // /admin either way.
  await runAfterResponse(async () => {
    const content = medalApprovalRequestedDm({
      playerName: asked.playerName,
      rankTier: asked.rankTier,
      note: asked.note,
      adminUrl: `${resolveSiteUrl()}${adminHref(MEDAL_APPROVALS_ANCHOR)}`,
      reason: asked.reason,
      signals: asked.signals,
    });
    for (const discordId of await adminDiscordIds()) {
      await sendDirectMessage(discordId, content);
    }
  });
  return { message: MEDAL_APPROVAL_ASKED_MESSAGE };
}
