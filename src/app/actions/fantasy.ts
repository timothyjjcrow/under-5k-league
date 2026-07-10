"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { fantasyCap, validateFantasyPicks } from "@/lib/fantasy";
import { FANTASY } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";

/**
 * Save the signed-in manager's fantasy five for the active season. Picks are
 * validated against the drafted rosters and the MMR cap, and lock league-wide
 * once the first game is imported (no swapping onto the week's carry).
 */
export async function saveFantasyRoster(
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

  const [members, regs, importedGames] = await Promise.all([
    prisma.teamMember.findMany({
      where: { seasonId: season.id },
      select: { userId: true },
    }),
    prisma.registration.findMany({
      where: { seasonId: season.id, status: "ACTIVE" },
      select: { userId: true, mmr: true },
    }),
    prisma.game.count({ where: { match: { seasonId: season.id } } }),
  ]);
  if (members.length === 0) {
    return { error: "Fantasy opens once teams are drafted" };
  }
  if (importedGames > 0) {
    return {
      error: "Fantasy rosters are locked — the season's first game is in",
    };
  }

  const mmrByUser = new Map(regs.map((r) => [r.userId, r.mmr]));
  const eligible = new Map(
    members.map((m) => [m.userId, mmrByUser.get(m.userId) ?? 0]),
  );
  const picks = formData.getAll("picks").map(String);
  const cap = fantasyCap([...eligible.values()]);
  const error = validateFantasyPicks(picks, eligible, cap, FANTASY.SLOTS);
  if (error) return { error };

  await prisma.$transaction(async (tx) => {
    const roster = await tx.fantasyRoster.upsert({
      where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
      create: { seasonId: season.id, userId: user.id },
      update: {},
    });
    await tx.fantasyPick.deleteMany({ where: { rosterId: roster.id } });
    await tx.fantasyPick.createMany({
      data: picks.map((p) => ({ rosterId: roster.id, userId: p })),
    });
  });

  revalidatePath("/fantasy");
  return { message: "Fantasy five saved — good luck!" };
}
