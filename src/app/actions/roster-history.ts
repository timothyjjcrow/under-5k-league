"use server";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { backfillRosterTenures } from "@/lib/roster-history";
import { actionErrorMessage } from "@/lib/user-facing-error";
import type { ActionResult } from "@/lib/action-result";

export async function captureRosterHistoryAction(): Promise<ActionResult> {
  let actor;
  try { actor = await requireAdmin(); } catch { return { error: "Not authorized" }; }
  try {
    const result = await backfillRosterTenures({ actorId: actor.id, limit: 50 });
    revalidatePath("/admin");
    revalidatePath("/players", "layout");
    return { ok: true, message: `Captured ${result.captured} surviving memberships and reconciled ${result.reconciled} missing memberships; ${result.remaining} remaining. Unknown historical dates and ratings remain unknown.` };
  } catch (error) {
    return { error: actionErrorMessage(error, "Could not finish this history batch — try again.", "ROSTER_HISTORY_CAPTURE") };
  }
}
