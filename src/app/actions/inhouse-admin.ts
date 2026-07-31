"use server";

// Thin auth/parse/toast wrapper around `voidLastResult` — the inhouse-bets
// actions pattern. All the void reasoning (the live-stakes refusal, the
// guarded COMPLETED→CANCELLED claim, the AdminAction record, the pot
// announcement) lives in inhouse-service.ts; what belongs here is the
// session, the form, and the toast.
//
// It exists because the room's void button is gated on `state.lastResult`,
// which is built only for a viewer who PLAYED in the completed game and only
// for 10 minutes after it — so the documented use case ("the scan picked up
// the wrong game", reported by players to an admin who wasn't one of the ten,
// or reported later) had no reachable control anywhere. /inhouse/history now
// renders a per-row Void for admins through this action, with the game named
// in the confirm.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { str } from "@/lib/form";
import { voidLastResult } from "@/lib/inhouse-service";
import type { ActionResult } from "@/lib/action-result";

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
  revalidatePath("/", "layout");
  return {
    message:
      "Result voided — the ladder recalculates without it, and any Cred payouts reverse to pre-game balances",
  };
}
