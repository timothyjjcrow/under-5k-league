import { cache } from "react";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import type { Season } from "@prisma/client";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";
import { resolveChampionPresentation } from "./champion-presentation";
import { stampResultChange } from "./settings";

/** Fail closed whenever the application-level active-season invariant drifts. */
export function singleActiveSeason<T>(active: readonly T[]): T | null {
  if (active.length > 1) {
    throw new Error(
      "DATA_INTEGRITY: more than one season is marked active; resolve this before serving league state.",
    );
  }
  return active[0] ?? null;
}

/**
 * The single active season (most recent that hasn't been archived).
 *
 * cache(): one read per render pass — the layout fetches it for nav gating
 * and nearly every page fetches it again. Outside a render dispatcher
 * (route handlers, server actions, services) cache() passes through, so
 * everything else reads fresh exactly as before.
 */
export const getActiveSeason = cache(async function getActiveSeason(): Promise<Season | null> {
  const active = await prisma.season.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
    take: 2,
  });
  return singleActiveSeason(active);
});

type ArchiveMatch = Parameters<typeof resolveChampionPresentation>[1][number];

export type CompletedSeasonArchiveReadiness =
  | { ready: true; championTeamId: string }
  | {
      ready: false;
      code:
        | "NOT_COMPLETE"
        | "MISSING_CHAMPION"
        | "INCONSISTENT_CHAMPION"
        | "UNKNOWN_CHAMPION";
      reason: string;
    };

/**
 * The single normal-path gate shared by the admin UI and both handoff writes.
 * A historical champion-only import remains valid, but its champion must still
 * be a team from this season. Once postseason rows exist, the completed FINAL
 * remains authoritative through resolveChampionPresentation.
 */
export function completedSeasonArchiveReadiness(
  season: Pick<Season, "status" | "championTeamId">,
  matches: ArchiveMatch[],
  seasonTeamIds: Iterable<string>,
): CompletedSeasonArchiveReadiness {
  if (season.status !== SEASON_STATUS.COMPLETE) {
    return {
      ready: false,
      code: "NOT_COMPLETE",
      reason:
        "Finish the current season before closing it. The normal handoff unlocks only after the grand final crowns an authoritative champion.",
    };
  }
  const champion = resolveChampionPresentation(season, matches);
  if (!champion.championTeamId) {
    return {
      ready: false,
      code:
        champion.issue === "inconsistent"
          ? "INCONSISTENT_CHAMPION"
          : "MISSING_CHAMPION",
      reason:
        champion.issue === "inconsistent"
          ? "The stored champion and completed grand final disagree. Correct the final before closing this season."
          : "This season is marked Complete without an authoritative champion. Finish or reconcile the grand final before closing it.",
    };
  }
  if (!new Set(seasonTeamIds).has(champion.championTeamId)) {
    return {
      ready: false,
      code: "UNKNOWN_CHAMPION",
      reason:
        "The recorded champion is not a team from this season. Correct the champion record before closing it.",
    };
  }
  return { ready: true, championTeamId: champion.championTeamId };
}

export type ArchiveCompletedSeasonResult =
  | { ok: true; id: string; name: string }
  | { ok: false; error: string };

class ActiveSeasonChangedError extends Error {}
class SeasonArchiveBlockedError extends Error {}
class MultipleActiveSeasonsError extends Error {}

/**
 * Intentionally enter the offseason without creating the next season.
 * Nothing competitive is deleted or rewritten; the completed season simply
 * stops being the active league. The expected id makes a parked admin tab a
 * harmless refusal instead of a global lifecycle switch.
 */
export async function archiveCompletedSeason(
  expectedActiveSeasonId: string,
): Promise<ArchiveCompletedSeasonResult> {
  if (!expectedActiveSeasonId) {
    return { ok: false, error: "No active season was specified" };
  }
  try {
    return await prisma.$transaction(
      async (tx) => {
        const active = await tx.season.findMany({
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 2,
        });
        if (active.length > 1) throw new MultipleActiveSeasonsError();
        const season = active[0];
        if (!season || season.id !== expectedActiveSeasonId) {
          throw new ActiveSeasonChangedError();
        }
        const [matches, teams] = await Promise.all([
          tx.match.findMany({
            where: { seasonId: season.id },
            select: {
              id: true,
              phase: true,
              bracketSlot: true,
              status: true,
              winnerTeamId: true,
              homeTeamId: true,
              awayTeamId: true,
            },
          }),
          tx.team.findMany({
            where: { seasonId: season.id },
            select: { id: true },
          }),
        ]);
        const readiness = completedSeasonArchiveReadiness(
          season,
          matches,
          teams.map((team) => team.id),
        );
        if (!readiness.ready) {
          throw new SeasonArchiveBlockedError(readiness.reason);
        }
        const archived = await tx.season.updateMany({
          where: {
            id: season.id,
            isActive: true,
            status: SEASON_STATUS.COMPLETE,
            championTeamId: readiness.championTeamId,
          },
          data: { isActive: false },
        });
        if (archived.count !== 1) throw new ActiveSeasonChangedError();
        await stampResultChange(tx);
        return { ok: true as const, id: season.id, name: season.name };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof SeasonArchiveBlockedError) {
      return { ok: false, error: error.message };
    }
    if (error instanceof MultipleActiveSeasonsError) {
      return {
        ok: false,
        error:
          "More than one season is marked active. Resolve that data integrity issue before closing the league.",
      };
    }
    if (
      error instanceof ActiveSeasonChangedError ||
      (error as { code?: string }).code === "P2034"
    ) {
      return {
        ok: false,
        error:
          "The active season or its final changed while this control was open — reload before closing the league.",
      };
    }
    throw error;
  }
}

export type ReactivateResult =
  | {
      ok: true;
      id: string;
      name: string;
      status: string;
      draftParked: boolean;
    }
  | { ok: false; error: string };

/**
 * Make an archived season active again from the offseason. Reactivation used
 * to archive whatever season happened to be current, which was a second,
 * one-click path around the explicit incomplete-season cancellation workflow.
 * Requiring zero active seasons keeps the operator sequence deliberate:
 * complete/archive or cancel first, then select the historical season to
 * restore. Guards live here, service-style, so direct requests cannot bypass
 * the history-page presentation.
 */
export async function reactivateSeason(
  seasonId: string,
  expectedTargetUpdatedAt: Date,
): Promise<ReactivateResult> {
  if (!Number.isFinite(expectedTargetUpdatedAt.getTime())) {
    return {
      ok: false,
      error: "This season history control is stale — reload before switching.",
    };
  }
  // SERIALIZABLE keeps the read-then-activate flow coherent. Production also
  // has a partial unique index as the final "at most one active season"
  // barrier; depending on the interleaving, a competing activation can lose as
  // P2034 (serialization) or P2002 (unique conflict).
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const [target, active] = await Promise.all([
          tx.season.findUnique({ where: { id: seasonId } }),
          tx.season.findMany({
            where: { isActive: true },
            orderBy: { createdAt: "desc" },
            take: 2,
            select: { id: true },
          }),
        ]);
        if (active.length > 1) return { kind: "multiple-active" as const };
        if (!target) return { kind: "unknown" as const };
        if (target.isActive) return { kind: "already-active" as const };
        if (target.updatedAt.getTime() !== expectedTargetUpdatedAt.getTime()) {
          return { kind: "target-changed" as const };
        }
        if (active.length === 1) {
          return { kind: "offseason-required" as const };
        }
        // Old archives may predate cancellation's clock parking. Never revive
        // an IN_PROGRESS auction with deadlines that elapsed for days or weeks;
        // preserve its live lot and let an admin explicitly Resume with a fresh
        // clock after reviewing the restored season.
        const parkedDraft = await tx.draft.updateMany({
          where: {
            seasonId,
            status: {
              in: [DRAFT_STATUS.IN_PROGRESS, DRAFT_STATUS.PAUSED],
            },
          },
          data: {
            status: DRAFT_STATUS.PAUSED,
            bidEndsAt: null,
            nominationEndsAt: null,
          },
        });
        const activated = await tx.season.updateMany({
          where: {
            id: seasonId,
            isActive: false,
            updatedAt: expectedTargetUpdatedAt,
          },
          data: { isActive: true },
        });
        if (activated.count !== 1) {
          throw new ActiveSeasonChangedError();
        }
        await stampResultChange(tx);
        return {
          kind: "activated" as const,
          id: target.id,
          name: target.name,
          status: target.status,
          draftParked: parkedDraft.count === 1,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if (result.kind === "unknown") {
      return { ok: false, error: "Unknown season" };
    }
    if (result.kind === "already-active") {
      return { ok: false, error: "That season is already the active one" };
    }
    if (result.kind === "target-changed") {
      return {
        ok: false,
        error:
          "That archived season changed after this page loaded — reload and review it before making it active.",
      };
    }
    if (result.kind === "multiple-active") {
      return {
        ok: false,
        error:
          "More than one season is marked active. Resolve that data integrity issue before switching seasons.",
      };
    }
    if (result.kind === "offseason-required") {
      return {
        ok: false,
        error:
          "Enter the offseason before reactivating an archived season. Close a completed season or explicitly cancel the active unfinished season from Admin first.",
      };
    }
    return {
      ok: true,
      id: result.id,
      name: result.name,
      status: result.status,
      draftParked: result.draftParked,
    };
  } catch (e) {
    if (
      e instanceof ActiveSeasonChangedError ||
      (e as { code?: string }).code === "P2034" ||
      (e as { code?: string }).code === "P2002" ||
      (e as { code?: string }).code === "P2025"
    ) {
      return {
        ok: false,
        error: "The season lifecycle just changed — reload before reactivating.",
      };
    }
    throw e;
  }
}
