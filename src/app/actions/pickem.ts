"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { predictionOpen, predictionOpenWhere } from "@/lib/pickem";
import { str } from "@/lib/form";
import type { ActionResult } from "@/lib/action-result";

/**
 * Save (or change) the signed-in user's predicted winner for a match. Picks
 * lock at the match's scheduled start — and always once it's completed.
 */
export async function savePrediction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };

  const matchId = str(formData, "matchId");
  const pickedTeamId = str(formData, "pickedTeamId");

  const match = await prisma.match.findFirst({
    where: { id: matchId, seasonId: season.id },
    include: { homeTeam: true, awayTeam: true },
  });
  if (!match) return { error: "Unknown match" };
  if (pickedTeamId !== match.homeTeamId && pickedTeamId !== match.awayTeamId) {
    return { error: "Pick one of the two teams playing" };
  }
  // The lock rides IN the write (rule 1: an auto-sync import can flip the
  // match LIVE between any read-time check and the write — a post-information
  // pick would corrupt the oracle board). There is deliberately NO standalone
  // predictionOpen check up front: it would intercept every staged test and
  // leave the WHERE unfalsifiable (the saveRegistration lesson).
  const updated = await prisma.prediction.updateMany({
    where: { matchId, userId: user.id, match: predictionOpenWhere() },
    data: { pickedTeamId },
  });
  if (updated.count === 0) {
    // No row updated: either no pick exists yet, or the match locked. Re-read
    // to discriminate, then create. The create leg keeps a residual
    // read-then-insert window (create carries no relation WHERE) — accepted
    // at play stakes.
    const fresh = await prisma.match.findUnique({ where: { id: matchId } });
    if (!fresh || !predictionOpen(fresh)) {
      return { error: "Predictions are locked for this match" };
    }
    try {
      await prisma.prediction.create({
        data: { matchId, userId: user.id, pickedTeamId },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
      // Two tabs raced the first pick — fall back to the guarded update.
      const retry = await prisma.prediction.updateMany({
        where: { matchId, userId: user.id, match: predictionOpenWhere() },
        data: { pickedTeamId },
      });
      if (retry.count === 0) {
        return { error: "Predictions are locked for this match" };
      }
    }
  }

  revalidatePath("/pickem");
  const name =
    pickedTeamId === match.homeTeamId
      ? match.homeTeam.name
      : match.awayTeam.name;
  return { message: `Locked in: ${name} to win` };
}
