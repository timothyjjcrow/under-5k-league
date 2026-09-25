"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import type { ActionResult } from "@/lib/action-result";
import { str } from "@/lib/form";
import { backfillGameParticipants } from "@/lib/game-participants";
import { correctGameIdentity } from "@/lib/game-identity-correction";
import { actionErrorMessage } from "@/lib/user-facing-error";

export async function correctGameIdentityAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  let actor;
  try { actor = await requireAdmin(); } catch { return { error: "Not authorized" }; }
  const rawIndex = str(form, "sourceLineIndex");
  if (!/^\d{1,3}$/.test(rawIndex)) return { error: "Invalid player line — reload the box score." };
  try {
    const result = await correctGameIdentity({
      actorId: actor.id, gameId: str(form, "gameId"), sourceLineIndex: Number(rawIndex),
      expectedSourceDigest: str(form, "expectedSourceDigest"),
      userId: str(form, "userId").trim() || null,
      teamId: str(form, "teamId").trim() || null,
      reason: str(form, "reason"),
    });
    if (result.changed) {
      updateTag("games");
      revalidatePath(`/matches/${result.matchId}`);
      revalidatePath("/players", "layout");
      revalidatePath("/hall-of-fame");
      revalidatePath("/admin");
    }
    return { ok: true, message: result.changed ? "Player attribution corrected and audited." : "That attribution is already current." };
  } catch (error) {
    return { error: actionErrorMessage(error, "Could not safely correct this player — reload and try again.", "GAME_IDENTITY") };
  }
}

export async function backfillGameParticipantsAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  let actor;
  try { actor = await requireAdmin(); } catch { return { error: "Not authorized" }; }
  try {
    const result = await backfillGameParticipants({
      actorId: actor.id, seasonId: str(form, "seasonId").trim() || undefined,
      cursor: str(form, "cursor").trim() || undefined, limit: 20,
    });
    revalidatePath("/admin");
    return { ok: true, message: `Indexed ${result.rebuilt} games; ${result.invalid} incomplete box scores kept out of public stats; ${result.remaining} remaining.` };
  } catch (error) {
    return { error: actionErrorMessage(error, "Could not finish this indexing batch — try again.", "PARTICIPANT_BACKFILL") };
  }
}
