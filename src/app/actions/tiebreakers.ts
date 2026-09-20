"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { createTiebreakerWeek, clearTiebreakerWeek } from "@/lib/tiebreaker-service";
import { actionErrorMessage } from "@/lib/user-facing-error";
import { logAdminAction } from "@/lib/admin-log";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import type { ActionResult } from "@/lib/action-result";
import { sendDiscordMessage, standinRemovedMessage } from "@/lib/discord";
import { mentionsOf } from "@/lib/discord-mentions";

export async function scheduleTiebreakerWeek(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try { await requireAdmin(); } catch { return { error: "Not authorized" }; }
  const seasonId = String(form.get("seasonId") ?? "");
  const revision = String(form.get("expectedRevision") ?? "");
  if (!seasonId || !revision) return { error: "This tiebreaker control is stale. Reload and try again." };
  try {
    const result = await createTiebreakerWeek(seasonId, revision);
    updateTag(AUTOMATION_GATE_TAG);
    revalidatePath("/", "layout");
    await logAdminAction({ action: "scheduleTiebreakerWeek", seasonId,
      summary: `Scheduled ${result.matchCount} tiebreaker match${result.matchCount === 1 ? "" : "es"} in week ${result.week}` });
    return { message: `Tiebreaker week ${result.week}: ${result.matchCount} match${result.matchCount === 1 ? "" : "es"} scheduled.${result.untimedCount ? " Set the opening times in Admin → Tiebreakers." : ""}` };
  } catch (error) {
    return { error: actionErrorMessage(error, "Couldn't schedule the tiebreaker week. Reload and try again.", "tiebreakers.schedule") };
  }
}

export async function resetTiebreakerWeek(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try { await requireAdmin(); } catch { return { error: "Not authorized" }; }
  const seasonId = String(form.get("seasonId") ?? "");
  const revision = String(form.get("expectedRevision") ?? "");
  if (!seasonId || !revision) return { error: "This tiebreaker control is stale. Reload and try again." };
  try {
    const result = await clearTiebreakerWeek(seasonId, revision);
    updateTag("games");
    updateTag(AUTOMATION_GATE_TAG);
    revalidatePath("/", "layout");
    let failedStandDownNotices = 0;
    for (const assignment of result.standDowns) {
      try {
        const sent = await sendDiscordMessage(
          standinRemovedMessage({
            ...assignment,
            isPlayoff: false,
            isTiebreaker: true,
          }),
          mentionsOf([assignment.discordId]),
        );
        if (!sent) failedStandDownNotices += 1;
      } catch {
        // The reset is already committed. A notification failure cannot turn
        // it into an apparent failed reset or stop the remaining stand-downs.
        failedStandDownNotices += 1;
      }
    }
    await logAdminAction({ action: "resetTiebreakerWeek", seasonId,
      summary: `Reset ${result.matchCount} tiebreaker series; archived ${result.removedGameCount} game IDs; removed ${result.checkins} check-ins, ${result.standins} standins, ${result.predictions} picks and ${result.reschedules} reschedule requests${failedStandDownNotices ? `; ${failedStandDownNotices} Discord stand-down notification(s) failed` : ""}` });
    return { message: `Tiebreaker week reset.${result.removedGameCount ? ` Saved ${result.removedGameCount} imported game IDs for re-import.` : ""} Review the regular results, then schedule any ties again.${failedStandDownNotices ? ` Discord warning: ${failedStandDownNotices} standin stand-down notification(s) failed; notify the affected players manually.` : ""}` };
  } catch (error) {
    return { error: actionErrorMessage(error, "Couldn't reset the tiebreaker week. Reload and try again.", "tiebreakers.reset") };
  }
}
