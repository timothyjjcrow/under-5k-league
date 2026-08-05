"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { fantasyCap, fantasyPrices, validateFantasyPicks } from "@/lib/fantasy";
import { FANTASY } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import { postAuctionWorkOpen } from "@/lib/league-lifecycle";
import { Prisma } from "@prisma/client";
import { raceHook } from "@/lib/race-hook";
import {
  claimSideGameDraft,
  claimSideGameSeason,
  isSideGameTransactionConflict,
  retrySideGameTransaction,
} from "@/lib/side-game-claims";

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
  const expectedSeasonId = String(
    formData.get("expectedSeasonId") ?? "",
  ).trim();
  if (!expectedSeasonId) {
    return { error: "Reload fantasy and choose your five again" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.id !== expectedSeasonId) {
    return {
      error:
        "The active season changed — reload fantasy before saving a roster",
    };
  }

  const [draft, members, regs] = await Promise.all([
    prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true },
    }),
    prisma.teamMember.findMany({
      where: { seasonId: season.id },
      select: { userId: true },
    }),
    prisma.registration.findMany({
      where: { seasonId: season.id, status: "ACTIVE" },
      select: { userId: true, mmr: true },
    }),
  ]);
  if (!postAuctionWorkOpen(season.status, draft?.status)) {
    return { error: "Fantasy opens after the auction is complete" };
  }
  if (members.length === 0) {
    return { error: "Fantasy opens once teams are drafted" };
  }

  const mmrByUser = new Map(regs.map((r) => [r.userId, r.mmr]));
  const eligible = fantasyPrices(
    new Map(members.map((m) => [m.userId, mmrByUser.get(m.userId) ?? 0])),
  );
  const picks = formData.getAll("picks").map(String);
  const cap = fantasyCap([...eligible.values()]);
  const error = validateFantasyPicks(picks, eligible, cap, FANTASY.SLOTS);
  if (error) return { error };

  try {
    await retrySideGameTransaction(() =>
      prisma.$transaction(
        async (tx) => {
          // The league-wide lock is checked INSIDE the write transaction. The
          // durable Season marker is written by importGameForMatch. A read alone
          // is not a boundary under PostgreSQL Serializable: the roster write can
          // validly serialize before a concurrent Season update. The guarded
          // shared Season/Draft locks below are the actual row claims. The
          // game count remains a legacy/backfill guard for existing seasons.
          const [
            currentSeason,
            currentDraft,
            games,
            currentMembers,
            currentRegs,
          ] = await Promise.all([
            tx.season.findUnique({ where: { id: season.id } }),
            tx.draft.findUnique({
              where: { seasonId: season.id },
              select: { id: true, status: true },
            }),
            tx.game.count({ where: { match: { seasonId: season.id } } }),
            tx.teamMember.findMany({
              where: { seasonId: season.id },
              select: { userId: true },
            }),
            tx.registration.findMany({
              where: { seasonId: season.id, status: "ACTIVE" },
              select: { userId: true, mmr: true },
            }),
          ]);
          if (
            !currentSeason?.isActive ||
            !postAuctionWorkOpen(currentSeason.status, currentDraft?.status)
          ) {
            throw new Error("FANTASY_NOT_OPEN");
          }
          if (currentSeason.fantasyLockedAt || games > 0) {
            throw new Error("FANTASY_LOCKED");
          }
          await raceHook("fantasy.save.afterLockRead");

          // Claim the precise lifecycle snapshot before creating child rows. On
          // PostgreSQL this is a shared lock: managers remain concurrent with one
          // another, while first import / phase / archive updates are exclusive.
          if (
            !(await claimSideGameSeason(tx, currentSeason, {
              fantasyUnlocked: true,
            }))
          ) {
            throw new Error("FANTASY_STATE_CHANGED");
          }
          if (currentDraft) {
            if (!(await claimSideGameDraft(tx, currentDraft))) {
              throw new Error("FANTASY_STATE_CHANGED");
            }
          }

          const currentMmr = new Map(
            currentRegs.map((registration) => [
              registration.userId,
              registration.mmr,
            ]),
          );
          const currentEligible = fantasyPrices(
            new Map(
              currentMembers.map((member) => [
                member.userId,
                currentMmr.get(member.userId) ?? 0,
              ]),
            ),
          );
          const changedError = validateFantasyPicks(
            picks,
            currentEligible,
            fantasyCap([...currentEligible.values()]),
            FANTASY.SLOTS,
          );
          if (changedError) throw new Error("FANTASY_ROSTERS_CHANGED");
          const roster = await tx.fantasyRoster.upsert({
            where: {
              seasonId_userId: { seasonId: season.id, userId: user.id },
            },
            create: { seasonId: season.id, userId: user.id },
            update: {},
          });
          await tx.fantasyPick.deleteMany({ where: { rosterId: roster.id } });
          await tx.fantasyPick.createMany({
            data: picks.map((p) => ({ rosterId: roster.id, userId: p })),
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (e) {
    if ((e as Error).message === "FANTASY_NOT_OPEN") {
      return {
        error: "The auction changed — fantasy opens after it is complete",
      };
    }
    if ((e as Error).message === "FANTASY_ROSTERS_CHANGED") {
      return {
        error: "The drafted rosters changed — reload your fantasy picks",
      };
    }
    if ((e as Error).message === "FANTASY_STATE_CHANGED") {
      return {
        error:
          "The league state changed while you saved — reload; fantasy may now be locked",
      };
    }
    if ((e as Error).message === "FANTASY_LOCKED") {
      return {
        error: "Fantasy rosters are locked — the season's first game is in",
      };
    }
    if (isSideGameTransactionConflict(e)) {
      return {
        error:
          "The league state changed while you saved — reload; fantasy may now be locked",
      };
    }
    throw e;
  }

  revalidatePath("/fantasy");
  return { message: "Fantasy five saved — good luck!" };
}
