"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { predictionOpen } from "@/lib/pickem";
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
  if (!predictionOpen(match)) {
    return { error: "Predictions are locked for this match" };
  }

  await prisma.prediction.upsert({
    where: { matchId_userId: { matchId, userId: user.id } },
    create: { matchId, userId: user.id, pickedTeamId },
    update: { pickedTeamId },
  });

  revalidatePath("/pickem");
  const name =
    pickedTeamId === match.homeTeamId
      ? match.homeTeam.name
      : match.awayTeam.name;
  return { message: `Locked in: ${name} to win` };
}
