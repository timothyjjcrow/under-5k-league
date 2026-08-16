"use server";

import { revalidatePath, updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { raceHook } from "@/lib/race-hook";
import { requireAdmin } from "@/lib/auth";
import {
  archiveCompletedSeason,
  completedSeasonArchiveReadiness,
  getActiveSeason,
  reactivateSeason,
  singleActiveSeason,
} from "@/lib/season";
import {
  assignStandinGuarded,
  clashesAfterRetime,
  removeStandinGuarded,
} from "@/lib/standin-service";
import {
  SEASON_STATUS,
  SEASON_PHASE_ORDER,
  REGISTRATION_TYPE,
  REGISTRATION_STATUS,
  DRAFT_STATUS,
  MATCH_STATUS,
  MATCH_PHASE,
  DEFAULTS,
  HARD_MMR_CEILING,
  type SeasonStatus,
} from "@/lib/constants";
import {
  roundRobin,
  matchNightForWeek,
  slotRound,
  hasLaterBracketRound,
} from "@/lib/schedule";
import { playedSeriesFinalError, seriesScoreError } from "@/lib/standings";
import { matchResultsOpen } from "@/lib/league-lifecycle";
import { parseSeatTarget, pendingCoverWhere } from "@/lib/standin";
import { ADMIN_PHASE_LABEL as PHASE_LABELS } from "@/lib/season-copy";
import { mmrWeightedBudgets, shuffle } from "@/lib/draft";
import {
  captainTransferOpen,
  draftSeatPlan,
  draftSetupLockedMessage,
  draftSetupOpen,
} from "@/lib/draft-setup";
import { clampMmrToRank, formatMmrRange, rankMedalName } from "@/lib/rank";
import {
  abortDraft,
  pauseDraft,
  resumeDraft,
  undoLastSale,
  voidCurrentLot,
} from "@/lib/draft-service";
import {
  createPlayoffBracket,
  advancePlayoffBracket,
  returnToRegularSeason,
} from "@/lib/playoff-service";
import { actionErrorMessage } from "@/lib/user-facing-error";
import {
  regularSeasonStatus,
  pendingResultsMessage,
} from "@/lib/schedule-status";
import {
  importGameForMatch,
  autoDetectGamesForMatch,
  announceSeriesResultOnce,
  deriveSeriesProjection,
  syncLeagueGames,
  enrichStoredGames,
  rememberImportSkip,
} from "@/lib/match-import";
import {
  parseMatchId,
  parseLeagueId,
  fetchPubStats,
  fetchRankTier,
} from "@/lib/dota";
import {
  dotaAccountLinkSnapshot,
  effectiveDotaAccountId,
} from "@/lib/dota-account";
import { pubStatsFresh } from "@/lib/pub-stats";
import { fetchSteamProfiles } from "@/lib/steam";
import { bool, clampInt, localDate, str } from "@/lib/form";
import {
  draftStartedMessage,
  regularSeasonStartedMessage,
  draftAbortedMessage,
  draftLotVoidedMessage,
  draftPausedMessage,
  draftResumedMessage,
  draftSaleUndoneMessage,
  freeAgentSignedMessage,
  playerReleasedMessage,
  teamWithdrewMessage,
  playoffsStartedMessage,
  playoffsReturnedToRegularMessage,
  standinRemovedMessage,
  sendDiscordMessage,
  testMessage,
  draftCancelledMessage,
  draftRescheduledMessage,
  draftScheduledMessage,
  captainAssignedMessage,
  webhookIdOf,
  getInhouseWebhookUrl,
  getInhouseAlertWebhookUrl,
  sendInhouseDiscordMessage,
} from "@/lib/discord";
import { reachabilityNote } from "@/lib/discord-roles";
import { mentionsOf } from "@/lib/discord-mentions";
import { logAdminAction } from "@/lib/admin-log";
import { productionDeleteBackupError } from "@/lib/backup-receipt.mjs";
import {
  createInhouseBoard,
  removeInhouseBoard,
} from "@/lib/inhouse-board-service";
import {
  championAnnouncedKey,
  getSetting,
  resultAnnouncedKey,
  seasonSettingScopeWhere,
  setSetting,
  stampResultChange,
  SETTING_KEYS,
  weekReminderKey,
  weekReminderPrefix,
} from "@/lib/settings";
import { bumpSessionEpoch } from "@/lib/session-epoch";
import {
  markWeekHonorsStale,
  maybeAnnounceWeekHonors,
} from "@/lib/honors-service";
import { invalidatePendingAnnouncementMarkers } from "@/lib/announcement-marker";
import {
  medalProvesIneligible,
  promoteGateError,
  withdrawGateError,
} from "@/lib/registration";
import type { ActionResult } from "@/lib/action-result";
import { postAuctionWorkOpen } from "@/lib/league-lifecycle";
import {
  recoverablePostseasonBracket,
  seasonPhasePolicy,
} from "@/lib/season-phase-policy";
import { teamWithdrawalLockedReason } from "@/lib/team-withdrawal";
import { normalizeDiscordWebhookUrl } from "@/lib/discord-webhook.mjs";
import { normalizeTeamLogoUrl } from "@/lib/team-logo";

/**
 * Thrown from inside a `$transaction` callback when a precondition that was
 * checked OUTSIDE it has since stopped holding. These must be throws, never
 * returns: a resolved callback COMMITS, which would persist exactly the
 * destructive half the check exists to prevent.
 */
class SeasonBecameActiveError extends Error {}
class ActiveSeasonChangedError extends Error {}
class SeasonArchiveBlockedError extends Error {}
class MultipleActiveSeasonsError extends Error {}
class SignupChangedError extends Error {}
class SignupReinstateLockedError extends Error {}
class SignupWithdrawalLockedError extends Error {}
class PostAuctionWorkLockedError extends Error {}
class TeamWithdrawalLifecycleChangedError extends Error {}
class TeamAlreadyWithdrawnError extends Error {}
class TeamNotWithdrawnError extends Error {}

/** Games the winner is credited in a forfeit: the series clinch number. Module
 *  scope on purpose — a local arrow declared just above a transaction becomes
 *  the "enclosing function" the mutation guard anchors its claim ids to. */
function forfeitScore(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}

/**
 * Claim the exact active Regular-season row before changing Team/Match state.
 * A read is insufficient: archive can write only Season while withdrawal
 * writes only its children, leaving no Serializable cycle. This conditional
 * write supplies the shared row lock and gives every competing lifecycle
 * command a total order. Touching updatedAt also invalidates other settings
 * forms rendered before this league-level ruling.
 */
async function claimTeamWithdrawalSeason(
  tx: Prisma.TransactionClient,
  seasonId: string,
): Promise<boolean> {
  const claimed = await tx.season.updateMany({
    where: {
      id: seasonId,
      isActive: true,
      status: SEASON_STATUS.REGULAR_SEASON,
    },
    data: { updatedAt: new Date() },
  });
  return claimed.count === 1;
}
class ResultsLandedError extends Error {}
class ScheduleNeedsTeamsError extends Error {}
class WithdrawnTeamsError extends Error {
  constructor(readonly teamNames: string[]) {
    super("Withdrawn teams cannot be scheduled");
  }
}
class ScheduleMatchChangedError extends Error {}
class ScheduledWeekEmptyError extends Error {}
class UnknownScheduleMatchError extends Error {}
class DraftAlreadyStartedError extends Error {}
class DraftSetupLockedError extends Error {}
class CaptainStateChangedError extends Error {}
class DraftOrderConflictError extends Error {}
class DraftStartPreflightError extends Error {}
class ResultWriteError extends Error {}
class ResultAlreadySavedError extends Error {}

const clearedDraftConfirmation = {
  draftConfirmedRevision: null,
  draftConfirmedAt: null,
  draftConfirmedFor: null,
} as const;

/**
 * Copy for "the season is COMPLETE, so a playoff result can't advance anything".
 *
 * Legacy data can still contain COMPLETE without a champion, while an ordinary
 * crowned season needs the dedicated grand-final correction path below.
 */
function seasonCompleteError(championTeamId: string | null): string {
  return championTeamId
    ? "The champion is already crowned — reopen the grand final or remove its incorrect imported game from the dedicated final controls"
    : "The season is marked Complete, so playoff results no longer advance the bracket. Move it back to Playoffs (phase control above), then record this result — no bracket rebuild needed.";
}

function refresh() {
  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/", "layout");
}

// Game imports/edits also invalidate the cached all-games stat scans
// (src/lib/cached-queries.ts, tagged "games") so leaders / meta / records /
// hall-of-fame / player profiles reflect the change immediately instead of
// after the 60s TTL. revalidatePath alone does NOT clear unstable_cache tags.
function refreshGames() {
  // Server Actions need read-your-own-writes semantics: updateTag expires the
  // entry immediately, while revalidateTag(..., "max") would deliberately
  // serve the first reader stale data and refresh in the background.
  updateTag("games");
  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/", "layout");
}

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
): Promise<boolean> {
  // Test seam for the real stale-form race: the rendered claim can be fresh at
  // read time and become stale before this write. The updateMany predicate is
  // the protection; keeping the seam here (rather than in each caller) covers
  // every settings form that shares this helper.
  await raceHook("admin.updateRenderedSeason.beforeWrite");
  const updated = await prisma.season.updateMany({
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
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const name = str(formData, "name").trim().slice(0, 60);
  if (!name) return { error: "Enter a season name" };
  // This is the active season the admin was looking at when the form rendered.
  // Requiring it turns a duplicated/replayed POST into a harmless refusal: the
  // first request changes the active id, so the stale second request cannot
  // archive the season it just created and open another copy.
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  const teamSize = clampInt(formData, "teamSize", 5, 2, 10);
  const minTeams = clampInt(formData, "minTeams", 4, 2, 32);
  const draftBudget = clampInt(formData, "draftBudget", 100, 10, 100000);
  const budgetMmrWeight = clampInt(formData, "budgetMmrWeight", 20, 0, 50);
  const maxMmr = clampInt(formData, "maxMmr", 0, 0, HARD_MMR_CEILING);

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
            teamSize,
            minTeams,
            draftBudget,
            budgetMmrWeight,
            maxMmr,
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
      (error as { code?: string }).code === "P2034" ||
      (error as { code?: string }).code === "P2002"
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
  await logAdminAction({
    action: "createSeason",
    summary: handoff.archivedSeason
      ? `Created "${name}" after closing "${handoff.archivedSeason.name}"`
      : `Created "${name}" from the offseason`,
    seasonId: handoff.newSeasonId,
  });
  refresh();
  return { message: `Created ${name}` };
}

/** Close a valid completed season without immediately opening signups. */
export async function archiveCompletedSeasonAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
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
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
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
    if ((error as { code?: string }).code === "P2034") {
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
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
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
      await tx.setting.deleteMany({
        where: seasonSettingScopeWhere(seasonId, matchIds),
      });
      await tx.match.deleteMany({ where: { seasonId } });
      const gone = await tx.season.deleteMany({
        where: {
          id: seasonId,
          isActive: false,
          updatedAt: expectedUpdatedAt,
        },
      });
      if (gone.count === 0) throw new SeasonBecameActiveError();
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
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
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

/** Apply a policy-approved, non-destructive phase handoff or recovery. */
export async function setSeasonPhase(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
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
  const [draft, matchCount, playedResults, importedGames, postseasonMatches] =
    await Promise.all([
      prisma.draft.findUnique({
        where: { seasonId: season.id },
        select: { status: true },
      }),
      prisma.match.count({ where: { seasonId: season.id } }),
      prisma.match.count({
        where: { seasonId: season.id, status: MATCH_STATUS.COMPLETED },
      }),
      prisma.game.count({ where: { match: { seasonId: season.id } } }),
      prisma.match.findMany({
        where: {
          seasonId: season.id,
          phase: { not: MATCH_PHASE.REGULAR },
        },
        select: { phase: true, bracketSlot: true },
      }),
    ]);
  const transition = seasonPhasePolicy({
    current: season.status,
    target,
    draftStatus: draft?.status,
    matchCount,
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
            where: {
              seasonId: season.id,
              status: MATCH_STATUS.COMPLETED,
            },
          }),
          tx.game.count({ where: { match: { seasonId: season.id } } }),
          tx.match.findMany({
            where: {
              seasonId: season.id,
              phase: { not: MATCH_PHASE.REGULAR },
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
          const changedAt = new Date().toISOString();
          await tx.setting.upsert({
            where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
            create: { key: SETTING_KEYS.RESULT_CHANGED_AT, value: changedAt },
            update: { value: changedAt },
          });
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
    if ((error as { code?: string }).code === "P2034") {
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
    const sent = await sendDiscordMessage(
      regularSeasonStartedMessage(season.name),
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
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
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

/** Designate a registered player as a team captain (creates their team). */
export async function addCaptain(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const userId = str(formData, "userId");
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  const season = await getActiveSeason();
  if (
    !season ||
    !expectedActiveSeasonId ||
    expectedActiveSeasonId !== season.id
  ) {
    return {
      error:
        "The active season changed while this page was open — reload before designating a captain.",
    };
  }

  await raceHook("admin.addCaptain.beforeTx");
  let added: { name: string; teamName: string; discordId: string | null };
  try {
    added = await prisma.$transaction(
      async (tx) => {
        const [currentSeason, draft, user, reg, existing, highest] =
          await Promise.all([
            tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
            tx.draft.findUnique({
              where: { seasonId: expectedActiveSeasonId },
              select: { status: true },
            }),
            tx.user.findUnique({ where: { id: userId } }),
            tx.registration.findUnique({
              where: {
                seasonId_userId: {
                  seasonId: expectedActiveSeasonId,
                  userId,
                },
              },
            }),
            tx.team.findUnique({
              where: {
                seasonId_captainId: {
                  seasonId: expectedActiveSeasonId,
                  captainId: userId,
                },
              },
            }),
            // NOT team.count(): a legacy gap must not reuse an occupied order.
            tx.team.findFirst({
              where: { seasonId: expectedActiveSeasonId },
              orderBy: { draftOrder: "desc" },
              select: { draftOrder: true },
            }),
          ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!draftSetupOpen(currentSeason.status, draft?.status)) {
          throw new DraftSetupLockedError(
            draftSetupLockedMessage(currentSeason.status, draft?.status),
          );
        }
        if (!user) throw new CaptainStateChangedError("Unknown user");
        if (
          !reg ||
          reg.status !== REGISTRATION_STATUS.ACTIVE ||
          reg.type !== REGISTRATION_TYPE.PLAYER
        ) {
          throw new CaptainStateChangedError(
            `${user.name} isn't an active player signup this season`,
          );
        }
        if (existing) {
          throw new CaptainStateChangedError(
            `${user.name} already captains a team`,
          );
        }

        const order = highest ? highest.draftOrder + 1 : 0;
        const teamName = `${user.name}'s Team`;
        const team = await tx.team.create({
          data: {
            seasonId: currentSeason.id,
            name: teamName,
            captainId: user.id,
            budget: currentSeason.draftBudget,
            draftOrder: order,
          },
        });
        await tx.teamMember.create({
          data: {
            seasonId: currentSeason.id,
            teamId: team.id,
            userId: user.id,
            isCaptain: true,
            price: 0,
          },
        });
        return { name: user.name, teamName, discordId: user.discordId };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof ActiveSeasonChangedError ||
      (error as { code?: string }).code === "P2034"
    ) {
      return {
        error:
          "The season or captain list just changed — reload and try again.",
      };
    }
    if (error instanceof DraftSetupLockedError) {
      return { error: error.message };
    }
    if (error instanceof CaptainStateChangedError) {
      return { error: error.message };
    }
    if ((error as { code?: string }).code === "P2002") {
      return {
        error:
          "That player was just designated as a captain — reload to see the team.",
      };
    }
    throw error;
  }
  await logAdminAction({
    action: "addCaptain",
    summary: `Designated ${added.name} as captain of "${added.teamName}"`,
    seasonId: season.id,
  });
  await sendDiscordMessage(
    captainAssignedMessage(added.name, added.teamName, added.discordId),
    mentionsOf([added.discordId]),
  );
  refresh();
  return { message: `${added.name} is now a captain` };
}

/** Undo captain designation (only allowed before the draft starts). */
export async function removeCaptain(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const teamId = str(formData, "teamId");
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this page was open — reload before removing a captain.",
    };
  }

  // Match→Team is RESTRICT (prisma/schema.prisma), so a bare team.delete throws
  // P2003 the moment a schedule exists — and because nothing caught it, the
  // error escaped the action and ActionForm rendered it as "Couldn't reach the
  // server", sending admins after a phantom network fault. Worse, it was a dead
  // end: regenerating the schedule just recreates matches for the same teams.
  // Removing a team invalidates the round robin anyway, so clear the fixtures
  // in the same transaction and tell the admin to regenerate.
  //
  // The RESULTS COUNTS below are what make that delete safe — NOT the draft
  // guard above, as this comment used to claim. That claim holds only while a
  // Draft row exists: `createSeason` never creates one, and legacy seasons may
  // already have reached REGULAR_SEASON without ever pressing Start draft (or
  // may be recovering from abortDraft, which leaves the draft NOT_STARTED).
  // The current phase policy blocks that new jump, but this destructive action
  // still has to defend old and repaired data. Removing a captain-only team ran a
  // season-wide match deleteMany — every Game, RSVP, prediction, standin
  // booking and reschedule record gone by cascade, with no undo. Same pair
  // generateSchedule and abortDraft check.
  // Seam: the rival is an auto-sync import completing a match between the
  // admin's click and the authoritative transaction below.
  await raceHook("admin.removeCaptain.beforeTx");
  let removed: {
    captainName: string;
    teamName: string;
    fixtures: number;
  };
  try {
    removed = await prisma.$transaction(
      async (tx) => {
        const [currentSeason, draft, team, playedNow, gamesNow, fixtures] =
          await Promise.all([
            tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
            tx.draft.findUnique({
              where: { seasonId: expectedActiveSeasonId },
              select: { status: true },
            }),
            tx.team.findUnique({
              where: { id: teamId },
              include: { members: true, captain: true },
            }),
            tx.match.count({
              where: {
                seasonId: expectedActiveSeasonId,
                status: MATCH_STATUS.COMPLETED,
              },
            }),
            tx.game.count({
              where: { match: { seasonId: expectedActiveSeasonId } },
            }),
            tx.match.count({
              where: {
                seasonId: expectedActiveSeasonId,
                OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
              },
            }),
          ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!draftSetupOpen(currentSeason.status, draft?.status)) {
          throw new DraftSetupLockedError(
            draftSetupLockedMessage(currentSeason.status, draft?.status),
          );
        }
        if (!team || team.seasonId !== currentSeason.id) {
          throw new CaptainStateChangedError("Unknown team");
        }
        if (team.members.some((m) => !m.isCaptain)) {
          throw new CaptainStateChangedError(
            `${team.name} already has players on its roster`,
          );
        }
        if (playedNow > 0 || gamesNow > 0) throw new ResultsLandedError();

        if (fixtures > 0) {
          await tx.match.deleteMany({ where: { seasonId: currentSeason.id } });
        }
        const gone = await tx.team.deleteMany({
          where: {
            id: team.id,
            seasonId: currentSeason.id,
            captainId: team.captainId,
          },
        });
        if (gone.count === 0) throw new CaptainStateChangedError();

        // Keep the visible rotation a contiguous 1..N after a removal. Legacy
        // gaps are harmless to the engine but look like a missing captain.
        const remaining = await tx.team.findMany({
          where: { seasonId: currentSeason.id },
          orderBy: { draftOrder: "asc" },
          select: { id: true },
        });
        await Promise.all(
          remaining.map((candidate, index) =>
            tx.team.updateMany({
              where: { id: candidate.id, seasonId: currentSeason.id },
              data: { draftOrder: index },
            }),
          ),
        );
        return {
          captainName: team.captain.name,
          teamName: team.name,
          fixtures,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof ResultsLandedError) {
      return {
        error:
          "A result landed while you were removing that team — nothing was changed. Reload and check the schedule.",
      };
    }
    if (e instanceof DraftSetupLockedError) return { error: e.message };
    if (e instanceof CaptainStateChangedError) {
      return {
        error:
          e.message ||
          "That team or captain just changed — reload before removing it.",
      };
    }
    if (
      e instanceof ActiveSeasonChangedError ||
      (e as { code?: string }).code === "P2034"
    ) {
      return {
        error:
          "The season, draft, or captain list just changed — reload and try again.",
      };
    }
    throw e;
  }
  await logAdminAction({
    action: "removeCaptain",
    summary:
      `Removed ${removed.captainName} as captain and deleted team "${removed.teamName}"` +
      (removed.fixtures
        ? " — the season's whole schedule was cleared with it"
        : ""),
    seasonId: season.id,
  });
  refresh();
  return {
    message: removed.fixtures
      ? `${removed.captainName} is no longer a captain — the schedule was cleared, regenerate it once captains are final`
      : `${removed.captainName} is no longer a captain`,
  };
}

/**
 * Hand a team's captaincy to one of its own rostered players.
 *
 * Before this existed, `Team.captainId` was written in exactly one place —
 * `addCaptain`'s team.create — and every exit was closed once the draft
 * started: removeCaptain and releasePlayer both refuse, and withdrawGateError
 * literally tells the admin to "replace the captain first", an operation the
 * codebase never implemented. A captain going inactive mid-season therefore
 * cost that team its self-serve reschedule/standin/result-reporting powers
 * AND left their roster seat permanently occupied (signFreeAgent counts it),
 * recoverable only by hand-editing the database.
 *
 * Deliberately narrow: promote an existing team member. The outgoing captain
 * stays on the roster as a normal player, which is what makes them releasable
 * afterwards — so "replace the captain, then free the seat" is now two
 * supported clicks.
 */
export async function transferCaptaincy(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };

  const teamId = str(formData, "teamId");
  const newCaptainUserId = str(formData, "newCaptainUserId");
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  const expectedCaptainUserId = str(formData, "expectedCaptainUserId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this page was open — reload before handing over captaincy.",
    };
  }
  if (!expectedCaptainUserId) {
    return { error: "Reload the team before handing over captaincy." };
  }

  await raceHook("admin.transferCaptaincy.beforeTx");
  let transferred: {
    teamName: string;
    incomingName: string;
    outgoingName: string;
    incomingDiscordId: string | null;
  };
  try {
    transferred = await prisma.$transaction(
      async (tx) => {
        const [currentSeason, draftRow, team, alreadyCaptains, incomingReg] =
          await Promise.all([
            tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
            tx.draft.findUnique({
              where: { seasonId: expectedActiveSeasonId },
              select: { status: true },
            }),
            tx.team.findUnique({
              where: { id: teamId },
              include: { members: { include: { user: true } }, captain: true },
            }),
            tx.team.findUnique({
              where: {
                seasonId_captainId: {
                  seasonId: expectedActiveSeasonId,
                  captainId: newCaptainUserId,
                },
              },
            }),
            tx.registration.findUnique({
              where: {
                seasonId_userId: {
                  seasonId: expectedActiveSeasonId,
                  userId: newCaptainUserId,
                },
              },
            }),
          ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!captainTransferOpen(currentSeason.status, draftRow?.status)) {
          if (currentSeason.status === SEASON_STATUS.COMPLETE) {
            throw new DraftSetupLockedError(
              "The season is complete — captaincy is historical and read-only.",
            );
          }
          throw new DraftSetupLockedError(
            draftRow?.status === DRAFT_STATUS.PAUSED
              ? "The auction is paused, not finished — resume and let it complete, or use Abort draft, before swapping captains."
              : "The auction is live — let it complete, or use Abort draft, before swapping captains.",
          );
        }
        if (!team || team.seasonId !== currentSeason.id) {
          throw new CaptainStateChangedError("Unknown team");
        }
        if (team.captainId !== expectedCaptainUserId) {
          throw new CaptainStateChangedError(
            `${team.name}'s captain already changed — reload before another handover.`,
          );
        }
        if (team.captainId === newCaptainUserId) {
          throw new CaptainStateChangedError(
            `${team.captain.name} already captains ${team.name}`,
          );
        }
        const incoming = team.members.find(
          (member) => member.userId === newCaptainUserId,
        );
        const outgoing = team.members.find(
          (member) => member.userId === expectedCaptainUserId,
        );
        if (!incoming) {
          throw new CaptainStateChangedError(
            "Pick someone who is still on that team's roster.",
          );
        }
        if (!outgoing || !outgoing.isCaptain) {
          throw new CaptainStateChangedError(
            "The current captain roster spot is inconsistent — reload and repair the roster before a handover.",
          );
        }
        if (
          !incomingReg ||
          incomingReg.status !== REGISTRATION_STATUS.ACTIVE ||
          incomingReg.type !== REGISTRATION_TYPE.PLAYER
        ) {
          throw new CaptainStateChangedError(
            `${incoming.user.name} is not an active full-player signup.`,
          );
        }
        if (alreadyCaptains) {
          throw new CaptainStateChangedError(
            `${incoming.user.name} already captains another team`,
          );
        }

        // Team.captainId is the authoritative CAS. Two stale handovers can both
        // read the old captain; only one may claim that exact old value.
        const claimed = await tx.team.updateMany({
          where: {
            id: team.id,
            seasonId: currentSeason.id,
            captainId: expectedCaptainUserId,
          },
          data: { captainId: newCaptainUserId },
        });
        if (claimed.count === 0) throw new CaptainStateChangedError();

        // Normalize the denormalized flags, repairing any legacy duplicate on
        // this team while the authoritative captain change is atomic.
        await tx.teamMember.updateMany({
          where: {
            teamId: team.id,
            seasonId: currentSeason.id,
            isCaptain: true,
          },
          data: { isCaptain: false },
        });
        const promoted = await tx.teamMember.updateMany({
          where: {
            id: incoming.id,
            teamId: team.id,
            seasonId: currentSeason.id,
            userId: newCaptainUserId,
            isCaptain: false,
          },
          data: { isCaptain: true },
        });
        if (promoted.count === 0) throw new CaptainStateChangedError();
        return {
          teamName: team.name,
          incomingName: incoming.user.name,
          outgoingName: team.captain.name,
          incomingDiscordId: incoming.user.discordId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof DraftSetupLockedError) {
      return { error: error.message };
    }
    if (error instanceof CaptainStateChangedError) {
      return {
        error:
          error.message ||
          "Captaincy changed while you were saving — reload and try again.",
      };
    }
    if (
      error instanceof ActiveSeasonChangedError ||
      (error as { code?: string }).code === "P2034"
    ) {
      return {
        error:
          "The season or roster changed while you were saving — reload and try again.",
      };
    }
    if ((error as { code?: string }).code === "P2002") {
      return {
        error:
          "That player was just made captain elsewhere — reload and try again.",
      };
    }
    throw error;
  }
  await logAdminAction({
    action: "transferCaptaincy",
    summary: `Transferred "${transferred.teamName}" from ${transferred.outgoingName} to ${transferred.incomingName}`,
    seasonId: season.id,
  });
  await sendDiscordMessage(
    captainAssignedMessage(
      transferred.incomingName,
      transferred.teamName,
      transferred.incomingDiscordId,
    ),
    mentionsOf([transferred.incomingDiscordId]),
  );
  refresh();
  return {
    message: `${transferred.incomingName} now captains ${transferred.teamName} (${transferred.outgoingName} stays on the roster)`,
  };
}

/** Update a team's public identity (captains can't edit it themselves). */
export async function renameTeam(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this page was open — reload before editing a team.",
    };
  }
  const teamId = str(formData, "teamId");
  const name = str(formData, "name").trim().slice(0, 60);
  if (!name) return { error: "Enter a team name" };
  const logo = formData.has("logoUrl")
    ? normalizeTeamLogoUrl(str(formData, "logoUrl"))
    : null;
  if (logo && "error" in logo) return logo;
  try {
    await prisma.$transaction(
      async (tx) => {
        const currentSeason = await tx.season.findUnique({
          where: { id: expectedActiveSeasonId },
          select: { isActive: true, status: true },
        });
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (currentSeason.status === SEASON_STATUS.COMPLETE) {
          throw new DraftSetupLockedError(
            "The season is complete — team details are historical and read-only.",
          );
        }
        const changed = await tx.team.updateMany({
          where: { id: teamId, seasonId: expectedActiveSeasonId },
          data: {
            name,
            ...(logo ? { logoUrl: logo.logoUrl } : {}),
          },
        });
        if (changed.count === 0) throw new CaptainStateChangedError();
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof DraftSetupLockedError) return { error: error.message };
    if (error instanceof CaptainStateChangedError)
      return { error: "Unknown team" };
    if (
      error instanceof ActiveSeasonChangedError ||
      (error as { code?: string }).code === "P2034"
    ) {
      return {
        error: "The season or team just changed — reload and try again.",
      };
    }
    throw error;
  }
  // The record-book cache embeds matchup team identity under the shared games
  // tag, so an edit must expire that dependency as well as the page shell.
  await logAdminAction({
    action: "renameTeam",
    summary: logo
      ? `Updated team ${teamId} identity to "${name}" (${logo.logoUrl ? "custom logo" : "generated crest"})`
      : `Renamed team ${teamId} to "${name}"`,
    seasonId: season.id,
  });
  refreshGames();
  return { message: `Saved ${name}` };
}

/**
 * Admin signup moderation — withdraw a bogus/duplicate/ghost signup so it stops
 * counting toward the draft threshold and skewing MMR-weighted budgets. A
 * captain or rostered player must be released/replaced first (withdrawGateError).
 */
export async function withdrawSignup(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.COMPLETE) {
    return {
      error:
        "The season is complete — registrations are historical and cannot be removed.",
    };
  }
  const registrationId = str(formData, "registrationId");
  const reg = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: { user: true },
  });
  if (!reg || reg.seasonId !== season.id) return { error: "Unknown signup" };

  const [captainTeam, membership, pendingAssignments] = await Promise.all([
    prisma.team.findUnique({
      where: {
        seasonId_captainId: { seasonId: season.id, captainId: reg.userId },
      },
    }),
    prisma.teamMember.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: reg.userId } },
    }),
    // Same hole as the self-serve path: removing a standin who still owes cover
    // leaves the covered team looking staffed by someone no longer in the league.
    prisma.standinAssignment.count({
      where: pendingCoverWhere(reg.userId, season.id),
    }),
  ]);
  const gate = withdrawGateError({
    status: reg.status,
    isCaptain: !!captainTeam,
    isRostered: !!membership,
    pendingAssignments,
  });
  if (gate) return { error: gate };

  // Never withdraw the player who is ON THE BLOCK: every room would render a
  // headless auction, and the expiring lot would charge a team for a
  // withdrawn player (the resolver also voids such lots, belt-and-braces).
  const draft = await prisma.draft.findUnique({
    where: { seasonId: season.id },
    select: { status: true, nominatedUserId: true },
  });
  if (
    draft &&
    (draft.status === DRAFT_STATUS.IN_PROGRESS ||
      draft.status === DRAFT_STATUS.PAUSED) &&
    draft.nominatedUserId === reg.userId
  ) {
    return {
      error: `${reg.user.name} is on the auction block right now — wait for the lot to settle.`,
    };
  }

  // SERIALIZABLE for the same reason as the self-serve path in
  // actions/registration.ts: the cover count above and this status write form a
  // write-skew pair with assignStandinGuarded (which reads the registration and
  // writes a StandinAssignment). Under read-committed a captain arranging cover
  // in that window and this removal both commit, leaving a REMOVED standin
  // holding live cover. Re-counting inside the transaction is what lets Postgres
  // see the cycle.
  // Test seam: the gap between the gate reads above and the transaction below
  // — fires BEFORE the tx (the leaveLeague placement) so the rival commits
  // before the snapshot and the test runs on SQLite too.
  await raceHook("admin.withdrawSignup.beforeTx");
  try {
    await prisma.$transaction(
      async (tx) => {
        const [currentSeason, live, currentDraft] = await Promise.all([
          tx.season.findUnique({
            where: { id: season.id },
            select: { isActive: true, status: true },
          }),
          tx.standinAssignment.count({
            where: pendingCoverWhere(reg.userId, season.id),
          }),
          tx.draft.findUnique({
            where: { seasonId: season.id },
            select: { status: true, nominatedUserId: true },
          }),
        ]);
        if (!currentSeason?.isActive) throw new SignupChangedError();
        if (currentSeason.status === SEASON_STATUS.COMPLETE) {
          throw new SignupWithdrawalLockedError();
        }
        if (live > 0) throw new Error("COVER_APPEARED");
        if (
          currentDraft &&
          (currentDraft.status === DRAFT_STATUS.IN_PROGRESS ||
            currentDraft.status === DRAFT_STATUS.PAUSED) &&
          currentDraft.nominatedUserId === reg.userId
        ) {
          throw new Error("ON_BLOCK");
        }
        // Re-check the roster seat too — leaveLeague's comment records that a
        // draft sale or free-agent signing in this gap "let a ROSTERED player
        // withdraw". TeamMember is a table this tx otherwise never reads, so
        // the Serializable pairing argued above cannot see that cycle without
        // this read.
        const seated = await tx.teamMember.findUnique({
          where: {
            seasonId_userId: { seasonId: season.id, userId: reg.userId },
          },
        });
        if (seated) {
          throw new Error(seated.isCaptain ? "IS_CAPTAIN" : "IS_ROSTERED");
        }
        // Status carried in the WHERE (rule 1): a blind update stamped
        // REMOVED over a concurrent self-withdrawal or reinstate.
        const claimed = await tx.registration.updateMany({
          where: { id: reg.id, status: REGISTRATION_STATUS.ACTIVE },
          data: {
            status: REGISTRATION_STATUS.REMOVED,
            ...clearedDraftConfirmation,
          },
        });
        if (claimed.count === 0) throw new Error("STATUS_CHANGED");
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof SignupWithdrawalLockedError) {
      return {
        error:
          "The season is complete — registrations are historical and cannot be removed.",
      };
    }
    if (e instanceof SignupChangedError) {
      return { error: "The active season changed — reload and try again." };
    }
    const msg = (e as Error).message;
    if (msg === "COVER_APPEARED")
      return {
        error: `${reg.user.name} was just assigned to stand in for an unplayed match — remove that assignment first.`,
      };
    if (msg === "ON_BLOCK")
      return {
        error: `${reg.user.name} is on the auction block right now — wait for the lot to settle.`,
      };
    if (msg === "IS_CAPTAIN")
      return {
        error: `${reg.user.name} captains a team — transfer the captaincy first.`,
      };
    if (msg === "IS_ROSTERED")
      return {
        error: `${reg.user.name} is on a roster — release them from the team first.`,
      };
    if (msg === "STATUS_CHANGED")
      return { error: "That signup just changed — reload and try again." };
    if ((e as { code?: string }).code === "P2034")
      return { error: "That signup just changed — reload and try again." };
    throw e;
  }
  await logAdminAction({
    action: "withdrawSignup",
    summary: `Removed ${reg.user.name}'s ${reg.type.toLowerCase()} signup`,
    seasonId: season.id,
  });
  refresh();
  return {
    message: `Removed ${reg.user.name}'s signup — they can't re-add themselves; use Reinstate to undo`,
  };
}

/**
 * Undo an admin removal, putting the signup back in the pool.
 *
 * Needed because `withdrawSignup` is now sticky (REMOVED blocks self-re-signup
 * — otherwise the player just reloaded /me and undid it). Without this, removal
 * would be irreversible, which is a worse bug than the one it fixes.
 */
export async function reinstateSignup(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.COMPLETE) {
    return {
      error:
        "The season is complete — registrations are historical and cannot be reinstated.",
    };
  }
  const registrationId = str(formData, "registrationId");
  const reg = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: { user: true },
  });
  if (!reg || reg.seasonId !== season.id) return { error: "Unknown signup" };
  if (reg.status === REGISTRATION_STATUS.ACTIVE) {
    return { error: `${reg.user.name} is already signed up` };
  }
  await raceHook("admin.reinstateSignup.beforeWrite");
  try {
    await prisma.$transaction(
      async (tx) => {
        const [currentSeason, currentReg] = await Promise.all([
          tx.season.findUnique({
            where: { id: season.id },
            select: { isActive: true, status: true },
          }),
          tx.registration.findUnique({
            where: { id: reg.id },
            select: { seasonId: true, status: true, type: true },
          }),
        ]);
        if (!currentSeason?.isActive || !currentReg) {
          throw new SignupChangedError();
        }
        if (currentSeason.status === SEASON_STATUS.COMPLETE) {
          throw new SignupReinstateLockedError("season-complete");
        }
        if (
          currentReg.seasonId !== season.id ||
          currentReg.status !== reg.status ||
          currentReg.type !== reg.type
        ) {
          throw new SignupChangedError();
        }
        if (currentReg.type === REGISTRATION_TYPE.PLAYER) {
          const draft = await tx.draft.findUnique({
            where: { seasonId: season.id },
            select: { status: true },
          });
          if (
            draft?.status === DRAFT_STATUS.IN_PROGRESS ||
            draft?.status === DRAFT_STATUS.PAUSED
          ) {
            throw new SignupReinstateLockedError("draft-live");
          }
        }
        const changed = await tx.registration.updateMany({
          where: {
            id: reg.id,
            seasonId: season.id,
            status: reg.status,
            type: reg.type,
          },
          data: {
            status: REGISTRATION_STATUS.ACTIVE,
            ...clearedDraftConfirmation,
          },
        });
        if (changed.count === 0) throw new SignupChangedError();
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof SignupReinstateLockedError) {
      return {
        error:
          error.message === "draft-live"
            ? "The live draft is using this player pool — wait until the auction finishes before reinstating this player."
            : "The season is complete — registrations are historical and cannot be reinstated.",
      };
    }
    if (
      error instanceof SignupChangedError ||
      (error as { code?: string }).code === "P2034"
    ) {
      return { error: "That signup just changed — reload and try again." };
    }
    throw error;
  }
  refresh();
  // Advisory only, never a gate (the operator's-call stance): the flag flow
  // is one-way — syncPlayerRanks names over-ceiling signups in ITS toast and
  // nothing warned when the same admin later reinstated one.
  const warn = medalProvesIneligible(reg.user.rankTier)
    ? ` ⚠️ their medal (${rankMedalName(reg.user.rankTier)}) is above the ${HARD_MMR_CEILING} ceiling — review before the draft.`
    : "";
  await logAdminAction({
    action: "reinstateSignup",
    summary: `Reinstated ${reg.user.name}'s ${reg.type.toLowerCase()} signup`,
    seasonId: season.id,
  });
  return { message: `${reg.user.name} is back in the pool${warn}` };
}

/**
 * Admin correction for a fat-fingered self-reported MMR — clamped 0..12000
 * (players set it on /me; admin can fix it without asking them to re-file).
 */
export async function setRegistrationMmr(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.COMPLETE) {
    return { error: "The season is complete — signup MMR is read-only." };
  }
  const registrationId = str(formData, "registrationId");
  const mmr = clampInt(formData, "mmr", 0, 0, 12000);
  const reg = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: { user: true },
  });
  if (!reg || reg.seasonId !== season.id) return { error: "Unknown signup" };
  if (reg.status !== REGISTRATION_STATUS.ACTIVE) {
    return {
      error: "That signup is not active — reinstate it before editing MMR.",
    };
  }
  await raceHook("admin.setRegistrationMmr.beforeWrite");
  try {
    await prisma.$transaction(
      async (tx) => {
        const [currentSeason, currentReg, draft] = await Promise.all([
          tx.season.findUnique({
            where: { id: season.id },
            select: { isActive: true, status: true },
          }),
          tx.registration.findUnique({
            where: { id: reg.id },
            select: { seasonId: true, status: true, type: true },
          }),
          tx.draft.findUnique({
            where: { seasonId: season.id },
            select: { status: true },
          }),
        ]);
        if (
          !currentSeason?.isActive ||
          currentSeason.status === SEASON_STATUS.COMPLETE ||
          !currentReg ||
          currentReg.seasonId !== season.id ||
          currentReg.status !== REGISTRATION_STATUS.ACTIVE ||
          currentReg.type !== reg.type
        ) {
          throw new SignupChangedError();
        }
        if (
          currentReg.type === REGISTRATION_TYPE.PLAYER &&
          (draft?.status === DRAFT_STATUS.IN_PROGRESS ||
            draft?.status === DRAFT_STATUS.PAUSED)
        ) {
          throw new DraftAlreadyStartedError();
        }
        const changed = await tx.registration.updateMany({
          where: {
            id: reg.id,
            seasonId: season.id,
            status: REGISTRATION_STATUS.ACTIVE,
            type: reg.type,
          },
          data: { mmr },
        });
        if (changed.count === 0) throw new SignupChangedError();
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof DraftAlreadyStartedError) {
      return {
        error:
          "The auction is live — full-player MMR is locked until it finishes.",
      };
    }
    if (
      error instanceof SignupChangedError ||
      (error as { code?: string }).code === "P2034"
    ) {
      return { error: "That signup just changed — reload and try again." };
    }
    throw error;
  }
  refresh();
  // The admin override is the escape hatch when the medal check is wrong
  // (stale medal, recalibration) — never clamped, but flag a mismatch so a
  // fat-fingered correction doesn't slip by unnoticed.
  const check = clampMmrToRank(mmr, reg.user.rankTier);
  const rangeNote =
    check.adjusted && check.range
      ? ` (heads up: their ${rankMedalName(reg.user.rankTier)} medal suggests ${formatMmrRange(check.range)})`
      : "";
  await logAdminAction({
    action: "setRegistrationMmr",
    summary: `Set ${reg.user.name}'s signup MMR to ${mmr}`,
    seasonId: season.id,
  });
  return { message: `${reg.user.name}'s MMR set to ${mmr}${rangeNote}` };
}

/** Randomize the nomination/draft order of teams. */
export async function randomizeDraftOrder(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this page was open — reload before changing the order.",
    };
  }
  await raceHook("admin.randomizeDraftOrder.beforeTx");
  let count = 0;
  try {
    count = await prisma.$transaction(
      async (tx) => {
        const [currentSeason, draft, teams] = await Promise.all([
          tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
          tx.draft.findUnique({
            where: { seasonId: expectedActiveSeasonId },
            select: { status: true },
          }),
          tx.team.findMany({ where: { seasonId: expectedActiveSeasonId } }),
        ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!draftSetupOpen(currentSeason.status, draft?.status)) {
          throw new DraftSetupLockedError(
            draftSetupLockedMessage(currentSeason.status, draft?.status),
          );
        }
        if (teams.length < 2) {
          throw new DraftStartPreflightError(
            "Designate at least 2 captains before randomizing their order.",
          );
        }
        const shuffled = shuffle(teams);
        const changed = await Promise.all(
          shuffled.map((team, index) =>
            tx.team.updateMany({
              where: {
                id: team.id,
                seasonId: currentSeason.id,
                draftOrder: team.draftOrder,
              },
              data: { draftOrder: index },
            }),
          ),
        );
        if (changed.some((result) => result.count === 0)) {
          throw new CaptainStateChangedError();
        }
        return teams.length;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof DraftSetupLockedError ||
      error instanceof DraftStartPreflightError
    ) {
      return { error: error.message };
    }
    if (error instanceof CaptainStateChangedError) {
      return {
        error: "The captain order just changed — reload and randomize again.",
      };
    }
    if (
      error instanceof ActiveSeasonChangedError ||
      (error as { code?: string }).code === "P2034"
    ) {
      return {
        error:
          "The season, draft, or captain order just changed — reload and try again.",
      };
    }
    throw error;
  }
  await logAdminAction({
    action: "randomizeDraftOrder",
    summary: `Randomized the draft order for ${count} teams`,
    seasonId: season.id,
  });
  refresh();
  return { message: "Draft order shuffled" };
}

/** Begin the live auction draft. Sets the season to DRAFT and seeds Draft state. */
export async function startDraft(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this page was open — reload and review the draft preflight before starting.",
    };
  }

  await raceHook("admin.startDraft.beforeTx");
  let started: {
    seasonName: string;
    budgets: Map<string, number>;
    poolCount: number;
    openSeats: number;
    shortfall: number;
  };
  try {
    started = await prisma.$transaction(
      async (tx) => {
        const [
          currentSeason,
          existingDraft,
          teams,
          regs,
          existingMembers,
          playedNow,
          gamesNow,
        ] = await Promise.all([
          tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
          tx.draft.findUnique({
            where: { seasonId: expectedActiveSeasonId },
            select: { status: true },
          }),
          tx.team.findMany({
            where: { seasonId: expectedActiveSeasonId },
            orderBy: [
              { draftOrder: "asc" },
              { createdAt: "asc" },
              { id: "asc" },
            ],
          }),
          tx.registration.findMany({
            where: {
              seasonId: expectedActiveSeasonId,
              status: REGISTRATION_STATUS.ACTIVE,
              type: REGISTRATION_TYPE.PLAYER,
            },
            select: { userId: true, mmr: true },
          }),
          tx.teamMember.findMany({
            where: { seasonId: expectedActiveSeasonId },
            select: { id: true, teamId: true, userId: true, isCaptain: true },
          }),
          tx.match.count({
            where: {
              seasonId: expectedActiveSeasonId,
              status: MATCH_STATUS.COMPLETED,
            },
          }),
          tx.game.count({
            where: { match: { seasonId: expectedActiveSeasonId } },
          }),
        ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!draftSetupOpen(currentSeason.status, existingDraft?.status)) {
          if (
            currentSeason.status === SEASON_STATUS.DRAFT &&
            existingDraft?.status !== DRAFT_STATUS.NOT_STARTED
          ) {
            throw new DraftAlreadyStartedError();
          }
          throw new DraftSetupLockedError(
            draftSetupLockedMessage(
              currentSeason.status,
              existingDraft?.status,
            ),
          );
        }
        if (playedNow > 0 || gamesNow > 0) throw new ResultsLandedError();
        if (teams.length < 2) {
          throw new DraftStartPreflightError(
            "Need at least 2 captains to start the draft.",
          );
        }
        if (
          new Set(teams.map((team) => team.draftOrder)).size !== teams.length
        ) {
          throw new DraftOrderConflictError();
        }

        const regByUser = new Map(regs.map((reg) => [reg.userId, reg]));
        for (const team of teams) {
          const captainSeats = existingMembers.filter(
            (member) => member.teamId === team.id && member.isCaptain,
          );
          if (
            captainSeats.length !== 1 ||
            captainSeats[0].userId !== team.captainId ||
            !regByUser.has(team.captainId)
          ) {
            throw new CaptainStateChangedError();
          }
        }
        const existingRosterCount = existingMembers.filter(
          (member) => !member.isCaptain,
        ).length;
        if (existingRosterCount > 0) {
          throw new DraftStartPreflightError(
            `${existingRosterCount} non-captain roster member${existingRosterCount === 1 ? " is" : "s are"} already assigned. Start requires captain-only teams so a later-season roster cannot be mistaken for a fresh auction.`,
          );
        }

        const draftedIds = new Set(
          existingMembers.map((member) => member.userId),
        );
        const poolCount = regs.filter(
          (reg) => !draftedIds.has(reg.userId),
        ).length;
        const seats = draftSeatPlan(
          teams.length,
          currentSeason.teamSize,
          poolCount,
        );
        if (!seats.canStart) {
          throw new DraftStartPreflightError(
            seats.blocker ?? "The draft is not ready to start.",
          );
        }

        const budgets = mmrWeightedBudgets(
          currentSeason.draftBudget,
          currentSeason.budgetMmrWeight,
          teams.map((team) => ({
            teamId: team.id,
            // A stored 0 is unknown, not a minimum-MMR budget boost.
            mmr: regByUser.get(team.captainId)?.mmr || null,
          })),
          (currentSeason.teamSize - 1) * DEFAULTS.MIN_BID,
        );
        const nominationEndsAt = new Date(
          Date.now() + DEFAULTS.NOMINATION_TIMER_SECONDS * 1000,
        );

        // The singleton Draft row is the one-shot claim. Every later failure
        // throws, rolling it back together with budgets and phase.
        if (existingDraft) {
          const claimed = await tx.draft.updateMany({
            where: {
              seasonId: currentSeason.id,
              status: DRAFT_STATUS.NOT_STARTED,
            },
            data: {
              status: DRAFT_STATUS.IN_PROGRESS,
              nominatorTeamId: teams[0].id,
              nominationIndex: 0,
              nominatedUserId: null,
              currentBid: 0,
              currentBidTeamId: null,
              bidEndsAt: null,
              nominationEndsAt,
            },
          });
          if (claimed.count === 0) throw new DraftAlreadyStartedError();
        } else {
          try {
            await tx.draft.create({
              data: {
                seasonId: currentSeason.id,
                status: DRAFT_STATUS.IN_PROGRESS,
                nominatorTeamId: teams[0].id,
                nominationIndex: 0,
                nominationEndsAt,
              },
            });
          } catch (error) {
            if ((error as { code?: string }).code === "P2002") {
              throw new DraftAlreadyStartedError();
            }
            throw error;
          }
        }

        const budgetWrites = await Promise.all(
          teams.map((team) =>
            tx.team.updateMany({
              where: {
                id: team.id,
                seasonId: currentSeason.id,
                captainId: team.captainId,
                draftOrder: team.draftOrder,
              },
              data: {
                budget: budgets.get(team.id) ?? currentSeason.draftBudget,
              },
            }),
          ),
        );
        if (budgetWrites.some((write) => write.count === 0)) {
          throw new CaptainStateChangedError();
        }
        const phaseClaim = await tx.season.updateMany({
          where: {
            id: currentSeason.id,
            isActive: true,
            status: currentSeason.status,
          },
          data: { status: SEASON_STATUS.DRAFT },
        });
        if (phaseClaim.count === 0) throw new ActiveSeasonChangedError();

        return {
          seasonName: currentSeason.name,
          budgets,
          poolCount,
          openSeats: seats.openSeats,
          shortfall: seats.shortfall,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof ResultsLandedError) {
      return {
        error:
          "A result landed while you were starting the draft — nothing was changed. Reload and check the schedule.",
      };
    }
    if (e instanceof DraftAlreadyStartedError) {
      return {
        error:
          "The draft has already run or another Start just beat this one — use Abort draft to return to Signups and re-run it (allowed until a result is recorded).",
      };
    }
    if (e instanceof DraftSetupLockedError) return { error: e.message };
    if (e instanceof DraftStartPreflightError) return { error: e.message };
    if (e instanceof DraftOrderConflictError) {
      return {
        error:
          "Two captains share the same draft order — randomize the order once, then start again.",
      };
    }
    if (e instanceof CaptainStateChangedError) {
      return {
        error:
          "Captain roster data changed or is inconsistent — reload and verify every team has exactly one designated captain.",
      };
    }
    if (
      e instanceof ActiveSeasonChangedError ||
      (e as { code?: string }).code === "P2034"
    ) {
      return {
        error:
          "The season, captain list, order, settings, or player pool changed while starting — nothing was armed. Reload and review the preflight.",
      };
    }
    if ((e as { code?: string }).code === "P2002") {
      return {
        error:
          "Another Start just beat this one — the draft is already live. Nothing was changed twice.",
      };
    }
    throw e;
  }
  await sendDiscordMessage(draftStartedMessage(started.seasonName));
  await logAdminAction({
    action: "startDraft",
    summary: `Started the live auction with ${started.budgets.size} teams and ${started.poolCount} draftable players`,
    seasonId: season.id,
  });
  refresh();
  const budgetVals = [...started.budgets.values()];
  const budgetNote =
    Math.max(...budgetVals) !== Math.min(...budgetVals)
      ? ` · MMR-weighted budgets $${Math.min(...budgetVals)}–$${Math.max(...budgetVals)}`
      : "";
  return {
    message:
      started.shortfall > 0
        ? `Draft started — heads up: ${started.poolCount} players for ${started.openSeats} seats, so ${started.shortfall} seat(s) will go unfilled${budgetNote}`
        : `Draft started — the auction is live${budgetNote}`,
  };
}

/** Admin: revert the most recent auction sale (mis-click / dispute recovery). */
export async function undoLastSaleAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let admin: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    admin = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this draft control was open — reload before undoing a sale.",
    };
  }
  // Draft phase only. Undo re-opens the auction (Draft.status → IN_PROGRESS)
  // and deletes the newest non-captain TeamMember — which, once the season has
  // moved on, is a free-agent signing, not an auction sale. Worse, a live
  // auction inside REGULAR_SEASON means the next visitor to /draft triggers
  // the stalled-nomination resolver and a random unrostered signup gets
  // auto-drafted onto that team mid-season. Roster fixes after the draft are
  // Release / Sign free agent.
  if (season.status !== SEASON_STATUS.DRAFT) {
    return {
      error:
        "The season has moved on — use Release / Sign free agent for roster corrections.",
    };
  }
  const res = await undoLastSale(season.id, admin);
  if (!res.ok) return { error: res.error };
  refresh();
  // Name the purchase. Undo targets the newest AUCTION sale, so when free-agent
  // signings sit on top of it the row reverted is not the newest roster addition
  // — saying who and for how much is what stops that being a surprise.
  await logAdminAction({
    action: "undoLastSale",
    summary: `Undid the sale of ${res.player} to ${res.team} ($${res.price})`,
    seasonId: season.id,
  });
  await sendDiscordMessage(
    draftSaleUndoneMessage(season.name, res.player, res.team, res.price),
  );
  // The durable send may have enqueued work after the earlier refresh. Expire
  // once more so a snapshot rebuilt during Discord I/O cannot miss the row.
  updateTag(AUTOMATION_GATE_TAG);
  return {
    message: `Undid ${res.player} → ${res.team} ($${res.price}) — they're back in the pool, ${res.team} has the money and the next nomination.${
      res.paused ? " The auction is still paused; press Resume when ready." : ""
    }`,
  };
}

/**
 * Admin: ABORT the draft — the way back from a premature "Start draft".
 *
 * Deliberately NOT phase-gated the way undoLastSaleAction is: the whole point is
 * to recover a season whose phase already moved, and abortDraft's own guard (no
 * recorded results, no imported games) is the safety line that matters. It puts
 * the season back to SIGNUPS so captains can be fixed and late players can
 * register.
 */
export async function abortDraftAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this draft control was open — reload before aborting.",
    };
  }
  const res = await abortDraft(season.id, admin);
  if (!res.ok) return { error: res.error };
  await logAdminAction({
    action: "abortDraft",
    summary: `Aborted the draft — ${res.playersReturned} non-captain roster member(s) returned, $${res.budgetRestored} refunded, ${res.matchesRemoved} unplayed fixture(s), ${res.checkInsCleared} check-in(s), ${res.predictionsCleared} pick(s), ${res.reschedulesCleared} reschedule(s) and ${res.fantasyRostersCleared} fantasy roster(s) cleared; ${res.teams} captain(s) kept`,
    seasonId: season.id,
  });
  // Stand down the standins whose bookings died with the rosters — post-commit
  // and best-effort, one per deleted booking (the generateSchedule shape). A
  // booking that survived into the re-run would inflate a freshly drafted
  // side to six; the human holding it deserves better than silence either way.
  for (const a of res.coverStandDowns) {
    await sendDiscordMessage(
      standinRemovedMessage({
        standinName: a.standinName,
        teamName: a.teamName,
        homeName: a.homeName,
        awayName: a.awayName,
        week: a.week,
        isPlayoff: a.isPlayoff,
      }),
      mentionsOf([a.discordId]),
    );
  }
  await sendDiscordMessage(
    draftAbortedMessage(season.name, res.playersReturned, res.matchesRemoved),
  );
  refresh();
  const bits = [
    `Draft aborted — season back to Signups with ${res.teams} captain(s) intact`,
  ];
  if (res.playersReturned > 0) {
    bits.push(
      `${res.playersReturned} non-captain roster member(s) returned to the pool and $${res.budgetRestored} refunded`,
    );
  }
  if (res.coverStandDowns.length > 0) {
    bits.push(
      `${res.coverStandDowns.length} standin booking(s) on the old rosters cancelled and stood down`,
    );
  }
  const cleared = [
    res.matchesRemoved ? `${res.matchesRemoved} unplayed fixture(s)` : null,
    res.checkInsCleared ? `${res.checkInsCleared} check-in(s)` : null,
    res.predictionsCleared ? `${res.predictionsCleared} pick'em pick(s)` : null,
    res.reschedulesCleared ? `${res.reschedulesCleared} reschedule(s)` : null,
    res.fantasyRostersCleared
      ? `${res.fantasyRostersCleared} fantasy roster(s)`
      : null,
  ].filter(Boolean);
  if (cleared.length > 0) {
    bits.push(`cleared ${cleared.join(", ")} tied to the old rosters`);
  }
  bits.push("fix the captains, then start the draft again");
  bits.push("Discord was notified that the auction stopped");
  return { message: `${bits.join(" · ")}.` };
}

/** Admin: pause the live auction (clocks park; nothing can sell). */
export async function pauseDraftAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this draft control was open — reload before pausing.",
    };
  }
  const res = await pauseDraft(season.id, admin);
  // pauseDraft may first resolve an expired auction clock even when its final
  // pause claim loses. Rebuild the deadline proof after every dispatched call.
  updateTag(AUTOMATION_GATE_TAG);
  if (!res.ok) return { error: res.error };
  await logAdminAction({
    action: "pauseDraft",
    summary: "Paused the live auction and parked its clock",
    seasonId: season.id,
  });
  await sendDiscordMessage(draftPausedMessage(season.name));
  refresh();
  return { message: "Auction paused — clocks are parked until you resume." };
}

/** Admin: resume a paused auction with a fresh clock. */
export async function resumeDraftAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this draft control was open — reload before resuming.",
    };
  }
  const res = await resumeDraft(season.id, admin);
  if (!res.ok) return { error: res.error };
  await logAdminAction({
    action: "resumeDraft",
    summary: "Resumed the auction with a fresh clock",
    seasonId: season.id,
  });
  await sendDiscordMessage(draftResumedMessage(season.name));
  refresh();
  return { message: "Auction resumed — the clock is running again." };
}

/** Admin: cancel a mistaken live lot after pausing, keeping the same turn. */
export async function voidCurrentLotAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this draft control was open — reload before voiding the lot.",
    };
  }
  const res = await voidCurrentLot(season.id, admin);
  if (!res.ok) return { error: res.error };
  await logAdminAction({
    action: "voidCurrentLot",
    summary: `Voided the paused live lot for ${res.player}; ${res.nominator} keeps the nomination turn`,
    seasonId: season.id,
  });
  await sendDiscordMessage(draftLotVoidedMessage(season.name, res.player));
  refresh();
  return {
    message: `Voided ${res.player}'s lot — no sale recorded. ${res.nominator} keeps the turn; Resume when ready.`,
  };
}

/** Generate a round-robin regular-season schedule from the drafted teams. */
export async function generateSchedule(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId) {
    return {
      error:
        "This schedule form is stale — reload before generating the schedule.",
    };
  }

  // Optional first-match-night: week 1 plays then, each later week +7 days.
  const firstNightRaw = str(formData, "firstNight").trim();
  const firstNight = localDate(formData, "firstNight", "firstNightTs");
  if (firstNightRaw && !firstNight) {
    return { error: "Invalid first match night" };
  }

  // The lib has supported a mirrored second leg since the beginning — this
  // flag was just never wired to a form, locking a 4-6 team league to a 3-5
  // week season with no in-app way to lengthen it. Mirrored = every pairing
  // plays twice with home/away swapped, weeks N..2N-ish, and crossTable /
  // SeasonGrid already render multiple meetings per pair.
  const doubleRound = bool(formData, "doubleRound");

  // Every authoritative input is read in the same Serializable transaction as
  // the replacement. A stale tab must not build rows from the old season's
  // teams or series length and then write them into whichever season happens
  // to be active when the POST arrives.
  await raceHook("admin.generateSchedule.beforeTx");
  let outcome: {
    seasonId: string;
    teams: { id: string; name: string }[];
    rows: number;
    weeks: number;
    cleared: {
      rsvps: number;
      picks: number;
      covers: number;
      proposals: number;
    };
    standDowns: {
      standinName: string;
      discordId: string | null;
      teamId: string;
      homeName: string;
      awayName: string;
      week: number;
    }[];
  };
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        const [
          activeSeason,
          currentSeason,
          currentDraft,
          teams,
          played,
          games,
        ] = await Promise.all([
          tx.season
            .findMany({
              where: { isActive: true },
              orderBy: { createdAt: "desc" },
              take: 2,
              select: { id: true },
            })
            .then(singleActiveSeason),
          tx.season.findUnique({
            where: { id: expectedActiveSeasonId },
            select: {
              id: true,
              isActive: true,
              status: true,
              regularBestOf: true,
            },
          }),
          tx.draft.findUnique({
            where: { seasonId: expectedActiveSeasonId },
            select: { status: true },
          }),
          tx.team.findMany({
            where: { seasonId: expectedActiveSeasonId },
            orderBy: { draftOrder: "asc" },
            select: { id: true, name: true, withdrawn: true },
          }),
          tx.match.count({
            where: {
              seasonId: expectedActiveSeasonId,
              phase: MATCH_PHASE.REGULAR,
              status: MATCH_STATUS.COMPLETED,
            },
          }),
          tx.game.count({
            where: { match: { seasonId: expectedActiveSeasonId } },
          }),
        ]);
        if (
          activeSeason?.id !== expectedActiveSeasonId ||
          !currentSeason?.isActive
        ) {
          throw new ActiveSeasonChangedError();
        }
        if (!postAuctionWorkOpen(currentSeason.status, currentDraft?.status)) {
          throw new PostAuctionWorkLockedError();
        }
        if (played > 0 || games > 0) throw new ResultsLandedError();
        const withdrawn = teams.filter((team) => team.withdrawn);
        if (withdrawn.length > 0) {
          throw new WithdrawnTeamsError(withdrawn.map((team) => team.name));
        }
        if (teams.length < 2) throw new ScheduleNeedsTeamsError();

        const rounds = roundRobin(
          teams.map((team) => team.id),
          doubleRound,
        );
        const rows = rounds.flatMap((round, i) =>
          round.map((pairing) => ({
            seasonId: currentSeason.id,
            week: i + 1,
            phase: MATCH_PHASE.REGULAR,
            homeTeamId: pairing.home,
            awayTeamId: pairing.away,
            bestOf: currentSeason.regularBestOf,
            scheduledAt: firstNight
              ? matchNightForWeek(firstNight, i + 1)
              : null,
          })),
        );

        // The results counts above protect games, but NOT the night-specific state
        // that hangs off a fixture id: MatchAvailability, Prediction,
        // StandinAssignment and RescheduleRequest all cascade with the match
        // (schema.prisma). The regenerated fixtures are the same pairings with NEW
        // ids, so every captain has to re-arrange cover they already arranged and
        // every player re-checks in — and none of that was reported. It stays
        // silent no more: count it and name it in the toast. (A first-ever
        // generate has nothing to count, so the message is unchanged there.)
        const doomed = await tx.match.findMany({
          where: {
            seasonId: expectedActiveSeasonId,
            phase: MATCH_PHASE.REGULAR,
          },
          select: { id: true },
        });
        const ids = doomed.map((m) => m.id);
        let cleared = { rsvps: 0, picks: 0, covers: 0, proposals: 0 };
        let standDowns: {
          standinName: string;
          discordId: string | null;
          teamId: string;
          homeName: string;
          awayName: string;
          week: number;
        }[] = [];
        if (ids.length > 0) {
          const [rsvps, picks, coverRows, proposals] = await Promise.all([
            tx.matchAvailability.count({ where: { matchId: { in: ids } } }),
            tx.prediction.count({ where: { matchId: { in: ids } } }),
            // The ROWS, not just a count: each is a standin holding a live
            // @-mentioned instruction to turn up for a fixture that is about to
            // stop existing. Every ordinary removal path stands them down; this
            // one deleted the booking in silence. Read INSIDE the transaction —
            // after the deleteMany below they are gone, and reading before it
            // would miss a booking made in the gap.
            tx.standinAssignment.findMany({
              where: { matchId: { in: ids } },
              select: {
                teamId: true,
                standin: { select: { name: true, discordId: true } },
                match: {
                  select: {
                    week: true,
                    homeTeam: { select: { name: true } },
                    awayTeam: { select: { name: true } },
                  },
                },
              },
            }),
            tx.rescheduleRequest.count({
              where: { matchId: { in: ids }, status: "PENDING" },
            }),
          ]);
          cleared = { rsvps, picks, covers: coverRows.length, proposals };
          standDowns = coverRows.map((a) => ({
            standinName: a.standin.name,
            discordId: a.standin.discordId,
            teamId: a.teamId,
            homeName: a.match.homeTeam.name,
            awayName: a.match.awayTeam.name,
            week: a.match.week,
          }));
        }
        await tx.match.deleteMany({
          where: {
            seasonId: expectedActiveSeasonId,
            phase: MATCH_PHASE.REGULAR,
          },
        });
        await tx.match.createMany({ data: rows });
        const anchored = await tx.season.updateMany({
          where: { id: expectedActiveSeasonId, isActive: true },
          data: { firstMatchNight: firstNight },
        });
        if (anchored.count !== 1) throw new ActiveSeasonChangedError();
        // The week reminders quoted kickoffs for fixtures that no longer exist.
        // Discord edits notify nobody, so releasing the markers is what lets the
        // reminder re-fire against the new slate.
        await tx.setting.deleteMany({
          where: {
            key: { startsWith: weekReminderPrefix(expectedActiveSeasonId) },
          },
        });
        return {
          seasonId: currentSeason.id,
          teams: teams.map(({ id, name }) => ({ id, name })),
          rows: rows.length,
          weeks: rounds.length,
          cleared,
          standDowns,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof ActiveSeasonChangedError) {
      return {
        error:
          "The active season changed while this schedule form was open — reload before generating.",
      };
    }
    if (e instanceof PostAuctionWorkLockedError) {
      return {
        error:
          "The auction or season changed while you generated — nothing was changed. Finish the auction first.",
      };
    }
    if (e instanceof ResultsLandedError) {
      return {
        error:
          "Results are already recorded — a result landed before or while you were generating. Nothing was changed; reload and check the schedule.",
      };
    }
    if (e instanceof WithdrawnTeamsError) {
      return {
        error: `Reinstate ${e.teamNames.join(", ")} before generating — withdrawn teams are kept for history but are not added to a new schedule.`,
      };
    }
    if (e instanceof ScheduleNeedsTeamsError) {
      return { error: "Need at least 2 active teams" };
    }
    if ((e as { code?: string }).code === "P2034") {
      return {
        error:
          "The schedule changed while it was being generated — nothing was changed. Reload and try again.",
      };
    }
    throw e;
  }
  // Post-commit, best-effort, one per deleted booking — the same formatter and
  // shape releasePlayer/signFreeAgent/removeStandin use, so a standin is never
  // left holding an instruction for a fixture that no longer exists.
  const scheduleTeamNames = new Map(outcome.teams.map((t) => [t.id, t.name]));
  for (const a of outcome.standDowns) {
    await sendDiscordMessage(
      standinRemovedMessage({
        standinName: a.standinName,
        teamName: scheduleTeamNames.get(a.teamId) ?? "their team",
        homeName: a.homeName,
        awayName: a.awayName,
        week: a.week,
        isPlayoff: false,
      }),
      mentionsOf([a.discordId]),
    );
  }
  await logAdminAction({
    action: "generateSchedule",
    summary:
      `Generated ${outcome.rows} regular-season fixture(s)` +
      (outcome.cleared.rsvps ||
      outcome.cleared.picks ||
      outcome.cleared.covers ||
      outcome.cleared.proposals
        ? ` — replaced the previous schedule, clearing ${outcome.cleared.rsvps} check-in(s), ${outcome.cleared.picks} pick'em pick(s), ${outcome.cleared.covers} standin booking(s) and ${outcome.cleared.proposals} open proposal(s)`
        : ""),
    seasonId: outcome.seasonId,
  });
  refresh();
  // Name the collateral. Zeros are omitted, so a first-ever generate reads
  // exactly as it always did.
  const collateral = [
    outcome.cleared.rsvps ? `${outcome.cleared.rsvps} check-in(s)` : null,
    outcome.cleared.picks ? `${outcome.cleared.picks} pick'em pick(s)` : null,
    outcome.cleared.covers
      ? `${outcome.cleared.covers} standin booking(s)`
      : null,
    outcome.cleared.proposals
      ? `${outcome.cleared.proposals} open reschedule(s)`
      : null,
  ].filter(Boolean);
  return {
    // A blank first night isn't just "no times shown": unscheduled matches are
    // never auto-scanned, get no week reminder, and never lock pick'em. Say so
    // rather than letting the league discover it in week 2.
    message: `Schedule generated · ${outcome.rows} matches over ${outcome.weeks} week(s)${
      doubleRound ? " (double round robin)" : ""
    }${
      firstNight
        ? " · match nights set weekly"
        : " · no kickoff times set, so auto-sync, reminders and pick'em locks stay off until you set them"
    }${
      collateral.length
        ? ` · the old fixtures were replaced, clearing ${collateral.join(", ")}`
        : ""
    }`,
  };
}

/** Seed and start the single-elimination playoff bracket from the standings. */
export async function startPlayoffs(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this playoff control was open — reload and try again.",
    };
  }
  const intent = str(formData, "intent");
  if (intent !== "start" && intent !== "reset") {
    return {
      error: "Choose Start playoffs or Reset playoffs from the current page",
    };
  }
  const expectedSeasonStatus = str(formData, "expectedSeasonStatus").trim();
  const expectedRevision = str(formData, "expectedRevision").trim();
  if (!expectedSeasonStatus || !expectedRevision) {
    return {
      error:
        "This playoff control is stale or incomplete — reload and try again.",
    };
  }

  // Don't seed the bracket on an incomplete regular season — missing results
  // would give the wrong standings and the wrong seeding.
  const matches = await prisma.match.findMany({
    where: { seasonId: season.id },
    select: { week: true, phase: true, status: true },
  });
  const status = regularSeasonStatus(matches);
  const pending = pendingResultsMessage(status);
  if (pending) {
    return { error: `${pending} Enter them before starting the playoffs.` };
  }
  // pending === 0 is also true for an EMPTY slate — seeding a bracket off a
  // season that never generated a schedule would be an arbitrary coin flip.
  if (!status.allComplete) {
    return { error: "Generate and play the regular season first" };
  }

  let outcome: Awaited<ReturnType<typeof createPlayoffBracket>>;
  try {
    outcome = await createPlayoffBracket(season.id, {
      intent,
      expectedSeasonStatus,
      expectedRevision,
    });
  } catch (e) {
    return {
      error: actionErrorMessage(
        e,
        "Couldn't update the playoff bracket — reload and try again",
        "admin.playoffs.start",
      ),
    };
  }

  // The bracket transaction is already durable. Expire the preflight before
  // Discord/admin-log follow-ups so a failure there cannot leave automation
  // sleeping on the old regular-season snapshot.
  updateTag(AUTOMATION_GATE_TAG);

  // Announce the fresh first-round pairings.
  const [bracket, teams] = await Promise.all([
    prisma.match.findMany({
      where: { seasonId: season.id, phase: { not: MATCH_PHASE.REGULAR } },
      orderBy: { bracketSlot: "asc" },
    }),
    prisma.team.findMany({ where: { seasonId: season.id } }),
  ]);
  const name = new Map(teams.map((t) => [t.id, t.name]));
  // A reset deletes the postseason's standin bookings with it (StandinAssignment
  // cascades from Match). Every ordinary removal path stands the standin down;
  // this one dropped their live @-mentioned instruction in silence. Post-commit
  // and best-effort, before the pairings announcement so the correction lands
  // ahead of the new fixtures.
  for (const a of outcome.standDowns) {
    await sendDiscordMessage(
      standinRemovedMessage({
        standinName: a.standinName,
        teamName: name.get(a.teamId) ?? "their team",
        homeName: a.homeName,
        awayName: a.awayName,
        week: a.week,
        isPlayoff: true,
      }),
      mentionsOf([a.discordId]),
    );
  }
  await sendDiscordMessage(
    playoffsStartedMessage(
      season.name,
      bracket.map((m) => ({
        home: name.get(m.homeTeamId) ?? "?",
        away: name.get(m.awayTeamId) ?? "?",
      })),
    ),
  );

  await logAdminAction({
    action: "startPlayoffs",
    summary: `${intent === "reset" ? "Reset and reseeded" : "Seeded"} the playoff bracket (${bracket.length} first-round match(es))${outcome.removedGameCount ? ` — archived ${outcome.removedGameCount} deleted OpenDota game id(s)` : ""}`,
    seasonId: season.id,
  });
  // Reset can cascade imported Games. The league-state cursor is stamped in
  // the transaction; this tag keeps cached stat boards in the actor's own tab
  // synchronized immediately as well.
  refreshGames();
  return {
    message:
      intent === "reset"
        ? "Playoff bracket reset and reseeded"
        : "Playoff bracket created",
  };
}

/** Remove the postseason and reopen the existing regular season for repair. */
export async function returnToRegularSeasonAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this recovery control was open — reload and try again.",
    };
  }
  const expectedSeasonStatus = str(formData, "expectedSeasonStatus").trim();
  const expectedRevision = str(formData, "expectedRevision").trim();
  if (!expectedSeasonStatus || !expectedRevision) {
    return { error: "This recovery control is stale — reload and try again." };
  }

  let outcome: Awaited<ReturnType<typeof returnToRegularSeason>>;
  try {
    outcome = await returnToRegularSeason(season.id, {
      expectedSeasonStatus,
      expectedRevision,
    });
  } catch (error) {
    return {
      error: actionErrorMessage(
        error,
        "Couldn't return to the regular season — reload and try again",
        "admin.playoffs.return",
      ),
    };
  }

  // The playoff removal is committed before the presentation/Discord reads
  // below. Wake the scheduler even if one of those best-effort follow-ups
  // fails after the write.
  updateTag(AUTOMATION_GATE_TAG);

  const names = new Map(
    (
      await prisma.team.findMany({
        where: { seasonId: season.id },
        select: { id: true, name: true },
      })
    ).map((team) => [team.id, team.name]),
  );
  let failedStandDownNotices = 0;
  for (const assignment of outcome.standDowns) {
    const sent = await sendDiscordMessage(
      standinRemovedMessage({
        standinName: assignment.standinName,
        teamName: names.get(assignment.teamId) ?? "their team",
        homeName: assignment.homeName,
        awayName: assignment.awayName,
        week: assignment.week,
        isPlayoff: true,
      }),
      mentionsOf([assignment.discordId]),
    );
    if (!sent) failedStandDownNotices += 1;
  }
  const leagueNoticeSent = await sendDiscordMessage(
    playoffsReturnedToRegularMessage(season.name),
  );
  const notificationFailures =
    failedStandDownNotices + (leagueNoticeSent ? 0 : 1);
  await logAdminAction({
    action: "returnToRegularSeason",
    summary: `Removed the playoff bracket and returned to Regular season${outcome.removedGameCount ? ` — archived ${outcome.removedGameCount} deleted OpenDota game id(s)` : ""}${notificationFailures ? ` — ${notificationFailures} Discord notification(s) failed` : ""}`,
    seasonId: season.id,
  });
  refreshGames();
  return {
    message: `Returned to the regular season — correct the table, then start a fresh playoff bracket${notificationFailures ? `. Discord warning: ${leagueNoticeSent ? "the league notice sent, but one or more standin stand-downs failed" : "the league-wide bracket notice failed"}${failedStandDownNotices && !leagueNoticeSent ? `, and ${failedStandDownNotices} standin stand-down${failedStandDownNotices === 1 ? "" : "s"} also failed` : ""}; notify the affected players manually` : ""}`,
  };
}

/** Record a match result (series score). Sets winner + completed status. */
export async function recordResult(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const matchId = str(formData, "matchId");
  const homeScore = clampInt(formData, "homeScore", 0, 0, 99);
  const awayScore = clampInt(formData, "awayScore", 0, 0, 99);
  // A forfeit is a RULED score, and the flag is what keeps the ruling honest
  // downstream: standings/head-to-head exclude it from gameDiff, the power
  // rankings skip it, and every surface badges it — an admin-chosen 2-0 no
  // longer masquerades as a played sweep in the tiebreaks.
  const forfeit = bool(formData, "forfeit");
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();

  // Fast snapshot for precise validation and the stale-form claim. Every
  // load-bearing rule is repeated inside the Serializable command below.
  const snapshot = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      status: true,
      homeScore: true,
      awayScore: true,
      winnerTeamId: true,
      forfeit: true,
      bestOf: true,
    },
  });
  if (!snapshot) return { error: "Unknown match" };
  const scoreError = forfeit
    ? seriesScoreError(snapshot.bestOf, homeScore, awayScore)
    : playedSeriesFinalError(snapshot.bestOf, homeScore, awayScore);
  if (scoreError) return { error: scoreError };

  // Stage an import/result/phase change after the form's judged snapshot but
  // before the authoritative transaction. The current row must still equal
  // this snapshot inside the command; otherwise the admin reloads and judges
  // the new truth rather than overwriting it.
  await raceHook("recordResult.beforeSwap");

  let outcome: {
    seasonId: string;
    phase: string;
    week: number;
    homeTeamId: string;
    awayTeamId: string;
    homeName: string;
    awayName: string;
    winnerTeamId: string | null;
    bookings: {
      teamId: string;
      standin: { name: string; discordId: string | null };
    }[];
  };
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        const match = await tx.match.findUnique({
          where: { id: matchId },
          select: {
            id: true,
            seasonId: true,
            phase: true,
            homeTeamId: true,
            awayTeamId: true,
            week: true,
            scheduledAt: true,
            bracketSlot: true,
            status: true,
            homeScore: true,
            awayScore: true,
            winnerTeamId: true,
            forfeit: true,
            bestOf: true,
            games: { select: { winnerTeamId: true } },
            homeTeam: { select: { name: true } },
            awayTeam: { select: { name: true } },
            season: {
              select: {
                isActive: true,
                status: true,
                championTeamId: true,
              },
            },
          },
        });
        if (!match) throw new ResultWriteError("Unknown match");
        if (
          expectedActiveSeasonId &&
          match.seasonId !== expectedActiveSeasonId
        ) {
          throw new ResultWriteError(
            "The active season changed while this result form was open — reload and try again.",
          );
        }
        if (
          !match.season.isActive ||
          !matchResultsOpen(match.season.status, match.phase)
        ) {
          throw new ResultWriteError(
            match.phase === MATCH_PHASE.REGULAR
              ? "Regular-season results can only change during the active Regular season phase. Move the season back before correcting this result, then reseed the playoffs."
              : "Playoff results can only change while the active season is in Playoffs.",
          );
        }
        if (
          match.status !== snapshot.status ||
          match.homeScore !== snapshot.homeScore ||
          match.awayScore !== snapshot.awayScore ||
          match.winnerTeamId !== snapshot.winnerTeamId ||
          match.forfeit !== snapshot.forfeit
        ) {
          throw new ResultWriteError(
            "That match just changed — a game was imported while you were typing, or another result correction landed. Reload and check the score before saving.",
          );
        }
        if (
          match.status === MATCH_STATUS.COMPLETED &&
          match.homeScore === homeScore &&
          match.awayScore === awayScore &&
          match.forfeit === forfeit
        ) {
          throw new ResultAlreadySavedError();
        }

        const currentScoreError = forfeit
          ? seriesScoreError(match.bestOf, homeScore, awayScore)
          : playedSeriesFinalError(match.bestOf, homeScore, awayScore);
        if (currentScoreError) throw new ResultWriteError(currentScoreError);
        if (match.games.length > 0 && !forfeit) {
          throw new ResultWriteError(
            "This match has imported games, so its score is derived from them. Remove or re-import the incorrect game instead of overwriting the series score.",
          );
        }
        if (forfeit && match.games.length > 0) {
          const playedHome = match.games.filter(
            (game) => game.winnerTeamId === match.homeTeamId,
          ).length;
          const playedAway = match.games.filter(
            (game) => game.winnerTeamId === match.awayTeamId,
          ).length;
          if (homeScore < playedHome || awayScore < playedAway) {
            throw new ResultWriteError(
              `The ruling cannot erase imported game wins (${playedHome}–${playedAway}). Remove the incorrect game first, or enter a score that includes it.`,
            );
          }
        }

        if (match.phase !== MATCH_PHASE.REGULAR) {
          if (homeScore === awayScore) {
            throw new ResultWriteError(
              "A playoff series can't end in a draw — record the forfeit/decider winner",
            );
          }
          const playoffs = await tx.match.findMany({
            where: {
              seasonId: match.seasonId,
              phase: { not: MATCH_PHASE.REGULAR },
            },
            select: { bracketSlot: true },
          });
          if (hasLaterBracketRound(playoffs, match.bracketSlot)) {
            throw new ResultWriteError(
              "This series already advanced the bracket — recreate the bracket to correct it",
            );
          }
          if (match.season.status === SEASON_STATUS.COMPLETE) {
            throw new ResultWriteError(
              seasonCompleteError(match.season.championTeamId),
            );
          }
        }

        const winnerTeamId =
          homeScore > awayScore
            ? match.homeTeamId
            : awayScore > homeScore
              ? match.awayTeamId
              : null;
        const applied = await tx.match.updateMany({
          where: {
            id: match.id,
            status: match.status,
            homeScore: match.homeScore,
            awayScore: match.awayScore,
            winnerTeamId: match.winnerTeamId,
            forfeit: match.forfeit,
          },
          data: {
            homeScore,
            awayScore,
            winnerTeamId,
            status: MATCH_STATUS.COMPLETED,
            forfeit,
            completedAt: new Date(),
          },
        });
        if (applied.count === 0) {
          throw new ResultWriteError(
            "That match just changed — a game was imported while you were typing, or another result correction landed. Reload and check the score before saving.",
          );
        }

        if (match.status === MATCH_STATUS.SCHEDULED && match.scheduledAt) {
          await invalidatePendingAnnouncementMarkers(
            tx,
            weekReminderKey(
              match.seasonId,
              match.week,
              match.scheduledAt.getTime(),
            ),
          );
        }
        if (
          match.phase === MATCH_PHASE.REGULAR &&
          match.status === MATCH_STATUS.COMPLETED
        ) {
          await markWeekHonorsStale(tx, match.seasonId, match.week);
        }

        let bookings: {
          teamId: string;
          standin: { name: string; discordId: string | null };
        }[] = [];
        if (forfeit && match.games.length === 0) {
          bookings = await tx.standinAssignment.findMany({
            where: { matchId: match.id },
            select: {
              teamId: true,
              standin: { select: { name: true, discordId: true } },
            },
          });
          // A no-game ruling cancels the fixture, not merely its reminder.
          // Deleting in the same command prevents Reopen from resurrecting a
          // stale booking after the standin was explicitly stood down.
          await tx.standinAssignment.deleteMany({
            where: { matchId: match.id },
          });
        }
        const changedAt = new Date().toISOString();
        await tx.setting.upsert({
          where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
          create: { key: SETTING_KEYS.RESULT_CHANGED_AT, value: changedAt },
          update: { value: changedAt },
        });
        // The score and its announcement source change together. Deleting the
        // old generation makes any not-yet-delivered payload fail its source
        // check, while a crash after this commit leaves a completedAt-backed
        // recovery candidate for the unattended worker.
        await tx.setting.deleteMany({
          where: { key: resultAnnouncedKey(match.id) },
        });
        return {
          seasonId: match.seasonId,
          phase: match.phase,
          week: match.week,
          homeTeamId: match.homeTeamId,
          awayTeamId: match.awayTeamId,
          homeName: match.homeTeam.name,
          awayName: match.awayTeam.name,
          winnerTeamId,
          bookings,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof ResultAlreadySavedError) {
      return { message: "That result is already saved — no changes were made" };
    }
    if (error instanceof ResultWriteError) return { error: error.message };
    if ((error as { code?: string }).code === "P2034") {
      return {
        error:
          "The match, phase, or playoff bracket changed while you saved — reload and check the current result.",
      };
    }
    throw error;
  }

  // Queue gate expiry as soon as the result transaction commits. The
  // announcement/bracket follow-ups below are deliberately recoverable and
  // must not be the only path to invalidation if one of them throws.
  updateTag(AUTOMATION_GATE_TAG);

  // The activity card's copy promises result changes are logged — and a
  // manual score can override an auto-import, which is exactly the "what did
  // I press?" case the log exists for. Match retiming is logged separately
  // because it clears check-ins and pending reschedule proposals.
  await logAdminAction({
    action: "recordResult",
    summary: `Recorded ${outcome.homeName} ${homeScore}–${awayScore} ${outcome.awayName} (week ${outcome.week})${forfeit ? " — forfeit" : ""}`,
    seasonId: outcome.seasonId,
  });
  // Use the same leased marker + durable outbox path as imported results.
  // Notification trouble must not turn a committed result into a misleading
  // failed admin action; completedAt recovery owns the crash/failure gap.
  try {
    await announceSeriesResultOnce({
      id: matchId,
      homeTeamId: outcome.homeTeamId,
      awayTeamId: outcome.awayTeamId,
      homeScore,
      awayScore,
      week: outcome.week,
      phase: outcome.phase,
      forfeit,
    });
  } catch {
    console.error(
      "[admin] result announcement deferred (RESULT_ANNOUNCEMENT_FAILED)",
    );
  }

  // A forfeit RULING on a series with no imported games is a fixture that
  // won't be played — any standin booked on it (either side) holds a live
  // @-mentioned instruction to show up, and completing the match silently
  // drops the booking from their /me list. Stand them down by name, the same
  // shape every other cover-killing path sends. Gated on the forfeit flag AND
  // zero games: a manual score for a PLAYED series (private data, no imports)
  // must not tell a standin who actually played to stand down.
  for (const booking of outcome.bookings) {
    await sendDiscordMessage(
      standinRemovedMessage({
        standinName: booking.standin.name,
        teamName:
          booking.teamId === outcome.homeTeamId
            ? outcome.homeName
            : outcome.awayName,
        homeName: outcome.homeName,
        awayName: outcome.awayName,
        week: outcome.week,
        isPlayoff: outcome.phase !== MATCH_PHASE.REGULAR,
      }),
      mentionsOf([booking.standin.discordId]),
    );
  }

  // Playoff results auto-advance the bracket (and crown the champion at the end).
  if (outcome.phase !== MATCH_PHASE.REGULAR) {
    await advancePlayoffBracket(outcome.seasonId);
  } else {
    // Manual results can also close out a week — send its honors (idempotent).
    await maybeAnnounceWeekHonors(outcome.seasonId, outcome.week);
  }
  refresh();
  return {
    message: `Result saved · ${homeScore}–${awayScore}${forfeit ? " (forfeit — excluded from game-diff tiebreaks)" : ""}`,
  };
}

/**
 * Permanently add an undrafted (or late-registered) player to a team with an
 * open roster seat — how short teams get topped up after the draft.
 */
export async function signFreeAgent(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.SIGNUPS) {
    return { error: "Run the draft first — signings are for after it" };
  }
  if (season.status === SEASON_STATUS.COMPLETE) {
    return { error: "The season is over" };
  }
  // While the auction is LIVE, roster writes belong to the draft engine
  // alone — signing the nominated player wedges every draft poll on a
  // unique-constraint throw. The pool-dry top-up window is Draft COMPLETE.
  if (season.status === SEASON_STATUS.DRAFT) {
    const draftRow = await prisma.draft.findUnique({
      where: { seasonId: season.id },
    });
    // `draftRow?.status !== COMPLETE`, NOT `draftRow && …`. A season only gets
    // a Draft row when Start draft is pressed, and setSeasonPhase enforces no
    // adjacency — so an admin who clicks the "Draft" phase button first sits in
    // DRAFT with a NULL draft row, and the old `draftRow &&` guard fell straight
    // through. That offered AND accepted $0 free-agent signings out of the
    // un-auctioned pool: the auction could be bypassed entirely, one player at a
    // time, before it ever started.
    if (draftRow?.status !== DRAFT_STATUS.COMPLETE) {
      return {
        error: draftRow
          ? "The draft is still running — top up rosters after it"
          : "The auction hasn't run yet — press Start draft, or move the season back to Signups",
      };
    }
  }

  const teamId = str(formData, "teamId");
  const userId = str(formData, "userId");

  const [team, registration, existingSeat, memberCount, pendingAssignments] =
    await Promise.all([
      prisma.team.findFirst({
        where: { id: teamId, seasonId: season.id },
        include: { captain: true },
      }),
      prisma.registration.findUnique({
        where: { seasonId_userId: { seasonId: season.id, userId } },
        include: { user: true },
      }),
      prisma.teamMember.findFirst({
        where: { seasonId: season.id, userId },
      }),
      prisma.teamMember.count({ where: { teamId } }),
      // Same guard promoteStandinToPlayer already applies: an outstanding
      // standin assignment on an unplayed match would put this account in BOTH
      // teams' account sets for that match, so classifyGame sees the same
      // player on each side and every import path for it fails.
      prisma.standinAssignment.count({
        where: {
          standinUserId: userId,
          match: {
            seasonId: season.id,
            status: { not: MATCH_STATUS.COMPLETED },
          },
        },
      }),
    ]);
  if (!team) return { error: "Unknown team" };
  // A withdrawn team's fixtures are all forfeited — signing onto it parks the
  // player on a dead roster (and rostered players can't stand in), for zero
  // benefit until the team is reinstated. Read-time is enough: withdrawal is
  // a slow admin act, and a mis-click here is losslessly undone by Release.
  if (team.withdrawn) {
    return {
      error: `${team.name} has withdrawn from the season — reinstate them first if they're coming back`,
    };
  }
  if (!registration || registration.status !== "ACTIVE") {
    return { error: "That player isn't registered for this season" };
  }
  // Standins fill single matches, not roster seats — signing one would leave
  // them straddling both worlds (in the standin pool AND on a roster).
  if (registration.type !== REGISTRATION_TYPE.PLAYER) {
    return {
      error: "That signup is a standin — only full players can be signed",
    };
  }
  if (existingSeat) return { error: "That player is already on a team" };
  if (pendingAssignments > 0) {
    return {
      error: `${registration.user.name} is standing in on an upcoming match — remove that assignment first, then sign them`,
    };
  }
  if (memberCount >= season.teamSize) {
    return { error: `${team.name} has no open roster seats` };
  }

  // SERIALIZABLE, not a plain transaction: on Postgres a plain one reads at
  // read-committed, so this count locks nothing and two concurrent signs into
  // a team's last seat BOTH see room and both insert — a 6-player roster in a
  // 5-a-side league. (SQLite serializes writers, which is why the old comment
  // read as if the re-check alone was enough.) The loser now aborts with
  // P2034 and is reported as the seat being taken.
  let coverCleanup: {
    cancelled: number;
    kept: number;
    standDowns: {
      standinUserId: string;
      standin: { name: string; discordId: string | null };
      match: {
        week: number;
        phase: string;
        homeTeam: { name: string };
        awayTeam: { name: string };
      };
    }[];
    /** Per-match "bookings now exceed the open seats" notes — a PARTIAL
     *  refill shrinks the seat count the assign-time budget was judged
     *  against, and nothing re-audits existing bookings. Reported, never
     *  auto-cancelled: which booking dies is the captain's call (the
     *  withdrawGateError refuse-don't-auto-cancel precedent). */
    overbooked: string[];
  } = { cancelled: 0, kept: 0, standDowns: [], overbooked: [] };
  try {
    coverCleanup = await prisma.$transaction(
      async (tx) => {
        const [currentSeason, currentDraft, currentTeam, currentRegistration] =
          await Promise.all([
            tx.season.findUnique({ where: { id: season.id } }),
            tx.draft.findUnique({ where: { seasonId: season.id } }),
            tx.team.findFirst({ where: { id: teamId, seasonId: season.id } }),
            tx.registration.findUnique({
              where: {
                seasonId_userId: { seasonId: season.id, userId },
              },
            }),
          ]);
        if (
          !currentSeason?.isActive ||
          currentSeason.status === SEASON_STATUS.SIGNUPS ||
          currentSeason.status === SEASON_STATUS.COMPLETE ||
          (currentSeason.status === SEASON_STATUS.DRAFT &&
            currentDraft?.status !== DRAFT_STATUS.COMPLETE)
        ) {
          throw new Error("ROSTER_LIFECYCLE_CHANGED");
        }
        if (!currentTeam || currentTeam.withdrawn) {
          throw new Error("TEAM_CHANGED");
        }
        if (
          !currentRegistration ||
          currentRegistration.status !== REGISTRATION_STATUS.ACTIVE ||
          currentRegistration.type !== REGISTRATION_TYPE.PLAYER
        ) {
          throw new Error("SIGNUP_CHANGED");
        }
        const seats = await tx.teamMember.count({ where: { teamId } });
        if (seats >= season.teamSize) throw new Error("SEAT_TAKEN");
        // The standin count is re-read HERE, inside the serializable
        // transaction, for the same reason assignStandinGuarded re-reads its
        // roster check inside its own: this and an assign are a write-skew
        // pair (sign reads assignments + writes TeamMember; assign reads the
        // roster + writes StandinAssignment), and SSI can only spot the cycle
        // if BOTH sides put the other's table in their read set. Re-checking
        // outside, as this did, left a single rw-edge and no cycle — so a
        // player could end up rostered AND holding live cover, which puts one
        // account in both teams' import sets and fails every classifyGame.
        const stillCovering = await tx.standinAssignment.count({
          where: {
            standinUserId: userId,
            match: {
              seasonId: season.id,
              status: { not: MATCH_STATUS.COMPLETED },
            },
          },
        });
        if (stillCovering > 0) throw new Error("STANDIN_COVER");
        await tx.teamMember.create({
          data: {
            seasonId: season.id,
            teamId,
            userId,
            price: 0,
            isCaptain: false,
          },
        });
        // The reverse of releasePlayer's stale-cover rule: an EMPTY-SEAT
        // assignment (replacingUserId null) is permanently "live" to
        // matchNightRoster, so once this signing fills the team's LAST seat
        // every such booking on an unplayed match is redundant — left behind,
        // the refilled side computes as teamSize+1 on /schedule, the dashboard,
        // the week reminder AND gatherTeamAccounts' import set, while the
        // standin keeps a live @-mentioned instruction to show up. Cancel them
        // here, under the same started-series rule as release: once a game is
        // imported the assignment is load-bearing for the rest of the series,
        // so it is kept and reported instead.
        if (seats + 1 >= season.teamSize) {
          const emptySeatCovers = await tx.standinAssignment.findMany({
            where: {
              teamId,
              replacingUserId: null,
              match: {
                seasonId: season.id,
                status: { not: MATCH_STATUS.COMPLETED },
              },
            },
            select: {
              id: true,
              standinUserId: true,
              standin: { select: { name: true, discordId: true } },
              match: {
                select: {
                  games: { select: { id: true }, take: 1 },
                  week: true,
                  phase: true,
                  homeTeam: { select: { name: true } },
                  awayTeam: { select: { name: true } },
                },
              },
            },
          });
          const removable = emptySeatCovers.filter(
            (a) => a.match.games.length === 0,
          );
          let cancelled = 0;
          if (removable.length) {
            // "No games yet" rides in the WHERE, not just the JS filter — a
            // series can acquire its first game between the findMany and this
            // delete (the releasePlayer pattern).
            ({ count: cancelled } = await tx.standinAssignment.deleteMany({
              where: {
                id: { in: removable.map((s) => s.id) },
                match: { games: { none: {} } },
              },
            }));
          }
          return {
            cancelled,
            kept: emptySeatCovers.length - cancelled,
            // Announce only if the DELETE really took them all — telling a
            // standin to stand down from a game they are still booked for is
            // worse than silence.
            standDowns: cancelled === removable.length ? removable : [],
            overbooked: [],
          };
        }
        // PARTIAL refill — the team is still short, so open-seat cover stays
        // legitimate, but the seat count every booking was budgeted against
        // just shrank by one. Surplus is a PER-MATCH fact (bookings live on
        // matches, seats on the roster): a 3-of-5 team with two bookings on
        // week 4 AND two on week 5 goes surplus-by-one on both. Left silent,
        // each surplus rides matchNightRoster into /schedule, the week
        // reminder and the import account set as a six-player side.
        const newOpen = season.teamSize - (seats + 1);
        const stillBooked = await tx.standinAssignment.findMany({
          where: {
            teamId,
            replacingUserId: null,
            match: {
              seasonId: season.id,
              status: { not: MATCH_STATUS.COMPLETED },
            },
          },
          select: {
            matchId: true,
            match: {
              select: {
                week: true,
                homeTeam: { select: { name: true } },
                awayTeam: { select: { name: true } },
              },
            },
          },
        });
        const perMatch = new Map<string, { label: string; count: number }>();
        for (const b of stillBooked) {
          const cur = perMatch.get(b.matchId);
          if (cur) cur.count += 1;
          else
            perMatch.set(b.matchId, {
              label: `week ${b.match.week} ${b.match.homeTeam.name} vs ${b.match.awayTeam.name}`,
              count: 1,
            });
        }
        const overbooked = [...perMatch.values()]
          .filter((m) => m.count > newOpen)
          .map(
            (m) =>
              `${m.count} open-seat booking(s) on ${m.label} now exceed the team's ${newOpen} open seat(s) — remove the extra on the match page`,
          );
        return { cancelled: 0, kept: 0, standDowns: [], overbooked };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if ((e as Error).message === "ROSTER_LIFECYCLE_CHANGED") {
      return {
        error:
          "The season or auction just changed — roster signings are locked until the auction is complete.",
      };
    }
    if ((e as Error).message === "TEAM_CHANGED") {
      return { error: `${team.name} is no longer available for signings` };
    }
    if ((e as Error).message === "SIGNUP_CHANGED") {
      return {
        error: "That player's signup just changed — reload and try again",
      };
    }
    if ((e as { code?: string }).code === "P2034") {
      return {
        error:
          "The auction, roster, or signup just changed — reload and try again.",
      };
    }
    if ((e as Error).message === "SEAT_TAKEN") {
      return { error: `${team.name} has no open roster seats` };
    }
    if ((e as Error).message === "STANDIN_COVER") {
      return {
        error: `${registration.user.name} is standing in on an upcoming match — remove that assignment first, then sign them`,
      };
    }
    if ((e as { code?: string }).code === "P2002") {
      return { error: "That player was just signed elsewhere" };
    }
    throw e;
  }
  await logAdminAction({
    action: "signFreeAgent",
    summary: `Signed ${registration.user.name} to ${team.name}; cancelled ${coverCleanup.cancelled} redundant open-seat cover booking(s)`,
    seasonId: season.id,
  });
  await sendDiscordMessage(
    freeAgentSignedMessage(registration.user.name, team.name),
    // @-mention the signed player: a signing is a season-long obligation —
    // every remaining match night is now theirs — and this was a bare
    // broadcast while the one-night standin assign has always mentioned its
    // subject. The message ends by naming their next move (check in).
    mentionsOf([registration.user.discordId]),
  );
  // Post-commit, best-effort, one stand-down per cancelled empty-seat booking —
  // the same shape releasePlayer and both removeStandin paths send, so a
  // standin is never left holding an instruction for a seat that just filled.
  for (const a of coverCleanup.standDowns) {
    await sendDiscordMessage(
      standinRemovedMessage({
        standinName: a.standin.name,
        teamName: team.name,
        homeName: a.match.homeTeam.name,
        awayName: a.match.awayTeam.name,
        week: a.match.week,
        isPlayoff: a.match.phase !== MATCH_PHASE.REGULAR,
      }),
      mentionsOf([a.standin.discordId]),
    );
  }
  refresh();
  const coverNotes = [
    coverCleanup.cancelled > 0
      ? `${coverCleanup.cancelled} now-redundant open-seat standin booking(s) cancelled and stood down`
      : null,
    coverCleanup.kept > 0
      ? `${coverCleanup.kept} open-seat booking(s) on an already-started series were LEFT in place (removing a standin mid-series breaks the remaining imports)`
      : null,
    ...coverCleanup.overbooked,
  ].filter(Boolean);
  return {
    message:
      `${registration.user.name} signed to ${team.name}` +
      (coverNotes.length ? ` · ${coverNotes.join(" · ")}` : "") +
      // A permanent signing that structurally can't be reached on Discord is
      // discovered on match night — the assign-standin garnish, same reason.
      (await reachabilityNote(userId)),
  };
}

/**
 * Release a non-captain from their roster — they go back to the free-agent
 * pool (their registration stays ACTIVE) and can be signed elsewhere.
 */
export async function releasePlayer(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.SIGNUPS) {
    return { error: "There are no rosters before the draft" };
  }
  if (season.status === SEASON_STATUS.COMPLETE) {
    return { error: "The season is over" };
  }
  // A LIVE auction owns the rosters: releasing a just-sold player deletes
  // the seat without refunding the budget and re-lists them for a second
  // auction. Releases wait for the draft to finish.
  if (season.status === SEASON_STATUS.DRAFT) {
    const draftRow = await prisma.draft.findUnique({
      where: { seasonId: season.id },
    });
    // Same missing-Draft-row hole as signFreeAgent above.
    if (draftRow?.status !== DRAFT_STATUS.COMPLETE) {
      return {
        error: draftRow
          ? "The draft is still running — release players after it"
          : "The auction hasn't run yet — there is nothing drafted to release",
      };
    }
  }

  const memberId = str(formData, "memberId");
  const member = await prisma.teamMember.findFirst({
    where: { id: memberId, seasonId: season.id },
    include: { user: true, team: true },
  });
  if (!member) return { error: "Unknown roster spot" };
  if (member.isCaptain) {
    return { error: "Captains can't be released — the team is theirs" };
  }

  // Release is three things, not one — do them atomically.
  //
  // 1. REFUND the price. The whole auction rests on `budget >= need * MIN_BID`
  //    (maintained by maxBid on every purchase). Deleting the seat raises `need`
  //    while leaving `budget` alone, so a team that spent out ended at
  //    need=1/budget=$0 — and resolveStalledNomination (the one nomination path
  //    with no affordability check) would then open a $1 lot it can't pay for and
  //    drive the budget negative. Refunding also makes the post-draft budget
  //    figure honest instead of counting a player who has gone.
  // 2. CANCEL cover for the seat. StandinAssignment rows keyed to this player as
  //    `replacingUserId` outlive them, and matchNightRoster removes the covered
  //    player from the base roster before appending the standin — so once the
  //    covered player is gone the filter removes nobody and the side is computed
  //    one too large (five plus a standin in a 5v5). That inflated number feeds
  //    /schedule, the dashboard strip and the Discord week reminder, and the
  //    admin's uncovered-OUT alert can't catch it because it only looks at
  //    current roster members.
  // 3. Announce the release, as before.
  let releaseResult: {
    cancelled: number;
    kept: number;
    standDowns: {
      id: string;
      standinUserId: string;
      standin: { name: string; discordId: string | null };
      match: {
        games: { id: string }[];
        week: number;
        phase: string;
        homeTeam: { name: string };
        awayTeam: { name: string };
      };
    }[];
    teamName: string;
  };
  try {
    releaseResult = await prisma.$transaction(
      async (tx) => {
        const [currentSeason, currentDraft] = await Promise.all([
          tx.season.findUnique({ where: { id: season.id } }),
          tx.draft.findUnique({ where: { seasonId: season.id } }),
        ]);
        if (
          !currentSeason?.isActive ||
          currentSeason.status === SEASON_STATUS.SIGNUPS ||
          currentSeason.status === SEASON_STATUS.COMPLETE ||
          (currentSeason.status === SEASON_STATUS.DRAFT &&
            currentDraft?.status !== DRAFT_STATUS.COMPLETE)
        ) {
          throw new Error("ROSTER_LIFECYCLE_CHANGED");
        }
        // THE claim, and the FIRST write — a deleteMany re-asserting the row still
        // exists, never a raw delete: two releases racing (second tab, second
        // admin) made the loser die on an unhandled P2025 (the undoLastSale
        // lesson), and a `return` here after later writes would COMMIT them, so
        // the zero-count case THROWS and rolls the transaction back whole.
        const gone = await tx.teamMember.deleteMany({
          where: {
            id: member.id,
            seasonId: season.id,
            isCaptain: false,
            // Team.captainId is authoritative. A transfer that promoted this row
            // after the page rendered must beat the stale Release instead of being
            // left pointing at a roster seat this transaction deleted.
            team: { captainId: { not: member.userId } },
          },
        });
        if (gone.count === 0) {
          const current = await tx.teamMember.findUnique({
            where: { id: member.id },
            select: { isCaptain: true, team: { select: { captainId: true } } },
          });
          if (current?.isCaptain || current?.team.captainId === member.userId) {
            throw new Error("CAPTAINCY_CHANGED");
          }
          throw new Error("ALREADY_RELEASED");
        }
        // Only cover on a series that hasn't started. Once a game is imported the
        // assignment is load-bearing for the REST of that series: gatherTeamAccounts
        // re-reads StandinAssignment on every import, so deleting it mid-Bo3 drops
        // the standin from the team's account set for games 2 and 3 — their lines get
        // stored with a null teamId, and if the side falls under classifyGame's
        // recognizable-account floor the later games stop importing altogether. This
        // is exactly the deletion removeStandinGuarded refuses ("would strip them
        // from the rest of the series"); do not let release do it by the back door.
        const covering = await tx.standinAssignment.findMany({
          where: {
            replacingUserId: member.userId,
            match: {
              seasonId: season.id,
              status: { not: MATCH_STATUS.COMPLETED },
            },
          },
          // The standin + fixture fields are carried so the STAND-DOWN can be
          // announced below. Being told to turn up for a game is the most
          // action-demanding message this league sends, and release was the one
          // path that cancelled such a booking in silence — the standin kept a
          // live Discord instruction (with an @mention) for a match they had been
          // removed from, and nothing ever corrected it. Both removeStandin and
          // captainRemoveStandin have always sent this.
          select: {
            id: true,
            standinUserId: true,
            standin: { select: { name: true, discordId: true } },
            match: {
              select: {
                games: { select: { id: true }, take: 1 },
                week: true,
                phase: true,
                homeTeam: { select: { name: true } },
                awayTeam: { select: { name: true } },
              },
            },
          },
        });
        const removable = covering.filter((a) => a.match.games.length === 0);
        let cancelled = 0;
        if (removable.length) {
          // The "no games imported yet" condition rides in the WHERE, not just in
          // the JS filter above: on Postgres READ COMMITTED a series can acquire
          // its first game between the findMany and this delete, and dropping
          // cover mid-series is precisely what removeStandinGuarded refuses.
          // The toast counts what the DELETE actually matched, so it can never
          // claim a cancellation the predicate refused.
          ({ count: cancelled } = await tx.standinAssignment.deleteMany({
            where: {
              id: { in: removable.map((s) => s.id) },
              match: { games: { none: {} } },
            },
          }));
        }
        if (member.price > 0) {
          await tx.team.update({
            where: { id: member.teamId },
            data: { budget: { increment: member.price } },
          });
        }
        return {
          // What the DELETE actually matched — never what the JS filter hoped.
          cancelled,
          kept: covering.length - cancelled,
          // Only announce if the DELETE really took them all; if the predicate
          // refused some row we cannot tell which, and telling a standin to stand
          // down from a game they are still booked for is worse than silence.
          standDowns: cancelled === removable.length ? removable : [],
          teamName: member.team.name,
        };
      },
      // SERIALIZABLE — release and assignStandinGuarded are a write-skew pair
      // (release reads the assignments and deletes the TeamMember; assign
      // reads the TeamMember and creates an assignment), and SSI only spots
      // the cycle when EVERY participant is serializable. At read-committed
      // both commit and the cover-cancel misses the assignment landing in the
      // gap: a stale row matchNightRoster counts as a SIXTH player, whose
      // stand-down announcement structurally never fired.
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if ((e as Error).message === "ROSTER_LIFECYCLE_CHANGED") {
      return {
        error:
          "The season or auction just changed — releases are locked until the auction is complete.",
      };
    }
    if ((e as Error).message === "CAPTAINCY_CHANGED") {
      return {
        error: `${member.user.name} was just made captain — reload before changing this roster.`,
      };
    }
    if ((e as Error).message === "ALREADY_RELEASED") {
      return {
        error: `${member.user.name} was already released — reload to see the roster`,
      };
    }
    if ((e as { code?: string }).code === "P2034") {
      return {
        error:
          "The roster changed while you were releasing — reload and try again",
      };
    }
    throw e;
  }
  const { cancelled, kept, standDowns, teamName } = releaseResult;

  await logAdminAction({
    action: "releasePlayer",
    summary: `Released ${member.user.name} from ${member.team.name}; refunded $${member.price} and cancelled ${cancelled} standin assignment(s)`,
    seasonId: season.id,
  });

  await sendDiscordMessage(
    playerReleasedMessage(member.user.name, member.team.name),
    // @-mention the released player. This was a bare broadcast while the
    // stand-down loop right below it — and signFreeAgent, and both
    // removeStandin paths — all mention their subject. Release is the most
    // personal roster event the league produces, and the person it happens to
    // was the one participant not told: they found out when the "Your team"
    // block vanished from /me. `member` is loaded with its user, so the
    // snowflake is already in hand.
    mentionsOf([member.user.discordId]),
  );
  // Post-commit, best-effort, one per cancelled booking — same shape and same
  // formatter the two removeStandin paths use, so a standin can never be left
  // holding an instruction for a match they were quietly dropped from.
  for (const a of standDowns) {
    await sendDiscordMessage(
      standinRemovedMessage({
        standinName: a.standin.name,
        teamName,
        homeName: a.match.homeTeam.name,
        awayName: a.match.awayTeam.name,
        week: a.match.week,
        isPlayoff: a.match.phase !== MATCH_PHASE.REGULAR,
      }),
      mentionsOf([a.standin.discordId]),
    );
  }
  refresh();
  const extra = [
    member.price > 0
      ? `$${member.price} refunded to ${member.team.name}`
      : null,
    cancelled > 0
      ? `${cancelled} standin assignment(s) covering them cancelled — re-cover those matches`
      : null,
    // Left in place on purpose; the admin still needs to know it's there.
    // NOT "remove by hand": removeStandinGuarded refuses once games are
    // imported, so that advice sent the admin in a circle — the truthful
    // statement is that the booking is settled for the rest of the series.
    kept > 0
      ? `${kept} assignment(s) on an already-started series stay in place — the remaining games record whoever actually plays`
      : null,
    // Release deliberately keeps the registration ACTIVE (release + sign =
    // trade), so a true QUITTER is now the league's phantom free agent —
    // offered in every standin dropdown and counted by the capacity math —
    // unless the admin also runs the remove step, which nothing else at this
    // point of use mentions.
    "if they've left the league entirely, also remove their signup (Captains & draft) so they drop out of the free-agent and standin pools",
  ].filter(Boolean);
  return {
    message:
      `${member.user.name} released from ${member.team.name}` +
      (extra.length ? ` · ${extra.join(" · ")}` : ""),
  };
}

/**
 * A whole TEAM quits mid-season — the most common amateur-league disaster,
 * which used to be an unassisted grind: hand-typing a forfeit score for every
 * remaining fixture, week after week, while the dead team stayed in the
 * standings math, pick'em, the reminders, and — because seeding never asked —
 * got seeded into the playoff bracket on its banked points.
 *
 * One action: every unplayed REGULAR fixture is forfeited 0-N to the opponent
 * (forfeit=true, so the ruled scores stay out of the gameDiff tiebreak and the
 * power rankings), open reschedule proposals on them are cancelled, and the
 * team is flagged `withdrawn` — which is what excludes it from playoff
 * seeding (createPlayoffBracket filters the flag; standings could not do that
 * job, since a team that banked points before dying can out-rank the cut).
 * Rosters, results and history are KEPT: the games happened.
 *
 * Recovery: reinstateTeam flips the flag back, and each forfeited fixture is
 * individually reversible via "Reopen for import" (forfeits have no games).
 */
export async function withdrawTeam(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this team-withdrawal control was open — reload before changing a team.",
    };
  }
  const lockedReason = teamWithdrawalLockedReason(season.status);
  if (lockedReason) return { error: lockedReason };
  const teamId = str(formData, "teamId");

  // This first read is presentation-only: it lets the success message say a
  // fixture completed for real while the admin was clicking. The transaction
  // below re-reads every authoritative row after claiming the Season.
  const observedOpen = await prisma.match.findMany({
    where: {
      seasonId: season.id,
      phase: MATCH_PHASE.REGULAR,
      status: { not: MATCH_STATUS.COMPLETED },
      OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
    },
    select: { id: true },
  });

  // Seam: the rival must COMMIT before the transaction below opens, which is
  // exactly the auto-sync or lifecycle-switch case (a separate request that
  // already finished). The transaction's fresh reads decide the mutation.
  await raceHook("admin.withdrawTeam.beforeTx");
  let withdrawal;
  try {
    withdrawal = await prisma.$transaction(
      async (tx) => {
        // This is the cross-aggregate enforcement point. Claiming Season
        // BEFORE Team/Match gives archive, phase, schedule, result, and team
        // operations one ordering row; a plain season read would not conflict
        // with an archive that only writes Season.
        if (!(await claimTeamWithdrawalSeason(tx, expectedActiveSeasonId))) {
          throw new TeamWithdrawalLifecycleChangedError();
        }

        const [team, open, observedNow] = await Promise.all([
          tx.team.findFirst({
            where: { id: teamId, seasonId: expectedActiveSeasonId },
          }),
          tx.match.findMany({
            where: {
              seasonId: expectedActiveSeasonId,
              phase: MATCH_PHASE.REGULAR,
              status: { not: MATCH_STATUS.COMPLETED },
              OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
            },
            select: {
              id: true,
              week: true,
              status: true,
              scheduledAt: true,
              bestOf: true,
              homeTeamId: true,
              awayTeamId: true,
            },
          }),
          tx.match.findMany({
            where: { id: { in: observedOpen.map((match) => match.id) } },
            select: { id: true, status: true },
          }),
        ]);
        if (!team) throw new CaptainStateChangedError();

        // THE enforcement point for "not already withdrawn". Throwing here
        // rolls back the Season claim too; the former array transaction ran
        // all forfeit writes even when this count was zero, then merely
        // returned an error after commit.
        const flagged = await tx.team.updateMany({
          where: {
            id: teamId,
            seasonId: expectedActiveSeasonId,
            withdrawn: false,
          },
          data: { withdrawn: true },
        });
        if (flagged.count === 0) {
          throw new TeamAlreadyWithdrawnError(team.name);
        }

        // Standins booked on the doomed fixtures become inert history when
        // those matches are ruled. Carry the rows out so the post-commit path
        // can stand each person down by name.
        const mootCover = await tx.standinAssignment.findMany({
          where: { matchId: { in: open.map((match) => match.id) } },
          select: {
            matchId: true,
            teamId: true,
            standin: { select: { name: true, discordId: true } },
            match: {
              select: {
                week: true,
                phase: true,
                homeTeam: { select: { name: true } },
                awayTeam: { select: { name: true } },
              },
            },
          },
        });

        const matchClaims: { count: number }[] = [];
        for (const match of open) {
          const matchClaim = await tx.match.updateMany({
            where: {
              id: match.id,
              status: { not: MATCH_STATUS.COMPLETED },
            },
            data: {
              status: MATCH_STATUS.COMPLETED,
              forfeit: true,
              completedAt: new Date(),
              homeScore:
                match.homeTeamId === teamId ? 0 : forfeitScore(match.bestOf),
              awayScore:
                match.awayTeamId === teamId ? 0 : forfeitScore(match.bestOf),
              winnerTeamId:
                match.homeTeamId === teamId
                  ? match.awayTeamId
                  : match.homeTeamId,
            },
          });
          matchClaims.push(matchClaim);
          if (matchClaim.count === 1) {
            if (match.status === MATCH_STATUS.SCHEDULED && match.scheduledAt) {
              await invalidatePendingAnnouncementMarkers(
                tx,
                weekReminderKey(
                  expectedActiveSeasonId,
                  match.week,
                  match.scheduledAt.getTime(),
                ),
              );
            }
            // The single team-withdrawal broadcast replaces noisy per-series
            // result posts. Persist that decision with the result so generic
            // completedAt crash recovery cannot replay these ruled fixtures;
            // updating also invalidates any impossible stale queued source.
            const value = `suppressed:team-withdrawal:${new Date().toISOString()}`;
            await tx.setting.upsert({
              where: { key: resultAnnouncedKey(match.id) },
              create: { key: resultAnnouncedKey(match.id), value },
              update: { value },
            });
          }
        }
        await tx.rescheduleRequest.updateMany({
          where: {
            matchId: { in: open.map((match) => match.id) },
            status: "PENDING",
          },
          data: { status: "CANCELLED" },
        });
        await stampResultChange(tx);

        return {
          team,
          open,
          mootCover,
          matchClaims,
          // Matches that completed after the presentation read but before the
          // transaction are not in `open`; retain the old truthful toast note.
          completedBeforeClaim: observedNow.filter(
            (match) => match.status === MATCH_STATUS.COMPLETED,
          ).length,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof CaptainStateChangedError) {
      return { error: "Unknown team" };
    }
    if (error instanceof TeamAlreadyWithdrawnError) {
      return { error: `${error.message} has already withdrawn` };
    }
    if (
      error instanceof TeamWithdrawalLifecycleChangedError ||
      (error as { code?: string }).code === "P2034"
    ) {
      return {
        error:
          "The active season or its phase changed while this withdrawal was open — reload before changing the team.",
      };
    }
    throw error;
  }

  const { team, open, mootCover, matchClaims, completedBeforeClaim } =
    withdrawal;
  const forfeited = matchClaims.reduce((n, r) => n + r.count, 0);
  const raced = open.length - forfeited + completedBeforeClaim;

  // Forfeits can close out whole weeks — honors are idempotent and quiet for
  // weeks with nothing imported, so firing per affected week is safe.
  for (const week of [...new Set(open.map((m) => m.week))]) {
    await maybeAnnounceWeekHonors(season.id, week);
  }
  // Stand the booked standins down BEFORE the broadcast, so the personal
  // correction lands ahead of the news. Post-commit and best-effort (the
  // house shape). Only bookings on fixtures whose forfeit claim actually WON:
  // matchClaims is index-aligned with `open`, so a fixture that completed for
  // real mid-click (count 0) keeps its booking un-stood-down — that series
  // happened, and its standin may well have played it.
  const forfeitedIds = new Set(
    open.filter((_, i) => matchClaims[i].count > 0).map((m) => m.id),
  );
  const teamNameOf = new Map<string, string>();
  for (const t of await prisma.team.findMany({
    where: { seasonId: season.id },
    select: { id: true, name: true },
  })) {
    teamNameOf.set(t.id, t.name);
  }
  const stoodDown = mootCover.filter((a) => forfeitedIds.has(a.matchId));
  for (const a of stoodDown) {
    await sendDiscordMessage(
      standinRemovedMessage({
        standinName: a.standin.name,
        teamName: teamNameOf.get(a.teamId) ?? "their team",
        homeName: a.match.homeTeam.name,
        awayName: a.match.awayTeam.name,
        week: a.match.week,
        isPlayoff: a.match.phase !== MATCH_PHASE.REGULAR,
      }),
      mentionsOf([a.standin.discordId]),
    );
  }
  await sendDiscordMessage(teamWithdrewMessage(team.name, forfeited));
  await logAdminAction({
    action: "withdrawTeam",
    summary: `Withdrew ${team.name} — ${forfeited} remaining fixture(s) forfeited to the opponents${raced ? ` (${raced} completed for real mid-flight and kept their result)` : ""}`,
    seasonId: season.id,
  });
  refresh();
  const notes = [
    `${forfeited} fixture(s) forfeited to the opponents`,
    raced
      ? `${raced} completed for real while you clicked and kept their result`
      : null,
    stoodDown.length
      ? `${stoodDown.length} standin booking(s) on those fixtures stood down`
      : null,
    "excluded from playoff seeding · rosters and played results are kept",
    // The withdrawn team's players are the league's most natural standin pool
    // — but rostered players can't stand in, and nothing else at the point of
    // use says release is the unlock.
    "release their players (Roster moves) to free them for standin duty or signing elsewhere",
  ].filter(Boolean);
  return { message: `${team.name} withdrawn · ${notes.join(" · ")}` };
}

/** The undo for the flag half of withdrawTeam. The forfeited fixtures are
 *  reversed individually ("Reopen for import" — forfeits carry no games). */
export async function reinstateTeam(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this reinstatement control was open — reload before changing a team.",
    };
  }
  const lockedReason = teamWithdrawalLockedReason(season.status);
  if (lockedReason) return { error: lockedReason };
  const teamId = str(formData, "teamId");
  await raceHook("admin.reinstateTeam.beforeTx");
  let teamName: string;
  try {
    teamName = await prisma.$transaction(
      async (tx) => {
        if (!(await claimTeamWithdrawalSeason(tx, expectedActiveSeasonId))) {
          throw new TeamWithdrawalLifecycleChangedError();
        }
        const team = await tx.team.findFirst({
          where: { id: teamId, seasonId: expectedActiveSeasonId },
          select: { name: true },
        });
        if (!team) throw new CaptainStateChangedError();
        const flipped = await tx.team.updateMany({
          where: {
            id: teamId,
            seasonId: expectedActiveSeasonId,
            withdrawn: true,
          },
          data: { withdrawn: false },
        });
        if (flipped.count === 0) throw new TeamNotWithdrawnError();
        return team.name;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof CaptainStateChangedError) {
      return { error: "Unknown team" };
    }
    if (error instanceof TeamNotWithdrawnError) {
      return { error: "That team isn't withdrawn" };
    }
    if (
      error instanceof TeamWithdrawalLifecycleChangedError ||
      (error as { code?: string }).code === "P2034"
    ) {
      return {
        error:
          "The active season or its phase changed while this reinstatement was open — reload before changing the team.",
      };
    }
    throw error;
  }
  await logAdminAction({
    action: "reinstateTeam",
    summary: `Reinstated ${teamName} — back in playoff-seeding contention`,
    seasonId: season.id,
  });
  refresh();
  return {
    message: `${teamName} reinstated — reverse any forfeits you want undone with "Reopen for import" on each fixture`,
  };
}

/** Assign a standin to fill in for a rostered player in a specific match.
 *  Guards live in standin-service (shared with the captain self-serve path). */
export async function assignStandin(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  // One select carries both cases: a userId covers that player, `seat:<teamId>`
  // fills an EMPTY seat on a short roster (replacing nobody).
  const target = str(formData, "replacingUserId");
  const seat = parseSeatTarget(target);
  const res = await assignStandinGuarded({
    matchId: str(formData, "matchId"),
    standinUserId: str(formData, "standinUserId"),
    replacingUserId: seat ? null : target,
    teamId: seat ?? undefined,
    actingCaptainId: null, // admin override — either team
  });
  if (!res.ok) return { error: res.error };
  // The standin must HEAR about their game night — best-effort, never blocks.
  await sendDiscordMessage(res.announcement, res.mentions);
  await logAdminAction({
    action: "assignStandin",
    summary: `${res.message} (match ${str(formData, "matchId")})`,
  });
  refresh();
  // If the announcement structurally can't reach them (unlinked, not in the
  // server, stuck behind the rules screen), the person arranging the cover
  // finds out NOW, not on match night. "" when reachable or unknowable.
  return {
    message:
      res.message + (await reachabilityNote(str(formData, "standinUserId"))),
  };
}

/** Remove a standin assignment. */
export async function removeStandin(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await removeStandinGuarded({
    assignmentId: str(formData, "assignmentId"),
    actingCaptainId: null,
  });
  if (!res.ok) return { error: res.error };
  await sendDiscordMessage(res.announcement, res.mentions);
  await logAdminAction({
    action: "removeStandin",
    summary: `${res.message} (assignment ${str(formData, "assignmentId")})`,
  });
  refresh();
  return { message: res.message };
}

/** Import a specific Dota game (by id or URL) into a scheduled match. */
export async function importGameAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let admin: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    admin = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const matchId = str(formData, "matchId");
  const dotaMatchId = parseMatchId(str(formData, "dotaMatchRef"));
  if (!dotaMatchId) return { error: "Enter a valid match id or URL" };
  const res = await importGameForMatch(matchId, dotaMatchId, {
    providerActorId: admin.id,
  });
  if (!res.ok) return { error: res.error };
  await logAdminAction({
    action: "importGameAction",
    summary: `Imported Dota match ${dotaMatchId} into match ${matchId}`,
  });
  refreshGames();
  return { ok: true, message: "Game imported" };
}

/** Auto-detect a scheduled match's games from the rosters' recent games. */
export async function autoDetectAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const matchId = str(formData, "matchId");
  // The admin's explicit override: this button ignores the removal memory, so a
  // game removed by mistake is one click from coming back. Only the automatic
  // paths are held to it.
  const res = await autoDetectGamesForMatch(matchId, { ignoreSkips: true });
  if (res.error) return { error: res.error };
  refreshGames();
  // "imported 0 game(s)" is the same sentence whether nobody has played yet,
  // everyone has public match data switched off, or OpenDota was simply down —
  // and those need three different responses from the admin. `unreachable`
  // already distinguishes the third (it is why the inhouse detect button can
  // blame OpenDota honestly); this path was throwing it away and reporting a
  // failed scan as a successful empty one.
  if (res.imported === 0 && res.unreachable) {
    return {
      error:
        "Couldn't reach OpenDota for some players, so this scan proves nothing — try again in a minute.",
    };
  }
  if (res.imported > 0) {
    await logAdminAction({
      action: "autoDetectAction",
      summary: `Auto-detected ${res.imported} game(s) for match ${matchId} after scanning ${res.scanned} player(s)`,
    });
  }
  return {
    ok: true,
    message:
      res.imported === 0
        ? `Scanned ${res.scanned} players · no matching games found yet. If the game has been played, check the players have "Expose Public Match Data" on, or add it by match ID.`
        : `Scanned ${res.scanned} players · imported ${res.imported} game(s)`,
  };
}

/**
 * Un-complete a match that was scored by hand, so its real games can be
 * imported after all.
 *
 * A manually recorded result sets the match COMPLETED with zero Game rows, and
 * every import path then refuses it forever (importGameForMatch's
 * COMPLETED-with-no-games guard, auto-detect, league sync, result-sync, and the
 * captain report card). Only recomputeSeries can reset the status and it is
 * reachable solely from removeGame — which needs a Game row that, by
 * definition, doesn't exist. So a stray score (the score boxes default to 0 and
 * Enter submits the row) permanently cost that series its box score, per-player
 * stats, fantasy points, hero meta, record-book entries and per-game Elo.
 *
 * Refuses once games exist (use "remove" on the game instead) and inherits
 * removeGame's bracket guards, since un-completing an advanced playoff series
 * would strand the wrong team downstream.
 */
export async function reopenMatch(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const matchId = str(formData, "matchId");
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();

  let reopened: { seasonId: string; week: number; uncrownedFinal: boolean };
  try {
    reopened = await prisma.$transaction(
      async (tx) => {
        const match = await tx.match.findUnique({
          where: { id: matchId },
          select: {
            id: true,
            seasonId: true,
            phase: true,
            homeTeamId: true,
            awayTeamId: true,
            week: true,
            scheduledAt: true,
            bracketSlot: true,
            status: true,
            _count: { select: { games: true } },
            season: {
              select: {
                isActive: true,
                status: true,
                championTeamId: true,
              },
            },
          },
        });
        if (!match) throw new ResultWriteError("Unknown match");
        if (
          expectedActiveSeasonId &&
          match.seasonId !== expectedActiveSeasonId
        ) {
          throw new ResultWriteError(
            "The active season changed while this result form was open — reload and try again.",
          );
        }
        if (!match.season.isActive) {
          throw new ResultWriteError(
            "This match belongs to an archived season — reactivate it before correcting historical results.",
          );
        }
        const crownedFinalCorrection =
          match.phase === MATCH_PHASE.FINAL &&
          match.season.status === SEASON_STATUS.COMPLETE &&
          match.status === MATCH_STATUS.COMPLETED &&
          match.season.championTeamId != null &&
          (match.season.championTeamId === match.homeTeamId ||
            match.season.championTeamId === match.awayTeamId);
        if (
          match.phase !== MATCH_PHASE.REGULAR &&
          match.season.status === SEASON_STATUS.COMPLETE &&
          !crownedFinalCorrection
        ) {
          throw new ResultWriteError(
            seasonCompleteError(match.season.championTeamId),
          );
        }
        if (
          !crownedFinalCorrection &&
          !matchResultsOpen(match.season.status, match.phase)
        ) {
          throw new ResultWriteError(
            match.phase === MATCH_PHASE.REGULAR
              ? "Regular-season results can only change during the active Regular season phase."
              : "Playoff results can only change while the active season is in Playoffs.",
          );
        }
        if (match.status !== MATCH_STATUS.COMPLETED) {
          throw new ResultWriteError("That match isn't marked final");
        }
        if (match._count.games > 0) {
          throw new ResultWriteError(
            "This match has imported games — remove those instead; the series recomputes itself",
          );
        }

        // Bracket advancement and this correction must share one Serializable
        // snapshot. Otherwise a later round can appear after the guard but
        // before the reopen, stranding the old winner downstream.
        if (match.phase !== MATCH_PHASE.REGULAR) {
          const playoffs = await tx.match.findMany({
            where: {
              seasonId: match.seasonId,
              phase: { not: MATCH_PHASE.REGULAR },
            },
            select: { id: true, bracketSlot: true },
          });
          const latestRound = Math.max(
            ...playoffs.map((row) => slotRound(row.bracketSlot)),
          );
          const latest = playoffs.filter(
            (row) => slotRound(row.bracketSlot) === latestRound,
          );
          if (
            crownedFinalCorrection &&
            (latest.length !== 1 || latest[0]?.id !== match.id)
          ) {
            throw new ResultWriteError(
              "This is not the authoritative grand final — reload before correcting the championship",
            );
          }
          if (hasLaterBracketRound(playoffs, match.bracketSlot)) {
            throw new ResultWriteError(
              "This playoff series already advanced the bracket — recreate the bracket to correct it",
            );
          }
        }

        await raceHook("admin.reopenMatch.beforeWrite");

        // Keep the write predicates even though they were just read. They make
        // double-submit and import races explicit and prevent a blind reset if
        // another command changed the row within this transaction's lifetime.
        const claimed = await tx.match.updateMany({
          where: {
            id: match.id,
            status: MATCH_STATUS.COMPLETED,
            games: { none: {} },
            season: {
              isActive: true,
              status: match.season.status,
            },
          },
          data: {
            status: MATCH_STATUS.SCHEDULED,
            homeScore: 0,
            awayScore: 0,
            winnerTeamId: null,
            forfeit: false,
            autoSyncedAt: null,
            autoSyncAttempts: 0,
            completedAt: null,
          },
        });
        if (claimed.count === 0) {
          throw new ResultWriteError(
            "That match or its games just changed — reload before reopening it.",
          );
        }

        if (match.scheduledAt) {
          await invalidatePendingAnnouncementMarkers(
            tx,
            weekReminderKey(
              match.seasonId,
              match.week,
              match.scheduledAt.getTime(),
            ),
          );
        }

        if (crownedFinalCorrection) {
          const uncrowned = await tx.season.updateMany({
            where: {
              id: match.seasonId,
              isActive: true,
              status: SEASON_STATUS.COMPLETE,
              championTeamId: match.season.championTeamId,
            },
            data: {
              status: SEASON_STATUS.PLAYOFFS,
              championTeamId: null,
            },
          });
          if (uncrowned.count !== 1) {
            throw new ResultWriteError(
              "The champion or season phase just changed — reload before correcting the final.",
            );
          }
          await tx.setting.deleteMany({
            where: { key: championAnnouncedKey(match.seasonId) },
          });
        }

        // The retraction, its series-announcement release, the weekly-honors
        // stale marker, and the cursor that refreshes other tabs are one
        // command. A crash cannot expose a reopened result while derived
        // coordination state still presents its old awards as authoritative.
        await tx.setting.deleteMany({
          where: { key: resultAnnouncedKey(match.id) },
        });
        if (match.phase === MATCH_PHASE.REGULAR) {
          await markWeekHonorsStale(tx, match.seasonId, match.week);
        }
        const changedAt = new Date().toISOString();
        await tx.setting.upsert({
          where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
          create: { key: SETTING_KEYS.RESULT_CHANGED_AT, value: changedAt },
          update: { value: changedAt },
        });
        return {
          seasonId: match.seasonId,
          week: match.week,
          uncrownedFinal: crownedFinalCorrection,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof ResultWriteError) return { error: error.message };
    if ((error as { code?: string }).code === "P2034") {
      return {
        error:
          "The match, phase, or playoff bracket changed while you reopened it — reload and try again.",
      };
    }
    throw error;
  }

  await logAdminAction({
    action: "reopenMatch",
    summary: `${reopened.uncrownedFinal ? "Un-crowned the champion and reopened the grand final" : `Reopened a week ${reopened.week} match that had been marked final`}`,
    seasonId: reopened.seasonId,
  });
  refreshGames();
  return {
    message: reopened.uncrownedFinal
      ? "Champion retracted and grand final reopened — correct the result to crown the winner again"
      : "Match reopened — its games can be imported now",
  };
}

/** Remove an imported game and recompute the series. */
export async function removeGame(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const gameId = str(formData, "gameId");
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: {
      match: {
        include: {
          season: {
            select: {
              isActive: true,
              status: true,
              championTeamId: true,
            },
          },
        },
      },
    },
  });
  if (!game) return { error: "That game is already gone" };
  const correctingCrownedFinal =
    game.match.phase === MATCH_PHASE.FINAL &&
    game.match.status === MATCH_STATUS.COMPLETED &&
    game.match.season.status === SEASON_STATUS.COMPLETE &&
    game.match.season.championTeamId != null &&
    (game.match.season.championTeamId === game.match.homeTeamId ||
      game.match.season.championTeamId === game.match.awayTeamId);
  if (
    !game.match.season.isActive ||
    (!correctingCrownedFinal &&
      !matchResultsOpen(game.match.season.status, game.match.phase))
  ) {
    return {
      error:
        game.match.phase === MATCH_PHASE.REGULAR
          ? "Regular-season results can only change during the active Regular season phase."
          : "Playoff results can only change while the active season is in Playoffs.",
    };
  }

  // Remember the removal BEFORE deleting the row. Both importers decide
  // "already recorded" from the Game rows themselves, so without this the next
  // /api/sync ping — from any page view, the admin's own tab included — simply
  // re-imported the game, undoing the correction inside a minute with no error
  // anywhere. Skip-first is what closes the gap: while the row still exists the
  // unique dotaMatchId refuses a racing import, so there is no instant in which
  // the game is both importable and unremembered.
  await rememberImportSkip(game.match.seasonId, game.dotaMatchId);

  let corrected: {
    matchId: string;
    seasonId: string;
    week: number;
    phase: string;
    homeTeamId: string;
    awayTeamId: string;
    projection: ReturnType<typeof deriveSeriesProjection>;
    uncrownedFinal: boolean;
  };
  try {
    corrected = await prisma.$transaction(
      async (tx) => {
        const fresh = await tx.game.findUnique({
          where: { id: gameId },
          select: {
            id: true,
            dotaMatchId: true,
            match: {
              select: {
                id: true,
                seasonId: true,
                week: true,
                scheduledAt: true,
                phase: true,
                bracketSlot: true,
                status: true,
                bestOf: true,
                homeTeamId: true,
                awayTeamId: true,
                games: { select: { id: true, winnerTeamId: true } },
                season: {
                  select: {
                    isActive: true,
                    status: true,
                    championTeamId: true,
                    fantasyLockedAt: true,
                  },
                },
              },
            },
          },
        });
        if (!fresh || fresh.dotaMatchId !== game.dotaMatchId) {
          throw new ResultWriteError("That game is already gone");
        }
        const match = fresh.match;
        const correctingFinalNow =
          match.phase === MATCH_PHASE.FINAL &&
          match.status === MATCH_STATUS.COMPLETED &&
          match.season.status === SEASON_STATUS.COMPLETE &&
          match.season.championTeamId != null &&
          (match.season.championTeamId === match.homeTeamId ||
            match.season.championTeamId === match.awayTeamId);
        if (
          !match.season.isActive ||
          (!correctingFinalNow &&
            !matchResultsOpen(match.season.status, match.phase))
        ) {
          throw new ResultWriteError(
            "The league phase changed — reload before correcting this result.",
          );
        }
        // Once a decided playoff series has advanced, changing its source
        // games would strand the old winner downstream. Read descendants and
        // delete the game in the same Serializable snapshot as advancement.
        if (
          match.phase !== MATCH_PHASE.REGULAR &&
          match.status === MATCH_STATUS.COMPLETED
        ) {
          const playoffs = await tx.match.findMany({
            where: {
              seasonId: match.seasonId,
              phase: { not: MATCH_PHASE.REGULAR },
            },
            select: { id: true, bracketSlot: true },
          });
          const latestRound = Math.max(
            ...playoffs.map((row) => slotRound(row.bracketSlot)),
          );
          const latest = playoffs.filter(
            (row) => slotRound(row.bracketSlot) === latestRound,
          );
          if (
            correctingFinalNow &&
            (latest.length !== 1 || latest[0]?.id !== match.id)
          ) {
            throw new ResultWriteError(
              "This is not the authoritative grand final — reload before correcting the championship",
            );
          }
          if (hasLaterBracketRound(playoffs, match.bracketSlot)) {
            throw new ResultWriteError(
              "This playoff series already advanced the bracket — recreate the bracket to correct it",
            );
          }
          if (
            match.season.status === SEASON_STATUS.COMPLETE &&
            !correctingFinalNow
          ) {
            throw new ResultWriteError(
              seasonCompleteError(match.season.championTeamId),
            );
          }
        }

        const projection = deriveSeriesProjection(
          match,
          match.games.filter((row) => row.id !== fresh.id),
        );
        // Backfill the durable Fantasy lock for seasons whose games predate
        // the marker. Removing the last imported game is a correction, not a
        // way to reopen roster selection after its stats were already public.
        if (!match.season.fantasyLockedAt) {
          await tx.season.updateMany({
            where: { id: match.seasonId, fantasyLockedAt: null },
            data: { fantasyLockedAt: new Date() },
          });
        }
        const removed = await tx.game.deleteMany({ where: { id: fresh.id } });
        if (removed.count === 0) {
          throw new ResultWriteError("That game is already gone");
        }
        await tx.match.update({
          where: { id: match.id },
          data: {
            homeScore: projection.homeScore,
            awayScore: projection.awayScore,
            winnerTeamId: projection.winnerTeamId,
            status: projection.status,
            forfeit: false,
            completedAt: projection.decided ? new Date() : null,
          },
        });
        if (
          match.scheduledAt &&
          match.status !== MATCH_STATUS.SCHEDULED &&
          projection.status === MATCH_STATUS.SCHEDULED
        ) {
          await invalidatePendingAnnouncementMarkers(
            tx,
            weekReminderKey(
              match.seasonId,
              match.week,
              match.scheduledAt.getTime(),
            ),
          );
        }
        if (correctingFinalNow) {
          const uncrowned = await tx.season.updateMany({
            where: {
              id: match.seasonId,
              isActive: true,
              status: SEASON_STATUS.COMPLETE,
              championTeamId: match.season.championTeamId,
            },
            data: {
              status: SEASON_STATUS.PLAYOFFS,
              championTeamId: null,
            },
          });
          if (uncrowned.count !== 1) {
            throw new ResultWriteError(
              "The champion or season phase just changed — reload before correcting the final.",
            );
          }
          await tx.setting.deleteMany({
            where: { key: championAnnouncedKey(match.seasonId) },
          });
        }
        // A corrected result deserves a new series announcement; its week-wide
        // honors marker stays present but becomes stale below, so the eventual
        // replacement is explicitly labelled as a correction in Discord.
        await tx.setting.deleteMany({
          where: { key: resultAnnouncedKey(match.id) },
        });
        if (match.phase === MATCH_PHASE.REGULAR) {
          await markWeekHonorsStale(tx, match.seasonId, match.week);
        }
        const changedAt = new Date().toISOString();
        await tx.setting.upsert({
          where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
          create: { key: SETTING_KEYS.RESULT_CHANGED_AT, value: changedAt },
          update: { value: changedAt },
        });
        return {
          matchId: match.id,
          seasonId: match.seasonId,
          week: match.week,
          phase: match.phase,
          homeTeamId: match.homeTeamId,
          awayTeamId: match.awayTeamId,
          projection,
          uncrownedFinal: correctingFinalNow,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof ResultWriteError) return { error: error.message };
    if ((error as { code?: string }).code === "P2034") {
      return {
        error:
          "The result or playoff bracket changed while you removed that game — reload and try again.",
      };
    }
    throw error;
  }

  // The deletion is already committed. Expire every public game aggregate
  // before attempting Discord, honors, bracket, or audit follow-ups so a
  // transient secondary failure can never leave the removed game publicly
  // visible while the action misleadingly reports a generic failure.
  const followUpFailures: string[] = [];
  try {
    refreshGames();
  } catch {
    followUpFailures.push("public-stat cache refresh");
    console.error(
      "[removeGame] public-stat cache refresh failed (CACHE_REFRESH_FAILED)",
    );
  }

  const runFollowUp = async (label: string, effect: () => Promise<unknown>) => {
    try {
      await effect();
    } catch {
      followUpFailures.push(label);
      console.error(`[removeGame] ${label} failed (FOLLOW_UP_FAILED)`);
    }
  };

  let finalChampionConfirmed = false;
  if (corrected.projection.decided) {
    await runFollowUp("result announcement", () =>
      announceSeriesResultOnce({
        id: corrected.matchId,
        homeTeamId: corrected.homeTeamId,
        awayTeamId: corrected.awayTeamId,
        homeScore: corrected.projection.homeScore,
        awayScore: corrected.projection.awayScore,
        week: corrected.week,
        phase: corrected.phase,
      }),
    );
    if (
      corrected.phase !== MATCH_PHASE.REGULAR &&
      corrected.projection.winnerTeamId
    ) {
      if (corrected.uncrownedFinal) {
        // `advancePlayoffBracket` returning false is ambiguous: this caller may
        // have lost a harmless race to another caller that already committed
        // the same crown. Likewise, an exception after the removal commit must
        // not turn the completed deletion into a generic action failure. Read
        // the authoritative Season row before telling the admin what happened.
        try {
          await advancePlayoffBracket(corrected.seasonId);
        } catch {
          console.error(
            "[removeGame] champion re-crowning failed (BRACKET_ADVANCE_FAILED)",
          );
        }
        try {
          const season = await prisma.season.findUnique({
            where: { id: corrected.seasonId },
            select: { status: true, championTeamId: true },
          });
          finalChampionConfirmed =
            season?.status === SEASON_STATUS.COMPLETE &&
            season.championTeamId === corrected.projection.winnerTeamId;
          if (!finalChampionConfirmed) {
            followUpFailures.push("champion re-crowning");
          }
        } catch {
          followUpFailures.push("champion re-crowning verification");
          console.error(
            "[removeGame] champion re-crowning verification failed (VERIFY_FAILED)",
          );
        }
      } else {
        await runFollowUp("playoff bracket advancement", () =>
          advancePlayoffBracket(corrected.seasonId),
        );
      }
    } else if (corrected.phase === MATCH_PHASE.REGULAR) {
      await runFollowUp("weekly-honors reconciliation", () =>
        maybeAnnounceWeekHonors(corrected.seasonId, corrected.week),
      );
    }
  }
  await runFollowUp("admin audit log", () =>
    logAdminAction({
      action: "removeGame",
      summary: `Removed imported game ${game.dotaMatchId} from a week ${game.match.week} match`,
      seasonId: game.match.seasonId,
    }),
  );
  const followUpWarning =
    followUpFailures.length > 0
      ? ` The removal is saved, but ${followUpFailures.join(
          ", ",
        )} did not finish. Reload Admin and verify the corrected match before continuing.`
      : "";
  const message =
    corrected.uncrownedFinal && !corrected.projection.decided
      ? "Champion retracted and game removed — the grand final is open until the corrected series is decided."
      : corrected.uncrownedFinal && finalChampionConfirmed
        ? "Game removed — series recomputed; the corrected grand final is still decided, so the champion was re-crowned. Automatic sync won't re-import it; press \u201cAuto-fetch games\u201d on this match to add it back."
        : corrected.uncrownedFinal
          ? "Game removed — series recomputed; the corrected grand final is still decided, but champion re-crowning could not be confirmed. Automatic sync won't re-import it; press \u201cAuto-fetch games\u201d on this match to add it back."
          : "Game removed — series recomputed. Automatic sync won't re-import it; press \u201cAuto-fetch games\u201d on this match to add it back.";
  // Follow-ups can advance the bracket or create retryable announcements after
  // the early signal above. Queue another expiry before returning; an
  // in-flight cache fill is still bounded by the immutable hard wake.
  updateTag(AUTOMATION_GATE_TAG);
  return {
    message: `${message}${followUpWarning}`,
  };
}

/**
 * Move a whole week's match night (holiday, venue clash…): every scheduled
 * match in the week gets the new time; optionally later scheduled weeks shift
 * by the same delta so the weekly rhythm survives.
 */
export async function setWeekNight(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId) {
    return {
      error:
        "This week-move form is stale — reload before changing the schedule.",
    };
  }
  const week = Number(str(formData, "week"));
  const cascade = str(formData, "cascade") === "on";
  const night = localDate(formData, "night", "nightTs");
  if (!Number.isInteger(week) || week < 1) return { error: "Pick a week" };
  if (!night) return { error: "Pick a valid date & time" };

  await raceHook("admin.setWeekNight.beforeTx");
  let outcome: {
    seasonId: string;
    currentRetimed: number;
    laterRetimed: number;
    retimedIds: string[];
    rsvps: number;
    proposals: number;
    hadCanonicalNight: boolean;
  };
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        const [activeSeason, currentSeason, currentDraft] = await Promise.all([
          tx.season
            .findMany({
              where: { isActive: true },
              orderBy: { createdAt: "desc" },
              take: 2,
              select: { id: true },
            })
            .then(singleActiveSeason),
          tx.season.findUnique({
            where: { id: expectedActiveSeasonId },
            select: {
              id: true,
              isActive: true,
              status: true,
              firstMatchNight: true,
            },
          }),
          tx.draft.findUnique({
            where: { seasonId: expectedActiveSeasonId },
            select: { status: true },
          }),
        ]);
        if (
          activeSeason?.id !== expectedActiveSeasonId ||
          !currentSeason?.isActive
        ) {
          throw new ActiveSeasonChangedError();
        }
        if (!postAuctionWorkOpen(currentSeason.status, currentDraft?.status)) {
          throw new PostAuctionWorkLockedError();
        }

        // LIVE is deliberately excluded alongside COMPLETED. Once game one has
        // begun, moving the kickoff would rewrite the auto-sync window under an
        // in-progress series. Result entry/reopen controls own that state.
        const currentMatches = await tx.match.findMany({
          where: {
            seasonId: expectedActiveSeasonId,
            week,
            status: MATCH_STATUS.SCHEDULED,
          },
          orderBy: { id: "asc" },
        });
        if (currentMatches.length === 0) throw new ScheduledWeekEmptyError();

        // The delta later weeks shift by is measured from the week's CANONICAL
        // night — most common, earliest on a tie. A captain-rescheduled outlier
        // must not become the baseline for the rest of the season.
        const timeCounts = new Map<number, number>();
        for (const match of currentMatches) {
          if (!match.scheduledAt) continue;
          const time = match.scheduledAt.getTime();
          timeCounts.set(time, (timeCounts.get(time) ?? 0) + 1);
        }
        const current = [...timeCounts.entries()].sort(
          (a, b) => b[1] - a[1] || a[0] - b[0],
        )[0]?.[0];
        const delta = current == null ? 0 : night.getTime() - current;
        const laterMatches =
          cascade && current != null && delta !== 0
            ? await tx.match.findMany({
                where: {
                  seasonId: expectedActiveSeasonId,
                  week: { gt: week },
                  status: MATCH_STATUS.SCHEDULED,
                  scheduledAt: { not: null },
                },
                orderBy: [{ week: "asc" }, { id: "asc" }],
              })
            : [];

        const currentMoves = currentMatches
          .filter((match) => match.scheduledAt?.getTime() !== night.getTime())
          .map((match) => ({ match, scheduledAt: night }));
        const laterMoves = laterMatches.map((match) => ({
          match,
          scheduledAt: new Date(match.scheduledAt!.getTime() + delta),
        }));
        const moves = [...currentMoves, ...laterMoves];

        // A genuine no-op returns before touching any fixture-adjacent state.
        // Resubmitting the same time must not cost ten player check-ins or make a
        // settled reminder eligible to post twice.
        if (moves.length === 0) {
          return {
            seasonId: currentSeason.id,
            currentRetimed: 0,
            laterRetimed: 0,
            retimedIds: [],
            rsvps: 0,
            proposals: 0,
            hadCanonicalNight: current != null,
          };
        }

        for (const { match, scheduledAt } of moves) {
          const updated = await tx.match.updateMany({
            where: {
              id: match.id,
              seasonId: expectedActiveSeasonId,
              status: MATCH_STATUS.SCHEDULED,
              scheduledAt: match.scheduledAt,
            },
            data: { scheduledAt, autoSyncedAt: null, autoSyncAttempts: 0 },
          });
          if (updated.count !== 1) throw new ScheduleMatchChangedError();
        }

        // Keep the arithmetic anchor used for future playoff rounds aligned with
        // the moved league rhythm. If generation had no first night, derive the
        // missing week-1 anchor from the newly scheduled week.
        let firstMatchNight = currentSeason.firstMatchNight;
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        if (week === 1) {
          firstMatchNight = night;
        } else if (firstMatchNight && delta !== 0) {
          firstMatchNight = new Date(firstMatchNight.getTime() + delta);
        } else if (!firstMatchNight) {
          firstMatchNight = new Date(night.getTime() - (week - 1) * weekMs);
        }
        if (
          firstMatchNight?.getTime() !==
          currentSeason.firstMatchNight?.getTime()
        ) {
          const anchored = await tx.season.updateMany({
            where: { id: expectedActiveSeasonId, isActive: true },
            data: { firstMatchNight },
          });
          if (anchored.count !== 1) throw new ActiveSeasonChangedError();
        }

        const retimedIds = moves.map(({ match }) => match.id);
        const retimedWeeks = [...new Set(moves.map(({ match }) => match.week))];
        const [rsvps, proposals] = await Promise.all([
          tx.matchAvailability.deleteMany({
            where: { matchId: { in: retimedIds } },
          }),
          tx.rescheduleRequest.updateMany({
            where: { matchId: { in: retimedIds }, status: "PENDING" },
            data: { status: "CANCELLED" },
          }),
          // Reminder claims belong to the old kickoff and must be released in
          // the SAME commit as the retime. A crash cannot leave Discord pointing
          // at a time the database no longer uses.
          tx.setting.deleteMany({
            where: {
              OR: retimedWeeks.flatMap((retimedWeek) => {
                const base = weekReminderKey(
                  expectedActiveSeasonId,
                  retimedWeek,
                );
                return [{ key: base }, { key: { startsWith: `${base}:` } }];
              }),
            },
          }),
        ]);
        return {
          seasonId: currentSeason.id,
          currentRetimed: currentMoves.length,
          laterRetimed: laterMoves.length,
          retimedIds,
          rsvps: rsvps.count,
          proposals: proposals.count,
          hadCanonicalNight: current != null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof ActiveSeasonChangedError) {
      return {
        error:
          "The active season changed while this week-move form was open — reload before changing the schedule.",
      };
    }
    if (error instanceof PostAuctionWorkLockedError) {
      return {
        error:
          "Schedule changes are locked in this league phase — finish the auction, or reopen an active competition phase, then reload.",
      };
    }
    if (error instanceof ScheduledWeekEmptyError) {
      return { error: `Week ${week} has no scheduled matches to move` };
    }
    if (error instanceof ScheduleMatchChangedError) {
      return {
        error:
          "A match went live, finished, or was retimed while this move was being applied — nothing was changed. Reload and try again.",
      };
    }
    if ((error as { code?: string }).code === "P2034") {
      return {
        error:
          "The schedule changed while this week move was being applied — nothing was changed. Reload and try again.",
      };
    }
    throw error;
  }

  if (outcome.retimedIds.length === 0) {
    return {
      message:
        `Week ${week} kickoff unchanged` +
        (cascade
          ? outcome.hadCanonicalNight
            ? " · later weeks unchanged (no time change)"
            : " · couldn't cascade (week had no previous time)"
          : ""),
    };
  }

  // The retime, RSVP cleanup, proposal cancellation, and reminder release all
  // committed in the transaction above. Invalidate before logging and clash
  // detection so a later read failure cannot hide the new kickoff from cron.
  updateTag(AUTOMATION_GATE_TAG);

  // Counts only, no formatted datetime (the server-TZ rule): a week-wide
  // retime wipes RSVPs and open proposals — it belongs in the activity log.
  await logAdminAction({
    action: "setWeekNight",
    summary:
      `Moved week ${week}'s ${outcome.currentRetimed} scheduled match(es)` +
      (outcome.laterRetimed > 0
        ? ` and shifted ${outcome.laterRetimed} later match(es)`
        : "") +
      ` — cleared ${outcome.rsvps} check-in(s) and cancelled ${outcome.proposals} open proposal(s) on ${outcome.retimedIds.length} match(es)`,
    seasonId: outcome.seasonId,
  });
  // A retime can DOUBLE-BOOK a standin: standinConflict is checked when cover
  // is arranged, and moving a fixture onto a night the standin is already
  // booked for was never re-checked anywhere. Report it — the retime is the
  // legitimate act, the stale cover is the problem, and the captain who
  // arranged it is the one who has to fix it.
  const clashes = await clashesAfterRetime(
    outcome.seasonId,
    outcome.retimedIds,
  );
  refresh();
  return {
    ok: true,
    message:
      `Week ${week} moved (${outcome.currentRetimed} scheduled match${outcome.currentRetimed === 1 ? "" : "es"} retimed)` +
      (cascade
        ? outcome.laterRetimed > 0
          ? ` · ${outcome.laterRetimed} later match${outcome.laterRetimed === 1 ? "" : "es"} shifted with it`
          : outcome.hadCanonicalNight
            ? " · later weeks unchanged (no time change)"
            : " · couldn't cascade (week had no previous time)"
        : "") +
      ` · ${outcome.rsvps} check-in(s) cleared · ${outcome.proposals} open reschedule proposal(s) cancelled` +
      (clashes.length
        ? ` · ⚠ standin clash: ${clashes.join("; ")} — remove one of those assignments`
        : ""),
  };
}

/** Set or clear a match's scheduled date/time (from a datetime-local input). */
export async function setMatchTime(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId) {
    return {
      error: "This match-time form is stale — reload before changing kickoff.",
    };
  }
  const matchId = str(formData, "matchId");
  const raw = str(formData, "scheduledAt").trim();
  const scheduledAt = localDate(formData, "scheduledAt", "scheduledAtTs");
  if (raw && !scheduledAt) return { error: "Pick a valid date & time" };
  await raceHook("admin.setMatchTime.beforeTx");
  let outcome: {
    changed: boolean;
    seasonId: string;
    rsvps: number;
    proposals: number;
  };
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        const [activeSeason, currentSeason, currentDraft, before] =
          await Promise.all([
            tx.season
              .findMany({
                where: { isActive: true },
                orderBy: { createdAt: "desc" },
                take: 2,
                select: { id: true },
              })
              .then(singleActiveSeason),
            tx.season.findUnique({
              where: { id: expectedActiveSeasonId },
              select: { id: true, isActive: true, status: true },
            }),
            tx.draft.findUnique({
              where: { seasonId: expectedActiveSeasonId },
              select: { status: true },
            }),
            tx.match.findUnique({
              where: { id: matchId },
              select: {
                id: true,
                scheduledAt: true,
                seasonId: true,
                week: true,
                status: true,
              },
            }),
          ]);
        if (
          activeSeason?.id !== expectedActiveSeasonId ||
          !currentSeason?.isActive ||
          (before && before.seasonId !== expectedActiveSeasonId)
        ) {
          throw new ActiveSeasonChangedError();
        }
        if (!before) throw new UnknownScheduleMatchError();
        if (!postAuctionWorkOpen(currentSeason.status, currentDraft?.status)) {
          throw new PostAuctionWorkLockedError();
        }
        if (before.status !== MATCH_STATUS.SCHEDULED) {
          throw new ScheduleMatchChangedError();
        }

        const changed =
          before.scheduledAt?.getTime() !== scheduledAt?.getTime();
        if (!changed) {
          return {
            changed: false,
            seasonId: currentSeason.id,
            rsvps: 0,
            proposals: 0,
          };
        }

        // Status and old kickoff are both claims. A result import or competing
        // retime between read and write turns this into a refusal, never a write
        // against the new state.
        const updated = await tx.match.updateMany({
          where: {
            id: matchId,
            seasonId: expectedActiveSeasonId,
            status: MATCH_STATUS.SCHEDULED,
            scheduledAt: before.scheduledAt,
          },
          data: { scheduledAt, autoSyncedAt: null, autoSyncAttempts: 0 },
        });
        if (updated.count !== 1) throw new ScheduleMatchChangedError();

        const [rsvps, proposals] = await Promise.all([
          tx.matchAvailability.deleteMany({ where: { matchId } }),
          tx.rescheduleRequest.updateMany({
            where: { matchId, status: "PENDING" },
            data: { status: "CANCELLED" },
          }),
          tx.setting.deleteMany({
            where: {
              OR: [
                { key: weekReminderKey(before.seasonId, before.week) },
                {
                  key: {
                    startsWith: `${weekReminderKey(before.seasonId, before.week)}:`,
                  },
                },
              ],
            },
          }),
        ]);
        return {
          changed: true,
          seasonId: currentSeason.id,
          rsvps: rsvps.count,
          proposals: proposals.count,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof ActiveSeasonChangedError) {
      return {
        error:
          "The active season changed while this match-time form was open — reload before changing kickoff.",
      };
    }
    if (error instanceof UnknownScheduleMatchError) {
      return { error: "Unknown match" };
    }
    if (error instanceof PostAuctionWorkLockedError) {
      return {
        error:
          "Schedule changes are locked in this league phase — finish the auction, or reopen an active competition phase, then reload.",
      };
    }
    if (error instanceof ScheduleMatchChangedError) {
      return {
        error:
          "Only a scheduled match can be retimed — this match is live, final, or changed in another tab. Reload before trying again.",
      };
    }
    if ((error as { code?: string }).code === "P2034") {
      return {
        error:
          "The match changed while kickoff was being updated — nothing was changed. Reload and try again.",
      };
    }
    throw error;
  }

  if (!outcome.changed) return { message: "Kickoff time unchanged" };
  await logAdminAction({
    action: "setMatchTime",
    summary: `${scheduledAt ? "Set" : "Cleared"} kickoff for match ${matchId} — cleared ${outcome.rsvps} check-in(s) and cancelled ${outcome.proposals} open reschedule proposal(s)`,
    seasonId: outcome.seasonId,
  });
  refresh();
  // Same double-booking risk as the week mover above. Clearing a kickoff
  // cannot create a same-night collision, so it needs no clash scan.
  const clashes = scheduledAt
    ? await clashesAfterRetime(outcome.seasonId, [matchId])
    : [];
  return {
    message: `${
      scheduledAt
        ? "Kickoff time updated"
        : "Kickoff time cleared · this match is now unscheduled; auto-sync, reminders and pick'em locks stay off until a new time is set"
    } · ${outcome.rsvps} check-in(s) cleared · ${outcome.proposals} open reschedule proposal(s) cancelled${
      scheduledAt
        ? " · the week's Discord reminder is eligible to re-send with the new time"
        : ""
    }${
      clashes.length
        ? ` · ⚠ standin clash: ${clashes.join("; ")} — remove one of those assignments`
        : ""
    }`,
  };
}

/** Fetch every active player's ranked medal from OpenDota (a draft resource). */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch + store ranked medals for a set of users. Non-destructive: retries once
 * on a failed/rate-limited call, and only ever writes a real medal — never
 * overwrites a stored one with a null (whether the null is "couldn't reach
 * OpenDota" or "OpenDota returned no rank"), so a rate-limited run can't wipe
 * everyone's rank. Shared by the registrant sync and the all-accounts backfill.
 */
/** Per-account outcome, kept small so a batch can tally without re-fetching.
 *  `rank` keys the outage detection + toast counts (unchanged semantics);
 *  `pubSynced` counts the scouting snapshots stored alongside. */
type RankSyncOutcome = {
  rank: "ranked" | "ok-no-rank" | "unreachable";
  pubSynced: boolean;
};

/** Sync one account's medal (+ fh_unavailable) — and, when `withPub`, its
 *  pub-scouting snapshot — retrying whichever call missed once. */
async function syncOneRank(
  u: {
    id: string;
    dotaAccountIdV2: number | null;
    legacyDotaAccountId: number | null;
  },
  acc: number,
  withPub: boolean,
): Promise<RankSyncOutcome> {
  // A bulk sync easily trips OpenDota's free rate limit (HTTP 429) or an 8s
  // timeout — a brief back-off + one retry usually clears it.
  const noPub = { ok: false as const, stats: null };
  let [result, pub] = await Promise.all([
    fetchRankTier(acc),
    withPub ? fetchPubStats(acc) : Promise.resolve(noPub),
  ]);
  if (!result.ok || (withPub && !pub.ok)) {
    await sleep(700);
    [result, pub] = await Promise.all([
      result.ok ? Promise.resolve(result) : fetchRankTier(acc),
      withPub && !pub.ok ? fetchPubStats(acc) : Promise.resolve(pub),
    ]);
  }
  // Store what OpenDota definitely said: a real medal, the public-match-data
  // flag (fh_unavailable) auto-import depends on, and/or the scouting
  // snapshot. A failed half never blocks the half that answered, and neither
  // failure ever wipes stored data.
  const data: {
    rankTier?: number;
    fhUnavailable?: boolean;
    pubStats?: string;
    pubStatsAt?: Date;
  } = {};
  if (result.ok) {
    if (result.rankTier != null) data.rankTier = result.rankTier;
    if (result.fhUnavailable !== null)
      data.fhUnavailable = result.fhUnavailable;
  }
  if (pub.ok) {
    data.pubStats = JSON.stringify(pub.stats);
    data.pubStatsAt = new Date();
  }
  if (Object.keys(data).length > 0) {
    // The WHERE re-asserts the account these figures describe (read-time
    // precondition in the write): a player relinking a different Dota account
    // mid-sweep must not get the old account's data stamped onto the new
    // link. count 0 = they relinked; drop the result — next sweep re-reads.
    await prisma.user.updateMany({
      where: { id: u.id, ...dotaAccountLinkSnapshot(u) },
      data,
    });
  }
  if (!result.ok) return { rank: "unreachable", pubSynced: pub.ok };
  return {
    rank: result.rankTier != null ? "ranked" : "ok-no-rank",
    pubSynced: pub.ok,
  };
}

// Serverless functions have a wall-clock ceiling (`maxDuration` on the admin
// page). One OpenDota timeout is 8s and the retry doubles it, so a serial loop
// over a full roster during an OpenDota outage blows the budget and the request
// dies with no response — the button spins "Working…" forever. Guards: run a
// few accounts at once, stop starting work past a time budget, and bail
// immediately if the very first batch is entirely unreachable (a strong
// "OpenDota is down" signal) instead of hitting an 8s timeout for every id.
const RANK_SYNC_CONCURRENCY = 4;
const RANK_SYNC_BUDGET_MS = 45_000;
// The scouting snapshot costs TWO extra OpenDota calls per account, and the
// free tier's bucket is ~60/min — a 31-account sweep at 3 calls each would
// burn its own tail into 429s and could even read as a false outage. So each
// press syncs medals for EVERYONE but refreshes pub snapshots only for the
// stalest accounts up to this cap (fresh ones are skipped outright), keeping
// a full press under the bucket; repeated presses converge on full coverage
// and the toast says how many are still waiting.
const PUB_SYNC_MAX_PER_RUN = 12;

type RankSyncResult = {
  ranked: number;
  unreachable: number;
  skipped: number;
  outage: boolean;
  /** Pub-scouting snapshots stored (rides the same loop as the medals). */
  stats: number;
  /** Stale snapshots deferred to a later press by PUB_SYNC_MAX_PER_RUN. */
  deferred: number;
};

async function syncRanksFor(
  users: {
    id: string;
    dotaAccountIdV2: number | null;
    legacyDotaAccountId: number | null;
    steamId: string;
    pubStatsAt: Date | null;
  }[],
): Promise<RankSyncResult> {
  const targets = users
    .map((u) => ({ u, acc: effectiveDotaAccountId(u) }))
    .filter((t): t is { u: (typeof users)[number]; acc: number } => !!t.acc);

  // Which accounts get the two extra pub calls this run — see
  // PUB_SYNC_MAX_PER_RUN. Missing/stale snapshots only, stalest first.
  const nowMs = Date.now();
  const staleCandidates = targets
    .filter(({ u }) => !pubStatsFresh(u.pubStatsAt, nowMs))
    .sort(
      (a, b) =>
        (a.u.pubStatsAt?.getTime() ?? 0) - (b.u.pubStatsAt?.getTime() ?? 0),
    );
  const pubTargets = new Set(
    staleCandidates.slice(0, PUB_SYNC_MAX_PER_RUN).map((t) => t.u.id),
  );
  const deferred = staleCandidates.length - pubTargets.size;

  let ranked = 0;
  let unreachable = 0;
  let skipped = 0;
  let outage = false;
  let stats = 0;
  const startedAt = Date.now();

  for (let i = 0; i < targets.length; i += RANK_SYNC_CONCURRENCY) {
    if (Date.now() - startedAt > RANK_SYNC_BUDGET_MS) {
      skipped = targets.length - i;
      break;
    }
    const batch = targets.slice(i, i + RANK_SYNC_CONCURRENCY);
    const outcomes = await Promise.all(
      batch.map(({ u, acc }) => syncOneRank(u, acc, pubTargets.has(u.id))),
    );
    for (const o of outcomes) {
      if (o.rank === "unreachable") unreachable++;
      else if (o.rank === "ranked") ranked++;
      if (o.pubSynced) stats++;
    }
    // Whole first batch unreachable ⇒ OpenDota is down; don't burn the budget
    // (and the admin's patience) hitting an 8s timeout for every remaining id.
    if (
      i === 0 &&
      batch.length >= 3 &&
      outcomes.every((o) => o.rank === "unreachable")
    ) {
      outage = true;
      skipped = targets.length - batch.length;
      break;
    }
  }
  return { ranked, unreachable, skipped, outage, stats, deferred };
}

const OPENDOTA_OUTAGE_MSG =
  "OpenDota isn't responding right now — no medals were changed. Try again in a few minutes.";

/** "N couldn't be reached" suffix with a re-run / API-key hint, or "". */
function unreachableTail(unreachable: number): string {
  return unreachable
    ? ` · ${unreachable} couldn't be reached (rate limit? run it again${process.env.OPENDOTA_API_KEY ? "" : " — an OPENDOTA_API_KEY raises the limit"})`
    : "";
}

/** " · N skipped" suffix when the time budget cut the run short, or "". */
function skippedTail(skipped: number): string {
  return skipped ? ` · ${skipped} skipped (time limit — run again)` : "";
}

export async function syncPlayerRanks(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };

  const regs = await prisma.registration.findMany({
    where: { seasonId: season.id, status: "ACTIVE" },
    include: { user: true },
  });
  const { ranked, unreachable, skipped, outage, stats, deferred } =
    await syncRanksFor(regs.map((r) => r.user));
  if (outage) return { error: OPENDOTA_OUTAGE_MSG };

  // A medal learned AFTER signup can prove someone ineligible, and nothing else
  // ever re-checks: registrationGate only runs on submit, and a stored MMR is
  // league-approved by design. Anyone who signed up before linking their Dota
  // account (or while OpenDota was down) therefore sits in the pool with a
  // ceiling-breaking medal and an admitted low number. Name them here — this is
  // the one moment the league actually learns the truth. Never auto-remove:
  // who plays is the operator's call (withdraw/reinstate, or setRegistrationMmr).
  // Re-read rather than reusing `regs`: that snapshot predates the sync, so its
  // user.rankTier is exactly the null we just filled in.
  const flagged = await prisma.registration.findMany({
    where: { seasonId: season.id, status: "ACTIVE" },
    include: { user: { select: { name: true, rankTier: true } } },
  });
  const overCeiling = flagged.filter((r) =>
    medalProvesIneligible(r.user.rankTier),
  );
  const warning = overCeiling.length
    ? ` ⚠️ ${overCeiling.length} signup(s) now have a medal above the ${HARD_MMR_CEILING} ceiling: ${overCeiling
        .slice(0, 5)
        .map(
          (r) =>
            `${r.user.name} (${rankMedalName(r.user.rankTier)}, entered ${r.mmr})`,
        )
        .join(
          ", ",
        )}${overCeiling.length > 5 ? `, +${overCeiling.length - 5} more` : ""} — review before the draft.`
    : "";

  refresh();
  return {
    message: `Synced ${regs.length} players · ${ranked} ranked${stats > 0 ? ` · ${stats} scouting profile${stats === 1 ? "" : "s"}` : ""}${deferred > 0 ? ` (${deferred} more next run)` : ""}${unreachableTail(unreachable)}${skippedTail(skipped)}${warning}`,
  };
}

/**
 * Backfill medals for EVERY account that doesn't have one yet — including people
 * who logged in but never signed up (the registrant sync above skips them).
 * Only targets null-medal accounts, so it makes no wasted API calls and never
 * touches a medal that's already set; login fills in new accounts going forward.
 */
export async function syncAllRanks(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const users = await prisma.user.findMany({ where: { rankTier: null } });
  if (users.length === 0) {
    return { message: "Every account already has a medal" };
  }
  const { ranked, unreachable, skipped, outage } = await syncRanksFor(users);
  if (outage) return { error: OPENDOTA_OUTAGE_MSG };
  refresh();
  return {
    message: `Checked ${users.length} account(s) without a medal · ${ranked} now ranked${unreachableTail(unreachable)}${skippedTail(skipped)}`,
  };
}

// (syncAllRanks deliberately reports medals only — its filter is null-medal
// accounts, so its purpose stays "medal backfill"; the scouting snapshots it
// happens to refresh along the way are a free side effect.)

/**
 * Break-glass: invalidate EVERY signed-in session (advances the session epoch).
 * Use if a token may have leaked / an account is compromised — everyone,
 * including the admin who ran it, must log in again. Normal logout is unchanged.
 */
export async function revokeAllSessions(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
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
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
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
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
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
      (error as { code?: string }).code === "P2034"
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
 * tie. Applied to schedules/brackets created after this — set before generating.
 */
export async function setSeriesLengths(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
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
  if (
    !(await updateRenderedSeason(claim, {
      regularBestOf,
      playoffBestOf,
      finalBestOf,
    }))
  ) {
    return staleSeasonSettingsError;
  }
  await logAdminAction({
    action: "setSeriesLengths",
    summary: `Set series lengths to regular Bo${regularBestOf}, playoffs Bo${playoffBestOf}, final Bo${finalBestOf}`,
    seasonId: season.id,
  });
  refresh();
  return {
    message: `Series lengths saved · regular Bo${regularBestOf}, playoffs Bo${playoffBestOf}, final Bo${finalBestOf}`,
  };
}

/** Set (or clear) the season's Valve league id for in-client league games. */
export async function setLeagueId(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
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
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
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

/** Save the Discord webhook used for league announcements. */
export async function setDiscordWebhook(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const value = str(formData, "discordWebhookUrl").trim();
  // The field renders EMPTY on purpose — the saved URL is a secret we never
  // send back to the browser. So a blank submit must be a no-op, not a wipe;
  // turning announcements off is the explicit clearDiscordWebhook action.
  if (!value) {
    return {
      message:
        "No change — paste a new URL to replace it, or press \u201cRemove webhook\u201d to turn announcements off.",
    };
  }
  const webhookUrl = normalizeDiscordWebhookUrl(value);
  if (!webhookUrl) {
    return {
      error:
        "That doesn't look like a Discord webhook URL (https://discord.com/api/webhooks/…)",
    };
  }
  // Moving to a webhook for a DIFFERENT channel strands the queue board: we
  // could no longer edit it, and it would sit in the old channel forever
  // showing a frozen count. Tear it down while the old credential is still the
  // configured one, i.e. before the save below. A regenerated token for the
  // SAME webhook keeps its id, so that case correctly leaves the board alone.
  const prevId = webhookIdOf(await getInhouseWebhookUrl());
  const nextId = webhookIdOf(
    (await getSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL)) ||
      process.env.DISCORD_INHOUSE_WEBHOOK_URL ||
      webhookUrl,
  );
  // Only tears the board down when the league webhook IS the effective inhouse
  // one (i.e. no separate inhouse webhook is set) — otherwise the board lives
  // in its own channel and this change doesn't touch it.
  const movedChannel = !!prevId && !!nextId && prevId !== nextId;
  // force: the old credential is about to stop being the configured one, so
  // "keep the row and retry later" isn't an option — after the save we could
  // never edit or delete that message again.
  const torndown = movedChannel
    ? await removeInhouseBoard({ force: true })
    : null;

  await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, webhookUrl);
  await logAdminAction({
    action: "setDiscordWebhook",
    summary: `Replaced the league announcement webhook${movedChannel ? (torndown?.orphaned ? "; the old queue board may be orphaned" : "; the old queue board was removed") : ""}`,
  });
  refresh();
  return {
    message: !movedChannel
      ? "Webhook saved — announcements are on"
      : torndown?.orphaned
        ? "Webhook saved — announcements are on. The old queue board is still in the old channel and can no longer be updated; delete that message by hand, then post a new board below."
        : "Webhook saved — announcements are on. The queue board was removed from the old channel; post a new one below.",
  };
}

/** Turn off Discord announcements by removing the stored webhook. */
export async function clearDiscordWebhook(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  // Delete the board FIRST — it needs the credential we're about to remove,
  // and a pinned message frozen at a stale count is the worst thing this
  // feature can leave behind.
  // Same rule: only our problem if the league webhook is what the board rides.
  const separate =
    !!(await getSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL)) ||
    !!process.env.DISCORD_INHOUSE_WEBHOOK_URL;
  const torndown = separate
    ? { orphaned: false }
    : await removeInhouseBoard({ force: true });
  await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, "");
  await logAdminAction({
    action: "clearDiscordWebhook",
    summary: `Removed the league announcement webhook${torndown.orphaned ? "; the old queue board may be orphaned" : ""}`,
  });
  refresh();
  return {
    message: torndown.orphaned
      ? "Webhook removed — announcements are off. Discord didn't confirm deleting the queue board, so delete that message by hand."
      : "Webhook removed — announcements are off",
  };
}

/**
 * Save a SEPARATE webhook for the inhouse channel. A Discord webhook is bound
 * to the channel it was created in, so this is the only way to keep the queue
 * board, lobby pings and inhouse results out of the league-announcement
 * channel. Unset = inhouse keeps riding the league webhook.
 */
export async function setInhouseWebhook(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const value = str(formData, "inhouseWebhookUrl").trim();
  // Same rule as the league field: it renders empty because the saved URL is a
  // secret we never send back, so a blank submit is a no-op, never a wipe.
  if (!value) {
    return {
      message:
        "No change — paste a new URL to replace it, or press \u201cUse the league channel instead\u201d to stop posting inhouse to its own channel.",
    };
  }
  const webhookUrl = normalizeDiscordWebhookUrl(value);
  if (!webhookUrl) {
    return {
      error:
        "That doesn't look like a Discord webhook URL (https://discord.com/api/webhooks/…)",
    };
  }

  // The board lives in whatever channel the inhouse webhook points at, so a
  // change of channel strands it. Tear it down while the OLD credential is
  // still the configured one.
  const prevId = webhookIdOf(await getInhouseWebhookUrl());
  const moved = !!prevId && prevId !== webhookIdOf(webhookUrl);
  const torndown = moved ? await removeInhouseBoard({ force: true }) : null;

  await setSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL, webhookUrl);
  await logAdminAction({
    action: "setInhouseWebhook",
    summary: `Replaced the inhouse board webhook${moved ? (torndown?.orphaned ? "; the old board may be orphaned" : "; the old board was removed") : ""}`,
  });
  refresh();
  return {
    message: !moved
      ? "Inhouse webhook saved — queue board, lobby pings and inhouse results now post there."
      : torndown?.orphaned
        ? "Inhouse webhook saved. The old queue board couldn't be deleted — remove that message by hand, then post a new board below."
        : "Inhouse webhook saved — the old queue board was removed; post a new one below.",
  };
}

/** Send inhouse traffic back to the league webhook. */
export async function clearInhouseWebhook(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  // Clearing this MOVES the inhouse channel back to the league webhook, so the
  // board would be stranded in the old channel. Take it down first.
  const torndown = await removeInhouseBoard({ force: true });
  await setSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL, "");
  await logAdminAction({
    action: "clearInhouseWebhook",
    summary: `Removed the separate inhouse webhook${torndown.orphaned ? "; the old board may be orphaned" : ""}`,
  });
  refresh();
  return {
    message: torndown.orphaned
      ? "Inhouse webhook removed — inhouse posts to the league channel again. Delete the old queue board message by hand."
      : "Inhouse webhook removed — inhouse posts to the league channel again.",
  };
}

/**
 * Save a SEPARATE webhook for inhouse ALERTS — the queue ping, "match found"
 * and results — so the queue board can have a channel to itself.
 *
 * The board is read at a glance from the bottom of its channel; one alert
 * posted under it pushes it out of view, which defeats the whole design.
 */
export async function setInhouseAlertWebhook(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const value = str(formData, "inhouseAlertWebhookUrl").trim();
  if (!value) {
    return {
      message:
        "No change — paste a new URL to replace it, or press \u201cSend alerts to the board channel instead\u201d to stop using a separate alerts channel.",
    };
  }
  const webhookUrl = normalizeDiscordWebhookUrl(value);
  if (!webhookUrl) {
    return {
      error:
        "That doesn't look like a Discord webhook URL (https://discord.com/api/webhooks/…)",
    };
  }
  await setSetting(SETTING_KEYS.INHOUSE_ALERT_WEBHOOK_URL, webhookUrl);
  await logAdminAction({
    action: "setInhouseAlertWebhook",
    summary: "Replaced the separate inhouse alert webhook",
  });
  refresh();
  return {
    message:
      "Saved — queue pings, match-found and results now post there. The board channel keeps only the board.",
  };
}

/** Send inhouse alerts back to the board's channel. */
export async function clearInhouseAlertWebhook(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  await setSetting(SETTING_KEYS.INHOUSE_ALERT_WEBHOOK_URL, "");
  await logAdminAction({
    action: "clearInhouseAlertWebhook",
    summary:
      "Removed the separate inhouse alert webhook; alerts use the board channel",
  });
  refresh();
  return { message: "Alerts will post in the board's channel again" };
}

/**
 * Save the Discord ROLE the two interrupting inhouse messages may ping.
 *
 * This is the only thing in the whole integration that can reach a phone —
 * board edits notify nobody by design, and every other send suppresses
 * mentions. The role must be SELF-ASSIGNABLE in Discord (Server Settings →
 * Onboarding, or a Channels & Roles picker): a ping people can't opt out of
 * gets the channel muted, which is permanently worse than silence.
 */
export async function setInhousePingRole(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  // Accept a raw snowflake or a pasted <@&id> mention — both are what an admin
  // actually has to hand (right-click → Copy Role ID, or typing \@role).
  const raw = str(formData, "inhousePingRoleId").trim();
  const id = raw.replace(/^<@&(\d+)>$/, "$1");
  if (!id) {
    await setSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID, "");
    await logAdminAction({
      action: "setInhousePingRole",
      summary: "Disabled the inhouse Discord role ping",
    });
    refresh();
    return { message: "Role ping off — inhouse messages won't notify anyone" };
  }
  if (!/^\d{15,25}$/.test(id)) {
    return {
      error:
        "That doesn't look like a role id. In Discord: Server Settings → Roles → right-click the role → Copy Role ID (needs Developer Mode).",
    };
  }
  await setSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID, id);
  await logAdminAction({
    action: "setInhousePingRole",
    summary: `Set the inhouse Discord ping role to ${id}`,
  });
  refresh();
  return {
    message:
      "Role saved — the queue-filling and match-found messages will ping it. Make sure members can self-assign it.",
  };
}

/** Post a test message to whichever channel inhouse currently uses. */
export async function testInhouseWebhook(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  // Gate on the ALERT resolver — the one the send below actually rides
  // (alerts fall back alert → board → league). Gating on the board resolver
  // refused alert-webhook-only leagues a test their send would deliver.
  if (!(await getInhouseAlertWebhookUrl())) {
    return { error: "Set a webhook first" };
  }
  const ok = await sendInhouseDiscordMessage(testMessage());
  return ok
    ? {
        message:
          "Test message sent — check the channel your inhouse alerts post to",
      }
    : { error: "Discord rejected the message — double-check the URL" };
}

/**
 * Post the live inhouse queue board — ONE message the site rewrites in place
 * as players join and leave, so the channel gets a live count without a new
 * message per join.
 */
export async function postInhouseBoard(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await createInhouseBoard();
  refresh();
  return res.ok
    ? {
        message:
          "Board posted — right-click it in Discord and Pin it so it never scrolls away.",
      }
    : { error: res.error ?? "Could not post the board" };
}

/** Delete the queue board message and stop updating it. */
export async function deleteInhouseBoard(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await removeInhouseBoard();
  refresh();
  if (!res.ok) return { error: res.error ?? "Could not remove the board" };
  // Never claim a message was deleted when it wasn't — an orphaned board is
  // pinned forever at a frozen count and nothing here can touch it again.
  return {
    message: res.orphaned
      ? "Cleared the board record — Discord may still have an untracked message. Check the channel and delete it by hand before posting again."
      : "Queue board removed",
  };
}

/** Post a test message so the admin can confirm the webhook works. */
export async function testDiscordWebhook(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const configured =
    (await getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL)) ||
    process.env.DISCORD_WEBHOOK_URL;
  if (!configured) return { error: "Set a webhook URL first" };
  // A webhook check must report this exact network attempt. Ordinary league
  // announcements are durably queued, where `true` means accepted by the
  // outbox rather than necessarily accepted by Discord already.
  const ok = await sendDiscordMessage(testMessage(), undefined, {
    durable: false,
  });
  return ok
    ? { message: "Test message sent — check your Discord" }
    : { error: "Discord rejected the message — double-check the URL" };
}

/** Import all games from the season's Dota league id (OpenDota). */
export async function syncLeagueAction(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const res = await syncLeagueGames(season.id);
  if (res.error) return { error: res.error };
  refreshGames();
  return {
    message: `League sync · imported ${res.imported} of ${res.scanned} league games`,
  };
}

/** Backfill report-card stats (benchmarks, XPM…) onto older imported games. */
export async function enrichGamesAction(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await enrichStoredGames();
  if (res.enriched === 0 && res.remaining === 0) {
    return { message: "Every stored game already has report-card data" };
  }
  refreshGames();
  return {
    message: `Enriched ${res.enriched} game(s)${
      res.failed ? ` · ${res.failed} not on OpenDota right now` : ""
    }${res.remaining ? ` · ${res.remaining} to go — run again` : ""}`,
  };
}

/** Refresh every user's Steam persona name + avatar (batched). */
export async function syncSteamProfiles(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const users = await prisma.user.findMany();
  const profiles = await fetchSteamProfiles(users.map((u) => u.steamId));
  let updated = 0;
  try {
    for (const u of users) {
      const p = profiles.get(u.steamId);
      if (!p) continue;
      await prisma.user.update({
        where: { id: u.id },
        data: { name: p.name, avatar: p.avatar, profileUrl: p.profileUrl },
      });
      updated++;
    }
  } finally {
    // Persona names are part of the pinned board digest. Preserve partial
    // progress if a later profile update fails without issuing one cache
    // operation per user on a successful batch.
    if (updated > 0) updateTag(AUTOMATION_GATE_TAG);
  }
  refresh();
  return { message: `Updated ${updated} of ${users.length} Steam profiles` };
}

/** Set (or clear) the draft night — announced with countdowns during signups. */
export async function setDraftNight(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this page was open — reload before changing draft night.",
    };
  }

  const raw = str(formData, "draftAt").trim();
  const when = localDate(formData, "draftAt", "draftAtTs");
  if (raw && !when) return { error: "Invalid draft night" };

  // A no-op resubmit (same timestamp) must neither re-announce to Discord nor
  // invalidate confirmations. A real change bumps the revision instead of
  // deleting acknowledgements, so both /me and admin can identify stale rows.
  // The form disappears when the auction starts, but Server Actions are still
  // callable directly: enforce that lock in the same serializable transaction
  // as the schedule update so a start-draft request cannot cross in the gap.
  let changed = false;
  let replacedExistingTime = false;
  await raceHook("admin.setDraftNight.beforeTx");
  try {
    await prisma.$transaction(
      async (tx) => {
        const [currentSeason, draft] = await Promise.all([
          tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
          tx.draft.findUnique({
            where: { seasonId: expectedActiveSeasonId },
            select: { status: true },
          }),
        ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!draftSetupOpen(currentSeason.status, draft?.status)) {
          throw new DraftSetupLockedError(
            draftSetupLockedMessage(currentSeason.status, draft?.status),
          );
        }
        changed =
          (when?.getTime() ?? null) !==
          (currentSeason.draftAt?.getTime() ?? null);
        replacedExistingTime = changed && currentSeason.draftAt != null;
        const updated = await tx.season.updateMany({
          where: {
            id: expectedActiveSeasonId,
            isActive: true,
            status: currentSeason.status,
          },
          data: changed
            ? { draftAt: when, draftRevision: { increment: 1 } }
            : { draftAt: when },
        });
        if (updated.count === 0) throw new ActiveSeasonChangedError();
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof DraftSetupLockedError) return { error: error.message };
    if (
      error instanceof ActiveSeasonChangedError ||
      (error as { code?: string }).code === "P2034"
    ) {
      return {
        error:
          "The season or draft changed while you saved — reload and try again.",
      };
    }
    throw error;
  }
  // Best-effort announcement — the countdown surfaces update either way.
  if (changed) {
    await sendDiscordMessage(
      when
        ? replacedExistingTime
          ? draftRescheduledMessage(season.name, when.getTime())
          : draftScheduledMessage(season.name, when.getTime())
        : draftCancelledMessage(season.name),
    );
  }
  if (changed) {
    await logAdminAction({
      action: "setDraftNight",
      summary: when
        ? `${replacedExistingTime ? "Rescheduled" : "Scheduled"} the draft for ${when.toISOString()}`
        : "Cleared the scheduled draft night",
      seasonId: season.id,
    });
  }
  refresh();
  return {
    message: when
      ? replacedExistingTime
        ? "Draft night updated — players need to confirm the new time"
        : "Draft night set 🗓️"
      : "Draft night cleared",
  };
}

/**
 * Promote an ACTIVE standin registration to a full PLAYER — the mid-season
 * roster refill. Self-serve PLAYER signups close after SIGNUPS
 * (registrationGate) and signFreeAgent refuses standins, so without this the
 * only path to fill an abandoned seat was flipping the whole season back to
 * SIGNUPS. Flow: late joiner registers as standin on /me → admin promotes →
 * signs them via the free-agent form (which does the Discord announcement).
 */
export async function promoteStandinToPlayer(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const userId = str(formData, "userId");
  // Deterministic SQLite seam: a rival can commit immediately before the
  // authoritative snapshot without trying to open a second writer while this
  // transaction is live (SQLite pins interactive transactions to one writer).
  await raceHook("admin.promoteStandin.beforeTx");

  let candidateName: string | null = null;
  let outcome:
    { ok: true; seasonId: string; name: string } | { ok: false; error: string };
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        // Season, Draft, Registration, and pending cover are one decision. In
        // particular, startDraft is Serializable too and reads the PLAYER
        // pool before writing Season/Draft; PostgreSQL SSI therefore orders
        // that command against this Registration write instead of allowing a
        // standin to materialise in an already-snapshotted live auction.
        const activeSeasons = await tx.season.findMany({
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 2,
        });
        if (activeSeasons.length === 0) {
          return { ok: false as const, error: "No active season" };
        }
        if (activeSeasons.length > 1) {
          return {
            ok: false as const,
            error:
              "More than one season is marked active — resolve that data integrity issue before promoting players",
          };
        }
        const season = activeSeasons[0];
        const [registration, draftRow, pendingAssignments] = await Promise.all([
          tx.registration.findUnique({
            where: {
              seasonId_userId: { seasonId: season.id, userId },
            },
            include: { user: true },
          }),
          tx.draft.findUnique({ where: { seasonId: season.id } }),
          tx.standinAssignment.count({
            where: pendingCoverWhere(userId, season.id),
          }),
        ]);
        if (!registration) {
          return {
            ok: false as const,
            error: "That person isn't registered for this season",
          };
        }
        candidateName = registration.user.name;
        const gateError = promoteGateError({
          seasonStatus: season.status,
          draftStatus: draftRow?.status ?? null,
          registrationStatus: registration.status,
          registrationType: registration.type,
          pendingAssignments,
        });
        if (gateError) return { ok: false as const, error: gateError };

        // PostgreSQL-only deterministic seam: startDraft can commit after all
        // gate reads but before this claim. The two Serializable commands form
        // a read/write cycle, so this command must abort rather than promote a
        // player into a draft whose pool snapshot is already live.
        await raceHook("admin.promoteStandin.afterGate");

        // Keep the row predicate as a second line of defence against withdraw,
        // remove, or duplicate-promote rivals. The enclosing Serializable
        // snapshot is what additionally protects the Season/Draft decision.
        const promoted = await tx.registration.updateMany({
          where: {
            id: registration.id,
            seasonId: season.id,
            userId,
            status: REGISTRATION_STATUS.ACTIVE,
            type: REGISTRATION_TYPE.STANDIN,
          },
          data: {
            type: REGISTRATION_TYPE.PLAYER,
            ...clearedDraftConfirmation,
          },
        });
        if (promoted.count === 0) {
          return {
            ok: false as const,
            error: `${registration.user.name}'s signup just changed — reload and check it before promoting`,
          };
        }
        return {
          ok: true as const,
          seasonId: season.id,
          name: registration.user.name,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if ((error as { code?: string }).code === "P2034") {
      return {
        error: candidateName
          ? `${candidateName}'s signup just changed — reload and check it before promoting`
          : "The season, draft, or signup just changed — reload and check it before promoting",
      };
    }
    throw error;
  }
  if (!outcome.ok) return { error: outcome.error };

  await logAdminAction({
    action: "promoteStandinToPlayer",
    summary: `Promoted ${outcome.name} from standin to full player`,
    seasonId: outcome.seasonId,
  });
  refresh();
  return {
    message: `${outcome.name} is now a full player — sign them onto a team in Roster moves`,
  };
}
