"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { predictionOpen } from "@/lib/pickem";
import { str } from "@/lib/form";
import type { ActionResult } from "@/lib/action-result";
import { postAuctionWorkOpen } from "@/lib/league-lifecycle";
import { raceHook } from "@/lib/race-hook";
import { Prisma } from "@prisma/client";
import {
  claimOpenPredictionMatch,
  claimSideGameDraft,
  claimSideGameSeason,
  isSideGameTransactionConflict,
  retrySideGameTransaction,
} from "@/lib/side-game-claims";

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

  const draft = await prisma.draft.findUnique({
    where: { seasonId: season.id },
    select: { status: true },
  });
  if (!postAuctionWorkOpen(season.status, draft?.status)) {
    return {
      error:
        season.status === "COMPLETE"
          ? "Pick'em is closed for the completed season"
          : "Pick'em opens after the auction is complete",
    };
  }

  const matchId = str(formData, "matchId");
  const pickedTeamId = str(formData, "pickedTeamId");

  let name: string;
  try {
    name = await retrySideGameTransaction(() =>
      prisma.$transaction(
        async (tx) => {
          // One authoritative snapshot owns phase, matchup, deadline and write.
          // A Serializable read alone does not conflict with the Prediction
          // child write, so the guarded Season/Draft/Match claims after the test
          // seam are what close the old read-then-insert hole.
          const match = await tx.match.findFirst({
            where: { id: matchId, seasonId: season.id },
            include: {
              homeTeam: true,
              awayTeam: true,
              season: {
                include: {
                  draft: { select: { id: true, status: true } },
                },
              },
            },
          });
          if (!match) throw new Error("PICKEM_UNKNOWN_MATCH");
          if (
            !match.season.isActive ||
            !postAuctionWorkOpen(
              match.season.status,
              match.season.draft?.status,
            )
          ) {
            throw new Error("PICKEM_PHASE_LOCKED");
          }
          if (
            pickedTeamId !== match.homeTeamId &&
            pickedTeamId !== match.awayTeamId
          ) {
            throw new Error("PICKEM_INVALID_TEAM");
          }
          if (!predictionOpen(match)) throw new Error("PICKEM_MATCH_LOCKED");
          await raceHook("pickem.save.afterLockRead");

          // Claim phase rows first, then the fixture — the same broad ordering
          // result import uses. PostgreSQL shared locks keep a deadline rush
          // concurrent while excluding phase/archive/reschedule/LIVE updates.
          if (!(await claimSideGameSeason(tx, match.season))) {
            throw new Error("PICKEM_STATE_CHANGED");
          }
          if (match.season.draft) {
            if (!(await claimSideGameDraft(tx, match.season.draft))) {
              throw new Error("PICKEM_STATE_CHANGED");
            }
          }
          if (!(await claimOpenPredictionMatch(tx, match))) {
            throw new Error("PICKEM_MATCH_LOCKED");
          }

          await tx.prediction.upsert({
            where: { matchId_userId: { matchId, userId: user.id } },
            create: { matchId, userId: user.id, pickedTeamId },
            update: { pickedTeamId },
          });
          return pickedTeamId === match.homeTeamId
            ? match.homeTeam.name
            : match.awayTeam.name;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (e) {
    const message = (e as Error).message;
    if (message === "PICKEM_UNKNOWN_MATCH") return { error: "Unknown match" };
    if (message === "PICKEM_INVALID_TEAM") {
      return { error: "Pick one of the two teams playing" };
    }
    if (message === "PICKEM_PHASE_LOCKED") {
      return { error: "Pick'em is not open in the league's current phase" };
    }
    if (message === "PICKEM_MATCH_LOCKED") {
      return { error: "Predictions are locked for this match" };
    }
    if (message === "PICKEM_STATE_CHANGED") {
      return {
        error:
          "The league state changed while you saved — reload before picking",
      };
    }
    if (
      (e as { code?: string }).code === "P2002" ||
      isSideGameTransactionConflict(e)
    ) {
      return {
        error:
          "The match or your pick changed at the same time — reload to confirm the current state",
      };
    }
    throw e;
  }

  revalidatePath("/pickem");
  return { message: `Locked in: ${name} to win` };
}
