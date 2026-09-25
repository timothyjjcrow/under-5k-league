"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requireUser } from "@/lib/auth";
import { confirmMatchLineup } from "@/lib/match-lineups";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { actionErrorMessage } from "@/lib/user-facing-error";
import type { ActionResult } from "@/lib/action-result";

export async function confirmLineupAction(_previous: ActionResult, form: FormData): Promise<ActionResult> {
  let actor;
  try { actor = await requireUser(); } catch { return { error: "Sign in required" }; }
  const revision = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  };
  const selected = form.getAll("playerId");
  if (selected.some((value) => typeof value !== "string")) return { error: "Choose valid lineup players." };
  try {
    await confirmMatchLineup({
      actor,
      matchId: String(form.get("matchId") ?? ""),
      teamId: String(form.get("teamId") ?? ""),
      expectedScheduleRevision: revision("expectedScheduleRevision"),
      expectedLogisticsRevision: revision("expectedLogisticsRevision"),
      expectedLineupRevision: revision("expectedLineupRevision"),
      // Captains pick who plays, never positions. The seat column stays for
      // lineups confirmed before positions were removed from the form.
      selections: selected.map((id) => ({ userId: String(id), position: null })),
    });
  } catch (error) {
    if (["P2034", "P2002"].includes((error as { code?: string }).code ?? "")) {
      return { error: "The match or lineup just changed — reload and review it before confirming." };
    }
    return { error: actionErrorMessage(error, "Could not confirm the lineup — reload and try again.", "lineup.confirm") };
  }
  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/", "layout");
  return { message: "Playing lineup confirmed. Later changes will require a new confirmation." };
}
