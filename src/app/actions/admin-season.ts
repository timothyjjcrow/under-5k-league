"use server";

// Admin actions for the season itself: create, archive, cancel, delete and
// reactivate it, move its phase, and save the settings forms on its card
// (name, MMR limit, draft settings, match night, series lengths, Valve league
// id). Also the site-wide "sign out all users" switch.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { raceHook } from "@/lib/race-hook";
import {
  archiveCompletedSeason,
  completedSeasonArchiveReadiness,
  getActiveSeason,
  reactivateSeason,
} from "@/lib/season";
import { unpinnedNewsNote } from "@/lib/news";
import { unpinNewsBeforeFinal } from "@/lib/news-rollover";
import {
  SEASON_STATUS,
  SEASON_PHASE_ORDER,
  DRAFT_STATUS,
  MATCH_STATUS,
  MATCH_PHASE,
  HARD_MMR_CEILING,
  type SeasonStatus,
} from "@/lib/constants";
import { ADMIN_PHASE_LABEL as PHASE_LABELS } from "@/lib/season-copy";
import {
  SERIES_LENGTH_PHASES,
  seriesLengthSyncNote,
  type SeriesLengths,
  type SeriesLengthSync,
} from "@/lib/series-lengths";
import {
  CARRIED_SEASON_SELECT,
  carriedSeasonSettings,
} from "@/lib/season-handoff";
import { draftSetupLockedMessage, draftSetupOpen } from "@/lib/draft-setup";
import { parseLeagueId } from "@/lib/dota";
import { clampInt, str } from "@/lib/form";
import { regularSeasonStartedMessage, sendDiscordMessage } from "@/lib/discord";
import { announceSignupsOpenOnce } from "@/lib/signups-open-announcement";
import { logAdminAction } from "@/lib/admin-log";
import { productionDeleteBackupError } from "@/lib/backup-receipt.mjs";
import { seasonSettingScopeWhere, stampResultChange } from "@/lib/settings";
import { bumpSessionEpoch } from "@/lib/session-epoch";
import type { ActionResult } from "@/lib/action-result";
import {
  recoverablePostseasonBracket,
  seasonPhasePolicy,
} from "@/lib/season-phase-policy";
import {
  isSerializationConflict,
  isUniqueViolation,
} from "@/lib/prisma-errors";
import {
  adminOrError,
  ActiveSeasonChangedError,
  DraftSetupLockedError,
  refresh,
  refreshGames,
} from "./admin-shared";

/**
 * Thrown from inside a `$transaction` callback when a precondition that was
 * checked OUTSIDE it has since stopped holding. These must be throws, never
 * returns: a resolved callback COMMITS, which would persist exactly the
 * destructive half the check exists to prevent.
 */
class SeasonBecameActiveError extends Error {}

class SeasonArchiveBlockedError extends Error {}

class MultipleActiveSeasonsError extends Error {}

type RenderedSeasonClaim = {
  season: NonNullable<Awaited<ReturnType<typeof getActiveSeason>>>;
  expectedId: string;
  expectedUpdatedAt: Date;
};

/**
 * Values in these settings forms were rendered from one specific season. A
 * second admin can complete/archive/reactivate the league before submission;
 * resolving "whatever is active now" would then copy stale values into a
 * different season. The id catches the normal switch and updatedAt catches a
 * switch-away-and-back or another intervening edit.
 */
async function renderedSeasonClaim(
  formData: FormData,
): Promise<RenderedSeasonClaim | { error: string }> {
  const expectedId = str(formData, "expectedActiveSeasonId").trim();
  const expectedUpdatedAt = new Date(
    str(formData, "expectedSeasonUpdatedAt").trim(),
  );
  const season = await getActiveSeason();
  if (
    !season ||
    !expectedId ||
    season.id !== expectedId ||
    !Number.isFinite(expectedUpdatedAt.getTime()) ||
    season.updatedAt.getTime() !== expectedUpdatedAt.getTime()
  ) {
    return {
      error:
        "The active season changed while this page was open — reload before saving season settings.",
    };
  }
  return { season, expectedId, expectedUpdatedAt };
}

async function updateRenderedSeason(
  claim: RenderedSeasonClaim,
  data: Prisma.SeasonUpdateManyMutationInput,
  db: Pick<Prisma.TransactionClient, "season"> = prisma,
): Promise<boolean> {
  // Test seam for the real stale-form race: the rendered claim can be fresh at
  // read time and become stale before this write. The updateMany predicate is
  // the protection; keeping the seam here (rather than in each caller) covers
  // every settings form that shares this helper. setSeriesLengths calls it
  // inside its transaction, where a rival write from this seam needs Postgres
  // (SQLite's single connection waits out the transaction timeout).
  await raceHook("admin.updateRenderedSeason.beforeWrite");
  const updated = await db.season.updateMany({
    where: {
      id: claim.expectedId,
      isActive: true,
      updatedAt: claim.expectedUpdatedAt,
    },
    data,
  });
  return updated.count === 1;
}

const staleSeasonSettingsError = {
  error:
    "The season changed before this setting could be saved — reload and review the current values.",
} as const;

/**
 * Create a fresh active season. An existing season is archived only after its
 * authoritative champion is complete; cancelling an unfinished league must
 * never be disguised as the ordinary next-season button.
 */
export async function createSeason(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const name = str(formData, "name").trim().slice(0, 60);
  if (!name) return { error: "Enter a season name" };
  // This is the active season the admin was looking at when the form rendered.
  // Requiring it turns a duplicated/replayed POST into a harmless refusal: the
  // first request changes the active id, so the stale second request cannot
  // archive the season it just created and open another copy.
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  // Every other setting is CARRIED from the season before (read inside the
  // transaction below), never posted: the handoff form states them in one
  // line and the new season's phase card changes them. Series lengths and the
  // league id used to reset silently to the defaults here.

  // SERIALIZABLE, matching the same zero-or-one-active invariant enforced by
  // offseason-only `reactivateSeason` (season.ts). Production's partial unique
  // index is the final database barrier. The transaction still matters: it
  // turns the whole archive-and-create handoff into one coherent claim, while
  // the index prevents a second active row even if an unexpected caller skips
  // this service.
  let handoff: {
    newSeasonId: string;
    archivedSeason: { id: string; name: string } | null;
  };
  try {
    handoff = await prisma.$transaction(
      async (tx) => {
        const activeRows = await tx.season.findMany({
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 2,
        });
        if (activeRows.length > 1) throw new MultipleActiveSeasonsError();
        const active = activeRows[0] ?? null;
        if ((active?.id ?? "") !== expectedActiveSeasonId) {
          throw new ActiveSeasonChangedError();
        }
        // The season this one follows, whose settings it carries: the one
        // being closed, or from the offseason the most recent archived season
        // (the same row the handoff form described).
        const previous =
          active ??
          (await tx.season.findFirst({
            where: { isActive: false },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: CARRIED_SEASON_SELECT,
          }));
        if (active) {
          const [matches, teams] = await Promise.all([
            tx.match.findMany({
              where: { seasonId: active.id },
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
              where: { seasonId: active.id },
              select: { id: true },
            }),
          ]);
          const readiness = completedSeasonArchiveReadiness(
            active,
            matches,
            teams.map((team) => team.id),
          );
          if (!readiness.ready) {
            throw new SeasonArchiveBlockedError(readiness.reason);
          }
        }
        await tx.season.updateMany({
          where: { isActive: true },
          data: { isActive: false },
        });
        const created = await tx.season.create({
          data: {
            name,
            ...carriedSeasonSettings(previous),
            status: SEASON_STATUS.SIGNUPS,
            isActive: true,
          },
          select: { id: true },
        });
        await stampResultChange(tx);
        return {
          newSeasonId: created.id,
          archivedSeason: active ? { id: active.id, name: active.name } : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof SeasonArchiveBlockedError) {
      return { error: error.message };
    }
    if (error instanceof MultipleActiveSeasonsError) {
      return {
        error:
          "More than one season is marked active. Resolve that data integrity issue before opening another season.",
      };
    }
    if (
      error instanceof ActiveSeasonChangedError ||
      isSerializationConflict(error) ||
      isUniqueViolation(error)
    ) {
      return {
        error:
          "The active season changed while this form was open — reload before creating another season.",
      };
    }
    throw error;
  }
  if (handoff.archivedSeason) {
    await logAdminAction({
      action: "archiveSeasonForHandoff",
      summary: `Archived completed season "${handoff.archivedSeason.name}" before opening "${name}"`,
      seasonId: handoff.archivedSeason.id,
    });
  }
  // Last season's pinned posts ("Grand final this Sunday") would otherwise sit
  // under the new season's signup hero until someone remembered them. After
  // the handoff has committed and best effort: the new season is open either
  // way, and the toast names what was unpinned so it can be pinned again.
  let unpinned: string[] = [];
  try {
    const previousSeasonId =
      handoff.archivedSeason?.id ??
      (
        await prisma.season.findFirst({
          where: { isActive: false },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true },
        })
      )?.id;
    if (previousSeasonId) {
      unpinned = await unpinNewsBeforeFinal(previousSeasonId);
    }
  } catch (error) {
    console.error("createSeason: could not unpin last season's news", error);
  }
  await logAdminAction({
    action: "createSeason",
    summary:
      (handoff.archivedSeason
        ? `Created "${name}" after closing "${handoff.archivedSeason.name}"`
        : `Created "${name}" from the offseason`) +
      (unpinned.length > 0
        ? `; unpinned ${unpinned.length} news post${unpinned.length === 1 ? "" : "s"} from before last season's final`
        : ""),
    seasonId: handoff.newSeasonId,
  });
  // Post-commit and best-effort: the season exists whatever Discord says.
  try {
    await announceSignupsOpenOnce(handoff.newSeasonId);
  } catch {
    console.error("[admin] SIGNUPS_OPEN_ANNOUNCEMENT_FAILED");
  }
  refresh();
  const note = unpinnedNewsNote(unpinned);
  return { message: note ? `Created ${name}. ${note}` : `Created ${name}` };
}

/** Close a valid completed season without immediately opening signups. */
export async function archiveCompletedSeasonAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const result = await archiveCompletedSeason(
    str(formData, "expectedActiveSeasonId").trim(),
  );
  if (!result.ok) return { error: result.error };
  await logAdminAction({
    action: "archiveCompletedSeason",
    summary: `Closed completed season "${result.name}" and entered the offseason`,
    seasonId: result.id,
  });
  refresh();
  return {
    message: `${result.name} is safely archived — the league is now in the offseason`,
  };
}

/**
 * Explicitly cancel an unfinished season into the offseason. This preserves
 * the old capability that Create season used to hide inside its normal path,
 * but makes the impact a separate, named, reversible command.
 */
export async function archiveIncompleteSeasonAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const expectedId = str(formData, "expectedActiveSeasonId").trim();
  const expectedUpdatedAt = new Date(
    str(formData, "expectedSeasonUpdatedAt").trim(),
  );
  if (!expectedId || !Number.isFinite(expectedUpdatedAt.getTime())) {
    return {
      error:
        "This cancellation control is stale — reload before changing the league lifecycle.",
    };
  }
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const active = await tx.season.findMany({
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 2,
        });
        if (active.length > 1) return { kind: "multiple" as const };
        const season = active[0];
        if (
          !season ||
          season.id !== expectedId ||
          season.updatedAt.getTime() !== expectedUpdatedAt.getTime()
        ) {
          return { kind: "changed" as const };
        }
        if (season.status === SEASON_STATUS.COMPLETE) {
          return { kind: "complete" as const };
        }
        const archived = await tx.season.updateMany({
          where: {
            id: season.id,
            isActive: true,
            status: season.status,
            updatedAt: expectedUpdatedAt,
          },
          data: { isActive: false },
        });
        if (archived.count !== 1) return { kind: "changed" as const };
        // Cancelling a live Draft must park its clocks in the SAME lifecycle
        // transaction. Otherwise an already-open poll can sell the expired lot
        // after the season disappears, and reactivation would immediately
        // resolve deadlines that elapsed throughout the offseason. Preserve the
        // lot itself so an admin can review it, then Resume grants a fresh clock.
        const parkedDraft = await tx.draft.updateMany({
          where: {
            seasonId: season.id,
            // Touch PAUSED too. A concurrent Resume read the row's updatedAt;
            // this write invalidates that claim, while a Resume that wins first
            // flips to IN_PROGRESS and is parked by the same predicate.
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
        await stampResultChange(tx);
        return {
          kind: "archived" as const,
          id: season.id,
          name: season.name,
          status: season.status,
          draftParked: parkedDraft.count === 1,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if (result.kind === "multiple") {
      return {
        error:
          "More than one season is marked active. Resolve that data integrity issue before cancelling one.",
      };
    }
    if (result.kind === "changed") {
      return {
        error:
          "The active season changed while this cancellation was open — reload and review the current league.",
      };
    }
    if (result.kind === "complete") {
      return {
        error:
          "A Complete season is not a cancellation. Reconcile its champion, then use the normal Season handoff.",
      };
    }
    await logAdminAction({
      action: "archiveIncompleteSeason",
      summary: `Cancelled unfinished season "${result.name}" from ${result.status} and entered the offseason; all saved data was preserved${result.draftParked ? " and its live auction was paused" : ""}`,
      seasonId: result.id,
    });
    refresh();
    return {
      message: `${result.name} was cancelled and archived without deleting its saved data${result.draftParked ? "; its live auction is paused for review" : ""}`,
    };
  } catch (error) {
    if (isSerializationConflict(error)) {
      return {
        error:
          "The season changed while it was being cancelled — reload and try again.",
      };
    }
    throw error;
  }
}

/**
 * Permanently delete an archived season and everything under it (teams,
 * matches, registrations, draft history) — for test runs and misfires.
 * The active season can never be deleted.
 */
export async function deleteSeason(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const seasonId = str(formData, "seasonId");
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) return { error: "Unknown season" };
  if (str(formData, "confirmationName").trim() !== season.name.trim()) {
    return {
      error: `Type the exact season name, “${season.name}”, to confirm permanent deletion.`,
    };
  }
  const expectedUpdatedAt = new Date(
    str(formData, "expectedSeasonUpdatedAt").trim(),
  );
  if (!Number.isFinite(expectedUpdatedAt.getTime())) {
    return {
      error: "This delete confirmation is stale — reload and try again.",
    };
  }
  if (season.isActive) {
    return {
      error:
        "That's the active season — use Season handoff to enter the offseason first. An unfinished season requires explicit cancellation.",
    };
  }
  const backupError = productionDeleteBackupError(
    str(formData, "backupReceipt"),
    process.env,
  );
  if (backupError) {
    return {
      error: `${backupError} No season data was deleted.`,
    };
  }

  // Matches must go before teams (Match→Team is RESTRICT); the season delete
  // cascades to everything else. Operational markers live in the relationless
  // Setting table, so gather match ids and clean the complete shared scope.
  // The archived-ness that AUTHORIZED this delete is re-asserted at the write.
  // /seasons offers "Make active again" right beside Delete, so the gap between
  // the check above and a cascading delete of every team, registration, draft
  // and roster row is genuinely reachable — and there is no undo.
  // deleteMany-with-a-predicate, then a count check, then throw so the match
  // deletion rolls back too (a return would commit it).
  // Seam: the rival must COMMIT before this transaction's snapshot for the
  // predicate to see it (the leaveLeague rule) — which also makes the test
  // SQLite-runnable.
  await raceHook("admin.deleteSeason.beforeTx");
  try {
    await prisma.$transaction(async (tx) => {
      const matchIds = (
        await tx.match.findMany({
          where: { seasonId },
          select: { id: true },
        })
      ).map((match) => match.id);
      const claimedDotaIds = [
        ...(await tx.game.findMany({
          where: { match: { seasonId } },
          select: { dotaMatchId: true },
        })),
        ...(await tx.scrimGame.findMany({
          where: { scrim: { seasonId } },
          select: { dotaMatchId: true },
        })),
      ].map((game) => game.dotaMatchId);
      await tx.setting.deleteMany({
        where: seasonSettingScopeWhere(seasonId, matchIds),
      });
      if (claimedDotaIds.length > 0) {
        await tx.dotaMatchClaim.deleteMany({
          where: { dotaMatchId: { in: claimedDotaIds } },
        });
      }
      await tx.match.deleteMany({ where: { seasonId } });
      const gone = await tx.season.deleteMany({
        where: {
          id: seasonId,
          isActive: false,
          updatedAt: expectedUpdatedAt,
        },
      });
      if (gone.count === 0) throw new SeasonBecameActiveError();
      // The global public snapshot revision must survive the season cascade.
      await stampResultChange(tx);
    });
  } catch (e) {
    if (e instanceof SeasonBecameActiveError) {
      return {
        error:
          "That season was activated or changed after this confirmation opened — nothing was deleted. Reload and review it again.",
      };
    }
    throw e;
  }
  // Logged AFTER the delete but the row survives it — AdminAction has no
  // relation to Season (seasonId is a bare string), precisely so the record of
  // a deletion outlives the thing deleted. A cascading FK here would erase the
  // one line explaining where the season went.
  await logAdminAction({
    action: "deleteSeason",
    summary: `PERMANENTLY DELETED season "${season.name}" and all of its matches, games, rosters and registrations`,
    seasonId,
  });
  // Deleting a season cascades its Game rows. Bust both season-scoped and
  // all-time stat scans so Records, Compare, careers, and archived boards
  // cannot retain the deleted history until the TTL expires.
  refreshGames();
  return { message: `Deleted ${season.name} and all of its history` };
}

/** Restore an archived season after an admin deliberately enters offseason. */
export async function reactivateSeasonAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const res = await reactivateSeason(
    str(formData, "seasonId"),
    new Date(str(formData, "expectedTargetUpdatedAt").trim()),
  );
  if (!res.ok) return { error: res.error };
  await logAdminAction({
    action: "reactivateSeason",
    summary: `Reactivated archived season "${res.name}" from the offseason in ${res.status}; no other season was archived${res.draftParked ? " and its auction remained paused" : ""}`,
    seasonId: res.id,
  });
  refresh();
  return {
    message:
      res.status === SEASON_STATUS.COMPLETE
        ? `${res.name} is active again and remains Complete; use the dedicated correction controls if needed`
        : `${res.name} is active again in ${PHASE_LABELS[res.status as SeasonStatus] ?? res.status}${res.draftParked ? "; its auction remains paused for review" : ""}`,
  };
}

/**
 * The opening week as the season-start post lists it: the first week's
 * fixtures in kickoff order, and the teams with a bye. Read after the phase
 * commits, for the announcement only.
 */
async function seasonOpeningSlate(seasonId: string) {
  const [fixtures, teams] = await Promise.all([
    prisma.match.findMany({
      where: { seasonId, phase: MATCH_PHASE.REGULAR },
      orderBy: [{ week: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        week: true,
        scheduledAt: true,
        homeTeamId: true,
        awayTeamId: true,
        homeTeam: { select: { name: true } },
        awayTeam: { select: { name: true } },
      },
    }),
    prisma.team.findMany({
      where: { seasonId, withdrawn: false },
      orderBy: { draftOrder: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  if (fixtures.length === 0) return undefined;
  const week = fixtures[0].week;
  const opening = fixtures
    .filter((fixture) => fixture.week === week)
    .map((fixture, index) => ({ fixture, index }))
    // Kickoff order, untimed last, creation order within a kickoff.
    .sort(
      (a, b) =>
        (a.fixture.scheduledAt?.getTime() ?? Infinity) -
          (b.fixture.scheduledAt?.getTime() ?? Infinity) || a.index - b.index,
    )
    .map(({ fixture }) => fixture);
  const playing = new Set(
    opening.flatMap((fixture) => [fixture.homeTeamId, fixture.awayTeamId]),
  );
  return {
    week,
    fixtures: opening.map((fixture) => ({
      home: fixture.homeTeam.name,
      away: fixture.awayTeam.name,
      whenMs: fixture.scheduledAt?.getTime() ?? null,
    })),
    byes: teams.filter((team) => !playing.has(team.id)).map((team) => team.name),
  };
}

/** Apply a policy-approved, non-destructive phase handoff or recovery. */
export async function setSeasonPhase(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const target = str(formData, "phase") as SeasonStatus;
  if (!SEASON_PHASE_ORDER.includes(target)) return { error: "Invalid phase" };
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this phase control was open — reload before moving the league.",
    };
  }
  if (season.status === target) {
    return { error: `The season is already in ${PHASE_LABELS[target]}` };
  }
  const [
    draft,
    matchCount,
    regularMatchCount,
    playedResults,
    importedGames,
    postseasonMatches,
  ] = await Promise.all([
    prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true },
    }),
    prisma.match.count({ where: { seasonId: season.id } }),
    prisma.match.count({
      where: { seasonId: season.id, phase: MATCH_PHASE.REGULAR },
    }),
    prisma.match.count({
      where: { seasonId: season.id, status: MATCH_STATUS.COMPLETED },
    }),
    prisma.game.count({ where: { match: { seasonId: season.id } } }),
    prisma.match.findMany({
      where: {
        seasonId: season.id,
        phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
      },
      select: { phase: true, bracketSlot: true },
    }),
  ]);
  const transition = seasonPhasePolicy({
    current: season.status,
    target,
    draftStatus: draft?.status,
    matchCount,
    regularMatchCount,
    hasPlayedResult: playedResults > 0,
    hasImportedGame: importedGames > 0,
    postseasonMatchCount: postseasonMatches.length,
    postseasonBracketReady: recoverablePostseasonBracket(postseasonMatches),
    hasChampion: season.championTeamId != null,
  });
  if (!transition.available) return { error: transition.reason };
  // The decisive pass is transactional across Season + Draft. The outer reads
  // above provide fast, specific feedback; this pass re-judges every
  // load-bearing condition in one SERIALIZABLE snapshot. In particular it
  // pairs with undoLastSale's Season read, closing the write-skew where phase
  // advance and Undo could previously leave REGULAR_SEASON + IN_PROGRESS.
  await raceHook("admin.setSeasonPhase.beforeWrite");
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const [
          currentSeason,
          currentDraft,
          currentMatchCount,
          currentRegularCount,
          playedNow,
          gamesNow,
          postseasonNow,
        ] = await Promise.all([
          tx.season.findUnique({ where: { id: season.id } }),
          tx.draft.findUnique({
            where: { seasonId: season.id },
            select: { status: true },
          }),
          tx.match.count({ where: { seasonId: season.id } }),
          tx.match.count({
            where: { seasonId: season.id, phase: MATCH_PHASE.REGULAR },
          }),
          tx.match.count({
            where: {
              seasonId: season.id,
              status: MATCH_STATUS.COMPLETED,
            },
          }),
          tx.game.count({ where: { match: { seasonId: season.id } } }),
          tx.match.findMany({
            where: {
              seasonId: season.id,
              phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
            },
            select: { phase: true, bracketSlot: true },
          }),
        ]);
        if (
          !currentSeason?.isActive ||
          currentSeason.status !== season.status
        ) {
          return {
            error:
              "The season's phase just changed under you — reload and try again",
          };
        }
        const currentTransition = seasonPhasePolicy({
          current: currentSeason.status,
          target,
          draftStatus: currentDraft?.status,
          matchCount: currentMatchCount,
          regularMatchCount: currentRegularCount,
          hasPlayedResult: playedNow > 0,
          hasImportedGame: gamesNow > 0,
          postseasonMatchCount: postseasonNow.length,
          postseasonBracketReady: recoverablePostseasonBracket(postseasonNow),
          hasChampion: currentSeason.championTeamId != null,
        });
        if (!currentTransition.available) {
          return { error: currentTransition.reason };
        }
        const flipped = await tx.season.updateMany({
          where: {
            id: season.id,
            isActive: true,
            status: currentSeason.status,
          },
          data: { status: target },
        });
        if (flipped.count === 1) {
          await stampResultChange(tx);
        }
        return {
          error:
            flipped.count === 0
              ? "The season's phase just changed under you — reload and try again"
              : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if (result.error) return { error: result.error };
  } catch (error) {
    if (isSerializationConflict(error)) {
      return {
        error:
          "The season, auction, or results changed while you moved the phase — reload and try again.",
      };
    }
    throw error;
  }
  await logAdminAction({
    action: "setSeasonPhase",
    summary: `Season phase ${PHASE_LABELS[season.status as SeasonStatus]} → ${PHASE_LABELS[target]}`,
    seasonId: season.id,
  });
  let notificationWarning = "";
  if (
    season.status === SEASON_STATUS.DRAFT &&
    target === SEASON_STATUS.REGULAR_SEASON
  ) {
    // The phase has committed; a failed read only costs the post its list.
    const opening = await seasonOpeningSlate(season.id).catch(() => undefined);
    const sent = await sendDiscordMessage(
      regularSeasonStartedMessage(season.name, opening),
    );
    if (!sent) {
      notificationWarning =
        " — the phase changed, but the Discord announcement failed; post the schedule link manually";
    }
  }
  refresh();
  return {
    message: `Season moved to ${PHASE_LABELS[target]}${notificationWarning}`,
  };
}

/** Rename the active season — its name is the hero title on the home page. */
export async function renameSeason(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const claim = await renderedSeasonClaim(formData);
  if ("error" in claim) return claim;
  const name = str(formData, "name").trim().slice(0, 60);
  if (!name) return { error: "Enter a season name" };
  if (!(await updateRenderedSeason(claim, { name }))) {
    return staleSeasonSettingsError;
  }
  await logAdminAction({
    action: "renameSeason",
    summary: `Renamed season "${claim.season.name}" → "${name}"`,
    seasonId: claim.season.id,
  });
  refresh();
  return { message: `Season renamed to ${name}` };
}

/**
 * Break-glass: invalidate EVERY signed-in session (advances the session epoch).
 * Use if a token may have leaked / an account is compromised — everyone,
 * including the admin who ran it, must log in again. Normal logout is unchanged.
 */
export async function revokeAllSessions(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  await bumpSessionEpoch();
  await logAdminAction({
    action: "revokeAllSessions",
    summary: "Revoked every outstanding login session",
    actor: admin,
  });
  refresh();
  return {
    message: "Signed out all users — everyone must log in again.",
  };
}

/** Set the active season's soft MMR limit / review threshold (0 = none). */
export async function setMaxMmr(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const claim = await renderedSeasonClaim(formData);
  if ("error" in claim) return claim;
  const season = claim.season;
  const maxMmr = clampInt(
    formData,
    "maxMmr",
    season.maxMmr,
    0,
    HARD_MMR_CEILING,
  );
  if (!(await updateRenderedSeason(claim, { maxMmr }))) {
    return staleSeasonSettingsError;
  }
  await logAdminAction({
    action: "setMaxMmr",
    summary:
      maxMmr > 0
        ? `Set the soft MMR review threshold to ${maxMmr}`
        : "Cleared the soft MMR review threshold",
    seasonId: season.id,
  });
  refresh();
  return {
    message:
      maxMmr > 0
        ? `Soft MMR review limit set to ${maxMmr}`
        : "Soft MMR review limit cleared",
  };
}

/**
 * Edit the season's draft settings after creation.
 *
 * These were write-once at Create-season: the only way to change a team size
 * or budget you'd second-guessed was a NEW season, which orphans every
 * registration made so far. They only take effect at `startDraft` (budgets)
 * and during the auction (team size), so editing them before the draft is
 * safe; afterwards the numbers are baked into rosters and spend, so refuse.
 */
export async function setDraftSettings(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const claim = await renderedSeasonClaim(formData);
  if ("error" in claim) return claim;
  const season = claim.season;
  const expectedActiveSeasonId = claim.expectedId;
  const teamSize = clampInt(formData, "teamSize", season.teamSize, 2, 10);
  const minTeams = clampInt(formData, "minTeams", season.minTeams, 2, 32);
  const draftBudget = clampInt(
    formData,
    "draftBudget",
    season.draftBudget,
    10,
    100000,
  );
  const budgetMmrWeight = clampInt(
    formData,
    "budgetMmrWeight",
    season.budgetMmrWeight,
    0,
    50,
  );
  await raceHook("admin.setDraftSettings.beforeTx");
  try {
    await prisma.$transaction(
      async (tx) => {
        const [currentSeason, draft] = await Promise.all([
          tx.season.findUnique({
            where: { id: expectedActiveSeasonId },
            select: { isActive: true, status: true, updatedAt: true },
          }),
          tx.draft.findUnique({
            where: { seasonId: expectedActiveSeasonId },
            select: { status: true },
          }),
        ]);
        if (
          !currentSeason?.isActive ||
          currentSeason.updatedAt.getTime() !==
            claim.expectedUpdatedAt.getTime()
        ) {
          throw new ActiveSeasonChangedError();
        }
        if (!draftSetupOpen(currentSeason.status, draft?.status)) {
          throw new DraftSetupLockedError(
            draftSetupLockedMessage(currentSeason.status, draft?.status),
          );
        }
        const updated = await tx.season.updateMany({
          where: {
            id: expectedActiveSeasonId,
            isActive: true,
            status: currentSeason.status,
            updatedAt: claim.expectedUpdatedAt,
          },
          data: { teamSize, minTeams, draftBudget, budgetMmrWeight },
        });
        if (updated.count === 0) throw new ActiveSeasonChangedError();
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof DraftSetupLockedError) return { error: error.message };
    if (
      error instanceof ActiveSeasonChangedError ||
      isSerializationConflict(error)
    ) {
      return {
        error: "The season or draft just changed — reload and try again.",
      };
    }
    throw error;
  }
  await logAdminAction({
    action: "setDraftSettings",
    summary: `Set draft configuration to teams of ${teamSize}, target ${minTeams}, $${draftBudget}, MMR weight ${budgetMmrWeight}%`,
    seasonId: season.id,
  });
  refresh();
  return {
    message: `Draft settings saved · teams of ${teamSize}, $${draftBudget} budget`,
  };
}

/**
 * Set the best-of series lengths for regular / playoff / final matches. Regular
 * may be even (a Bo2 can draw 1-1); playoff & final are forced odd so they can't
 * tie. Each fixture carries its own length (copied when it is created), so the
 * save also moves every existing fixture of that phase that has not started
 * (see syncUnstartedSeriesLengths). Completed series, series under way and
 * fixtures past their kickoff keep theirs, and the toast names what it left.
 */
export async function setSeriesLengths(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const claim = await renderedSeasonClaim(formData);
  if ("error" in claim) return claim;
  const season = claim.season;
  const regularBestOf = clampInt(
    formData,
    "regularBestOf",
    season.regularBestOf,
    1,
    15,
  );
  let playoffBestOf = clampInt(
    formData,
    "playoffBestOf",
    season.playoffBestOf,
    1,
    15,
  );
  let finalBestOf = clampInt(
    formData,
    "finalBestOf",
    season.finalBestOf,
    1,
    15,
  );
  if (playoffBestOf % 2 === 0) playoffBestOf += 1;
  if (finalBestOf % 2 === 0) finalBestOf += 1;
  const lengths: SeriesLengths = { regularBestOf, playoffBestOf, finalBestOf };
  // One clock for every attempt: a fixture judged "not kicked off" is judged
  // against the moment the admin pressed Save.
  const now = new Date();
  // Test seam: another settings save landing between the rendered claim's
  // read and this transaction must refuse inside it, before any fixture moves.
  await raceHook("admin.setSeriesLengths.beforeTransaction");
  let syncs: SeriesLengthSync[] | null = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      // Serializable, because the bracket and the schedule create fixtures
      // from these settings in their own Serializable transactions: a round
      // built from the old length either commits first (and this sync moves
      // it) or conflicts. Result writers (recordResult, imports, withdrawals)
      // re-read bestOf and write the same Match row in Serializable
      // transactions, so a score judged against the old length cannot land on
      // the new one.
      syncs = await prisma.$transaction(
        async (tx) => {
          // The first write: a stale form may still refuse here without
          // leaving anything half-done.
          if (!(await updateRenderedSeason(claim, lengths, tx))) return null;
          return syncUnstartedSeriesLengths(
            tx,
            claim.expectedId,
            lengths,
            now,
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      break;
    } catch (error) {
      if (!isSerializationConflict(error)) throw error;
      // The worker's result scan touches fixture rows every minute; a fresh
      // attempt re-claims the rendered season, so a real change still refuses.
      if (attempt < 3) continue;
      return {
        error:
          "A match or the season changed while saving — reload and try again.",
      };
    }
  }
  if (!syncs) return staleSeasonSettingsError;
  const note = seriesLengthSyncNote(syncs);
  await logAdminAction({
    action: "setSeriesLengths",
    summary: `Set series lengths to regular Bo${regularBestOf}, playoffs Bo${playoffBestOf}, final Bo${finalBestOf}${note}`,
    seasonId: season.id,
  });
  refresh();
  return {
    message: `Series lengths saved · regular Bo${regularBestOf}, playoffs Bo${playoffBestOf}, final Bo${finalBestOf}${note}`,
  };
}

/**
 * Move every fixture of the season that has not started to its phase's saved
 * length. "Not started" is claimed in the WHERE: SCHEDULED, 0-0, no game, and
 * a kickoff still ahead (or unset). A fixture past its kickoff may have been
 * played with its games not imported yet (the feed reads 25 minutes after
 * kickoff, the roster fallback after three hours), and importing a Bo5's games
 * into a Bo3 stops at the first 2-0. Counts, afterwards, the unfinished
 * fixtures left at another length, so the admin is told about each.
 */
async function syncUnstartedSeriesLengths(
  tx: Prisma.TransactionClient,
  seasonId: string,
  lengths: SeriesLengths,
  now: Date,
): Promise<SeriesLengthSync[]> {
  const syncs: SeriesLengthSync[] = [];
  for (const { phase, field } of SERIES_LENGTH_PHASES) {
    const bestOf = lengths[field];
    const moved = await tx.match.updateMany({
      where: {
        seasonId,
        phase: phase,
        status: MATCH_STATUS.SCHEDULED,
        homeScore: 0,
        awayScore: 0,
        games: { none: {} },
        bestOf: { not: bestOf },
        OR: [{ scheduledAt: null }, { scheduledAt: { gt: now } }],
      },
      data: { bestOf },
    });
    const [left, kickedOff] = await Promise.all([
      tx.match.count({
        where: {
          seasonId,
          phase,
          status: { not: MATCH_STATUS.COMPLETED },
          bestOf: { not: bestOf },
        },
      }),
      tx.match.count({
        where: {
          seasonId,
          phase,
          status: MATCH_STATUS.SCHEDULED,
          homeScore: 0,
          awayScore: 0,
          games: { none: {} },
          bestOf: { not: bestOf },
          scheduledAt: { lte: now },
        },
      }),
    ]);
    syncs.push({
      phase,
      bestOf,
      updated: moved.count,
      underWay: left - kickedOff,
      kickedOff,
    });
  }
  return syncs;
}

/** Set (or clear) the season's Valve league id for in-client league games. */
export async function setLeagueId(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const claim = await renderedSeasonClaim(formData);
  if ("error" in claim) return claim;
  const value = str(formData, "dotaLeagueId").trim();
  // Empty means "clear it" — an explicit, useful action (it turns the league
  // feed off and hands auto-sync back to the per-match roster scan).
  if (!value) {
    if (!(await updateRenderedSeason(claim, { dotaLeagueId: null }))) {
      return staleSeasonSettingsError;
    }
    await logAdminAction({
      action: "setLeagueId",
      summary:
        "Cleared the Valve league id; automatic results returned to roster scans",
      seasonId: claim.season.id,
    });
    refresh();
    return { message: "League id cleared — results sync by roster scan again" };
  }
  // REFUSE rather than store junk. This action used to take the first digit run
  // of anything, and a truthy-but-wrong id silently disables all result import
  // (see parseLeagueId). Leaving the stored id alone is the safe failure.
  const leagueId = parseLeagueId(value);
  if (!leagueId) {
    return {
      error:
        "That doesn't look like a league id — paste the number from the league's page (at least 4 digits), not the whole URL.",
    };
  }
  if (!(await updateRenderedSeason(claim, { dotaLeagueId: leagueId }))) {
    return staleSeasonSettingsError;
  }
  await logAdminAction({
    action: "setLeagueId",
    summary: `Set the Valve league id to ${leagueId}`,
    seasonId: claim.season.id,
  });
  refresh();
  return { message: `League id set to ${leagueId}` };
}

/**
 * Set (or clear) the per-season weekly match slot shown before signup.
 * Empty clears it back to the app-wide default (MATCH_SCHEDULE.label).
 */
export async function setMatchSchedule(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const claim = await renderedSeasonClaim(formData);
  if ("error" in claim) return claim;
  const value = str(formData, "matchSchedule").trim().slice(0, 80);
  if (
    !(await updateRenderedSeason(claim, {
      matchSchedule: value || null,
    }))
  ) {
    return staleSeasonSettingsError;
  }
  await logAdminAction({
    action: "setMatchSchedule",
    summary: value
      ? `Set the published weekly match slot to "${value}"`
      : "Cleared the custom weekly match slot; the league default applies",
    seasonId: claim.season.id,
  });
  refresh();
  return {
    message: value
      ? `Match-night schedule saved: ${value}`
      : "Match-night schedule cleared — the league default now applies",
  };
}
