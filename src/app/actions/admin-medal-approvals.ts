"use server";

// The admin's half of medal approvals (medal-approval.ts): approve a player
// over the medal limit at the MMR they play at, decline, or remove a row,
// from /admin's "Medal limit approvals". Auth, parse, the service's guarded
// write, the log, then the player's DM after the commit, best-effort.

import { logAdminAction } from "@/lib/admin-log";
import { str } from "@/lib/form";
import { runAfterResponse } from "@/lib/after-response";
import { sendDirectMessage } from "@/lib/discord-roles";
import { resolveSiteUrl } from "@/lib/site-url";
import {
  MEDAL_APPROVAL_CARD_ANCHOR,
  medalApprovalDecidedDm,
  medalApprovalLogSummary,
  medalApprovalRemovedMessage,
  medalApprovedMessage,
  medalDeclinedMessage,
  parseApprovalMmr,
} from "@/lib/medal-approval";
import {
  approveMedalRequest,
  declineMedalRequest,
  removeMedalApproval,
} from "@/lib/medal-approval-service";
import type { ActionResult } from "@/lib/action-result";
import { adminOrError, refresh } from "./admin-shared";

/** Tell the player the answer, after the response; nothing waits on it. */
async function tellPlayer(
  discordId: string | null,
  approved: boolean,
  mmr: number | null,
): Promise<void> {
  if (!discordId) return;
  await runAfterResponse(() =>
    sendDirectMessage(
      discordId,
      medalApprovalDecidedDm({
        approved,
        mmr,
        meUrl: `${resolveSiteUrl()}/me#${MEDAL_APPROVAL_CARD_ANCHOR}`,
      }),
    ),
  );
}

/** Approve a request (pending or declined) at the MMR the admin typed. */
export async function approveMedalApproval(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const parsed = parseApprovalMmr(str(formData, "mmr"));
  if (!parsed.ok) return { error: parsed.error };
  const decided = await approveMedalRequest(admin, {
    approvalId: str(formData, "approvalId"),
    judgedStatus: str(formData, "status"),
    mmr: parsed.mmr,
  });
  if (!decided.ok) return { error: decided.error };
  refresh();
  await logAdminAction({
    action: "approveMedalApproval",
    summary: medalApprovalLogSummary("approve", decided.name, parsed.mmr),
  });
  await tellPlayer(decided.discordId, true, parsed.mmr);
  return { message: medalApprovedMessage(decided.name, parsed.mmr) };
}

/** Decline a pending request. */
export async function declineMedalApproval(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const decided = await declineMedalRequest(admin, str(formData, "approvalId"));
  if (!decided.ok) return { error: decided.error };
  refresh();
  await logAdminAction({
    action: "declineMedalApproval",
    summary: medalApprovalLogSummary("decline", decided.name),
  });
  await tellPlayer(decided.discordId, false, null);
  return { message: medalDeclinedMessage(decided.name) };
}

/** Remove a request or an approval: the player is judged by medal again. */
export async function removeMedalApprovalAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const removed = await removeMedalApproval(admin, {
    approvalId: str(formData, "approvalId"),
    judgedStatus: str(formData, "status"),
  });
  if (!removed.ok) return { error: removed.error };
  refresh();
  await logAdminAction({
    action: "removeMedalApprovalAction",
    summary: medalApprovalLogSummary("remove", removed.name),
  });
  return { message: medalApprovalRemovedMessage(removed.name, removed.wasApproved) };
}
