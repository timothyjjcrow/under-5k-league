"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath, updateTag } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { str } from "@/lib/form";
import type { ActionResult } from "@/lib/action-result";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import {
  IMPORT_CANDIDATE_TTL_MS,
  loadImportSuppressions,
  readImportEvidence,
} from "@/lib/import-candidates";
import { raceHook } from "@/lib/race-hook";
import { actionErrorMessage, UserFacingError } from "@/lib/user-facing-error";

const OPEN_STATUSES = ["PENDING", "READY", "RETRYABLE", "NEEDS_REVIEW"];
const STALE_MESSAGE = "Import progress changed — reload and review it before trying again.";

async function changeImportCandidate(
  intent: "retry" | "ignore",
  formData: FormData,
): Promise<ActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }

  const candidateId = str(formData, "candidateId").trim();
  const seasonId = str(formData, "seasonId").trim();
  const rawRevision = str(formData, "expectedRevision");
  const expectedRevision = Number(rawRevision);
  if (
    !/^[A-Za-z0-9_-]{1,100}$/.test(candidateId) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(seasonId) ||
    !/^\d{1,10}$/.test(rawRevision) || !Number.isSafeInteger(expectedRevision)
  ) {
    return { error: "Invalid import-progress request — reload the admin page." };
  }
  const reason = str(formData, "reason").trim();
  if (intent === "ignore" && (!reason || reason.length > 300)) {
    return { error: "Give a reason for ignoring this game (1–300 characters)." };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const [active, candidate] = await Promise.all([
        tx.season.findMany({
          where: { isActive: true },
          take: 2,
          select: { id: true, status: true, updatedAt: true },
        }),
        tx.importCandidate.findUnique({ where: { id: candidateId } }),
      ]);
      if (active.length !== 1 || active[0].id !== seasonId || candidate?.seasonId !== seasonId) {
        throw new UserFacingError("This item is no longer in the current season — reload the admin page.");
      }
      // Do not let a parked admin form replace new provider progress or a
      // newer decision. No provider call happens in either command.
      if (candidate.revision !== expectedRevision) {
        throw new UserFacingError(STALE_MESSAGE);
      }
      await raceHook("importProgress.beforeClaim");
      // Lock the authoritative season without changing its settings revision.
      // This also makes an archive/phase transition contend on PostgreSQL;
      // SQLite serializes this guarded no-op write with its other writers.
      const seasonClaim = await tx.season.updateMany({
        where: { id: seasonId, isActive: true, status: active[0].status },
        data: { updatedAt: active[0].updatedAt },
      });
      if (seasonClaim.count !== 1) throw new UserFacingError(STALE_MESSAGE);

      if (intent === "retry" && (await loadImportSuppressions(seasonId, tx)).has(candidate.dotaMatchId)) {
        throw new UserFacingError(
          "This game was deliberately excluded. Retry cannot undo that decision; import a verified game ID from its match page if a correction is needed.",
        );
      }
      if (!OPEN_STATUSES.includes(candidate.status)) {
        throw new UserFacingError("This item is no longer waiting for review — reload the admin page.");
      }
      const recorded = await tx.dotaMatchClaim.findUnique({
        where: { dotaMatchId: candidate.dotaMatchId },
        select: { dotaMatchId: true },
      });
      if (recorded) {
        throw new UserFacingError("This game is already recorded. Use its match page for any result correction.");
      }

      const now = new Date();
      const savedDetails = intent === "retry"
        ? readImportEvidence(candidate.payload, candidate.dotaMatchId)
        : null;
      const changed = await tx.importCandidate.updateMany({
        where: {
          id: candidate.id,
          seasonId,
          revision: expectedRevision,
          status: candidate.status,
          attempts: candidate.attempts,
          payload: candidate.payload,
        },
        data: { ...(intent === "ignore" ? {
          status: "IGNORED",
          reason: "ADMIN_IGNORED",
          nextAttemptAt: null,
        } : {
          status: savedDetails ? "READY" : "PENDING",
          payload: savedDetails ? candidate.payload : null,
          fetchedAt: savedDetails ? candidate.fetchedAt : null,
          reason: null,
          attempts: 0,
          nextAttemptAt: null,
          expiresAt: new Date(now.getTime() + IMPORT_CANDIDATE_TTL_MS),
        }), revision: { increment: 1 } },
      });
      if (changed.count !== 1) throw new UserFacingError(STALE_MESSAGE);

      if (intent === "ignore") {
        await tx.importSuppression.upsert({
          where: { seasonId_dotaMatchId: { seasonId, dotaMatchId: candidate.dotaMatchId } },
          create: { seasonId, dotaMatchId: candidate.dotaMatchId, reason },
          // A prior exclusion keeps its original rationale; this command's
          // supplied reason still belongs in the required audit event below.
          update: {},
        });
      }
      // Unlike the optional best-effort activity helper, the actor/reason is
      // part of this durable correction and must roll back with a failed write.
      await raceHook("importProgress.beforeAudit");
      await tx.adminAction.create({
        data: {
          actorId: admin.id,
          actorName: admin.name,
          seasonId,
          action: intent === "ignore" ? "ignoreImportCandidate" : "retryImportCandidate",
          summary: intent === "ignore"
            ? `Excluded game ${candidate.dotaMatchId} from automatic import: ${reason}`
            : `Queued game ${candidate.dotaMatchId} for retry (${savedDetails ? "saved details retained" : "details required"})`,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    const code = error as { code?: string; meta?: { code?: string } };
    if (code.code === "P2034" || code.code === "P2002" || code.code === "P2025" ||
      (code.code === "P2010" && code.meta?.code === "40001")) {
      return { error: STALE_MESSAGE };
    }
    return {
      error: actionErrorMessage(error, "Could not update import progress. Reload and try again.", "IMPORT_PROGRESS_UPDATE_FAILED"),
    };
  }

  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/admin");
  revalidatePath("/admin/activity");
  return {
    message: intent === "ignore"
      ? "Game excluded from automatic import. The reason is saved in admin history."
      : "Retry queued. The next league sync will process this game; saved details are reused when available.",
  };
}

export async function retryImportCandidate(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return changeImportCandidate("retry", formData);
}

export async function ignoreImportCandidate(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return changeImportCandidate("ignore", formData);
}
