"use server";

// Thin auth/parse/toast wrapper around `adjustCred` — the standins-actions
// pattern. Every piece of money reasoning lives in `inhouse-bet-service.ts`
// (the debit-only overdraw floor, the ledger receipt in the same transaction
// as the movement, the AdminAction log); what belongs here is the session, the
// form, and the toast.
//
// It exists because `adjustCred` shipped guarded, integration-tested and in the
// mutation baseline with NOTHING in the app calling it. The only way to repair
// a balance was psql against production — which is also the one environment
// where the balance most needed repairing, since `reverseLobbyBets` claws a
// payout back with an unfloored decrement and a player who re-staked their
// winnings first lands below zero.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { str } from "@/lib/form";
import { prisma } from "@/lib/prisma";
import { INHOUSE_BETS } from "@/lib/constants";
import { adjustCred } from "@/lib/inhouse-bet-service";
import type { ActionResult } from "@/lib/action-result";

/**
 * Ceiling on ONE correction. Not a rule about what an admin may do — a typo
 * guard. `adjustCred` validates "whole, non-zero" and nothing else, so a stray
 * trailing zero on a 500 mints 5,000 Cred into an economy whose entire health
 * story is that it is zero-sum. It is reversible by a second adjustment, but
 * nothing would report it: ADJUST is deliberately excluded from the profit
 * reasons, so the zero-sum alarm on /admin cannot see an adjustment at all.
 *
 * 100 × MAX_STAKE — far above any correction a real dispute produces, far
 * below a fat finger.
 */
const MAX_ADJUSTMENT = INHOUSE_BETS.MAX_STAKE * 100;

/**
 * Move one player's Cred balance, with a note saying why.
 *
 * Reversible by another adjustment in the opposite direction, which is exactly
 * why the form uses `<SubmitButton confirm>` and not `<DangerSubmit>`: the
 * typed-name barrier is reserved for the five actions with no in-app undo, and
 * spending it here would rebuild the confirmation fatigue it exists to break.
 */
export async function adjustCredAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }

  const userId = str(formData, "userId");
  if (!userId) return { error: "Pick a player to correct." };
  // Read for the toast, but it doubles as the existence check: `adjustCred`
  // calls `ensureCredAccount`, whose create would fail on the foreign key with
  // a raw Prisma error that <ActionForm> can only render as "couldn't reach the
  // server". Naming the player back is also how an admin confirms they picked
  // the right one out of a dropdown of similar Steam personas.
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  if (!target) return { error: "That player no longer exists." };

  // Parsed, never clamped. `clampInt` would quietly rewrite a mistyped 50000 to
  // the ceiling and then report success — a silent rewrite of an amount of
  // money is the one thing this form must not do (the signup MMR clamp says so
  // out loud for the same reason, and that one is only an estimate).
  const raw = str(formData, "delta").trim();
  const delta = Number(raw);
  if (!raw || !Number.isInteger(delta) || delta === 0) {
    return {
      error: "Enter a whole, non-zero amount — negative takes Cred away.",
    };
  }
  if (Math.abs(delta) > MAX_ADJUSTMENT) {
    return {
      error: `That's larger than any correction should be. The cap is ${MAX_ADJUSTMENT} Cred per adjustment — split it if you really mean it.`,
    };
  }

  // REQUIRED here, where the service takes it as optional. An adjustment is the
  // one Cred movement with no mechanical provenance — every other ledger row
  // traces back to a wager and a played game, and this one traces back only to
  // a person — so the note IS the provenance. A blank one leaves the ledger
  // saying "somebody decided this", which is worse than no record at all
  // because it looks like one.
  const note = str(formData, "note").trim();
  if (!note) {
    return {
      error:
        "Say why. The note is the only record of what this correction was for.",
    };
  }

  const res = await adjustCred(admin, userId, delta, note);
  if (!res.ok) return { error: res.error };

  revalidatePath("/", "layout");
  return {
    message: `${target.name}: ${delta > 0 ? "+" : ""}${delta} Cred. The ledger has the note.`,
  };
}
