"use server";

// Thin auth/toast wrappers around match-report-service (which holds the
// integration-tested captain guards) — the reschedule-actions pattern.

import { revalidatePath, revalidateTag } from "next/cache";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import {
  reportAutoDetect as detectInService,
  reportImportGame as importInService,
} from "@/lib/match-report-service";
import type { ActionResult } from "@/lib/action-result";

// Game imports must also clear the unstable_cache "games" tag (CLAUDE.md:
// bust the tag from a request scope) — mirrors admin.ts's refreshGames.
function refreshGames() {
  revalidateTag("games", "max");
  revalidatePath("/", "layout");
}

/** A captain imports their finished game by Dota match id/URL. */
export async function captainImportGame(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  let res;
  try {
    res = await importInService(
      user.id,
      str(formData, "matchId"),
      str(formData, "dotaMatchRef"),
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't report the result" };
  }
  if (!res.ok) return { error: res.error };
  refreshGames();
  return { ok: true, message: res.message };
}

/** A captain auto-detects their match's games from the rosters' recent games. */
export async function captainAutoDetect(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  let res;
  try {
    res = await detectInService(user.id, str(formData, "matchId"));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't report the result" };
  }
  if (!res.ok) return { error: res.error };
  refreshGames();
  return { ok: true, message: res.message };
}
