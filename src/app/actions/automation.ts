"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { logAdminAction } from "@/lib/admin-log";
import { runAutomation } from "@/lib/automation-service";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import type { ActionResult } from "@/lib/action-result";

function refreshAutomationSurfaces(imported: number) {
  updateTag(AUTOMATION_GATE_TAG);
  // A manual pass shares the cron worker but not the cron route, so it owns
  // the same cache contract: imported games must immediately leave cached
  // leader/meta/history scans as well as the rendered application shell.
  if (imported > 0) {
    updateTag("games");
    revalidatePath("/", "layout");
  }
  revalidatePath("/admin");
}

export async function runMaintenanceNow(
  _prev: ActionResult,
  _formData: FormData,
): Promise<ActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }

  let result: Awaited<ReturnType<typeof runAutomation>>;
  try {
    // This is intentionally the exact same election path as cron. There is no
    // force flag and no direct worker call for an administrator to bypass the
    // database owner/token fence.
    result = await runAutomation({ source: "ADMIN" });
  } catch {
    refreshAutomationSurfaces(0);
    await logAdminAction({
      action: "runMaintenanceNow",
      summary:
        "Manual maintenance could not start because runner state was unavailable",
      actor: admin,
    });
    return {
      error:
        "Maintenance could not start or persist its ownership. Check database readiness, then try again.",
    };
  }

  if (result.kind === "lease-held") {
    refreshAutomationSurfaces(0);
    await logAdminAction({
      action: "runMaintenanceNow",
      summary: `Manual maintenance did not start because another runner held the lease; retry after ${result.retryAfterSeconds} seconds`,
      actor: admin,
    });
    return {
      error: `Maintenance is already running under the database lease. Try again in about ${result.retryAfterSeconds} seconds; this control never overrides an active run.`,
    };
  }

  refreshAutomationSurfaces(result.imported);
  await logAdminAction({
    action: "runMaintenanceNow",
    summary: `Manual maintenance ${result.kind}: ${result.status}; imported ${result.imported} games; duration ${result.durationMs}ms; recovered expired lease ${result.recoveredExpiredLease ? "yes" : "no"}`,
    actor: admin,
  });

  if (result.kind === "fenced") {
    return {
      error:
        "Maintenance work finished, but its lease expired and a newer runner now owns persisted health. Current game caches were refreshed; review the latest status before retrying.",
    };
  }

  if (result.status === "FAILED") {
    return {
      error:
        "Maintenance failed. Review the automation health signals, fix the dependency, and retry.",
    };
  }
  if (result.status === "DEGRADED") {
    return {
      error:
        "Maintenance finished with incomplete or deferred work. Review the automation health signals before relying on the next scheduled pass.",
    };
  }

  return {
    message:
      result.imported > 0
        ? `Maintenance finished successfully — ${result.imported} ${result.imported === 1 ? "game" : "games"} imported.`
        : "Maintenance finished successfully — no new games were found.",
  };
}
