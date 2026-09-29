"use server";

// Admin actions for the schedule and results: generate the schedule, retime
// weeks and matches, start or undo the playoffs, record and reopen results,
// import or remove games, and sync the Valve league feed.

import { updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { raceHook } from "@/lib/race-hook";
import { getActiveSeason, singleActiveSeason } from "@/lib/season";
import { clashesAfterRetime } from "@/lib/standin-service";
import { announceAdminRetime } from "@/lib/retime-announcement";
import {
  SEASON_STATUS,
  MATCH_STATUS,
  MATCH_PHASE,
  DOTA_MATCH_KIND,
} from "@/lib/constants";
import {
  roundRobin,
  matchNightForWeek,
  shiftMatchNight,
  slotRound,
  hasLaterBracketRound,
} from "@/lib/schedule";
import { playedSeriesFinalError, seriesScoreError } from "@/lib/standings";
import {
  isPlayoffPhase,
  matchResultLockReason,
  matchResultsOpen,
  postAuctionWorkOpen,
} from "@/lib/league-lifecycle";
import {
  createPlayoffBracket,
  advancePlayoffBracket,
  returnToRegularSeason,
} from "@/lib/playoff-service";
import { advanceTiebreakerWeek } from "@/lib/tiebreaker-service";
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
  rememberImportSkip,
} from "@/lib/match-import";
import { parseMatchId } from "@/lib/dota";
import { bool, clampInt, localDate, str } from "@/lib/form";
import { formatLeagueTime } from "@/lib/zoned-time";
import {
  playoffsStartedMessage,
  playoffsReturnedToRegularMessage,
  standinRemovedMessage,
  sendDiscordMessage,
} from "@/lib/discord";
import { mentionsOf } from "@/lib/discord-mentions";
import { fixtureLogName, logAdminAction } from "@/lib/admin-log";
import { fixtureLogLabel } from "@/lib/admin-log-copy";
import {
  championAnnouncedKey,
  resultAnnouncedKey,
  stampResultChange,
  weekReminderKey,
  weekReminderPrefix,
} from "@/lib/settings";
import {
  markWeekHonorsStale,
  maybeAnnounceWeekHonors,
} from "@/lib/honors-service";
import {
  invalidatePendingAnnouncementMarkers,
  invalidateMatchNudges,
} from "@/lib/announcement-marker";
import type { ActionResult } from "@/lib/action-result";
import {
  describeScrimConflict,
  findConfirmedScrimConflict,
  scrimConflictFix,
  type ScrimConflict,
} from "@/lib/scrim-schedule-conflict";
import { isSerializationConflict } from "@/lib/prisma-errors";
import { seedsFromFirstRound } from "@/lib/bracket-view";
import {
  adminOrError,
  ActiveSeasonChangedError,
  ResultsLandedError,
  ResultWriteError,
  refresh,
  refreshGames,
} from "./admin-shared";

class PostAuctionWorkLockedError extends Error {}

class ScheduleNeedsTeamsError extends Error {}

class WithdrawnTeamsError extends Error {
  constructor(readonly teamNames: string[]) {
    super("Withdrawn teams cannot be scheduled");
  }
}

class ScheduleMatchChangedError extends Error {}

class ScheduledWeekEmptyError extends Error {}

class UnknownScheduleMatchError extends Error {}

/** Carries the clashing booking, already described, so every refusal can
 *  name the scrim instead of "a booked scrim" somewhere, plus the step that
 *  clears it (cancel a booked scrim, end a live one). */
class ScrimScheduleConflictError extends Error {
  readonly scrim: string;
  readonly fix: string;
  constructor(conflict: ScrimConflict) {
    super("Scrim schedule conflict");
    this.scrim = describeScrimConflict(conflict);
    this.fix = scrimConflictFix(conflict);
  }
}

class ResultAlreadySavedError extends Error {}

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

/** Generate a round-robin regular-season schedule from the drafted teams. */
export async function generateSchedule(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId) {
    return {
      error:
        "This schedule form is stale — reload before generating the schedule.",
    };
  }

  // Week 1 plays at the first match night, each later week +7 days on the
  // league's clock. It is required: a fixture with no kickoff gets no
  // check-in, no weekly reminder, no automatic result import and no pick'em
  // lock, and filling times in afterwards took one form per week.
  if (!str(formData, "firstNight").trim()) {
    return {
      error:
        "Set the first match night. Week 1 plays then and each later week a week after, so every fixture has a kickoff for check-in, reminders and automatic results.",
    };
  }
  const firstNight = localDate(formData, "firstNight", "firstNightTs");
  if (!firstNight) {
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
            scheduledAt: matchNightForWeek(firstNight, i + 1),
          })),
        );

        // A generated schedule is just as authoritative as a manual retime.
        // Check every fixture before replacing the old schedule so an
        // already-booked SCHEDULED/LIVE scrim cannot be hidden underneath a
        // new official kickoff. Both this path and scrim claiming are
        // Serializable, so a concurrent claim/generate race has one loser.
        for (const row of rows) {
          const scrimClash = await findConfirmedScrimConflict(tx, {
            seasonId: currentSeason.id,
            teamIds: [row.homeTeamId, row.awayTeamId],
            scheduledAt: row.scheduledAt,
          });
          if (scrimClash) {
            throw new ScrimScheduleConflictError(scrimClash);
          }
        }

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
    if (e instanceof ScrimScheduleConflictError) {
      return {
        error: `A generated kickoff falls within four hours of ${e.scrim}. ${e.fix}, then generate the schedule again.`,
      };
    }
    if (isSerializationConflict(e)) {
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
        reason: "SCHEDULE_REGENERATED",
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
    message: `Schedule generated · ${outcome.rows} matches over ${outcome.weeks} week(s)${
      doubleRound ? " (double round robin)" : ""
    } · week 1: ${formatLeagueTime(firstNight)}, then weekly${
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
  const actor = await adminOrError();
  if ("error" in actor) return actor;
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
    }, actor);
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
      where: {
        seasonId: season.id,
        phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
      },
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
        reason: "BRACKET_REBUILT",
      }),
      mentionsOf([a.discordId]),
    );
  }
  // Seeds come from the frozen first-round pairings, the same source the
  // bracket on the site labels them from.
  const seeds = seedsFromFirstRound(bracket);
  await sendDiscordMessage(
    playoffsStartedMessage(
      season.name,
      season.id,
      bracket.map((m) => ({
        home: name.get(m.homeTeamId) ?? "?",
        away: name.get(m.awayTeamId) ?? "?",
        homeSeed: seeds.get(m.homeTeamId) ?? null,
        awaySeed: seeds.get(m.awayTeamId) ?? null,
        whenMs: m.scheduledAt?.getTime() ?? null,
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
  // A practice scrim booked near the first round's night was cancelled (or,
  // if already under way, kept) by the build — say which, by name.
  const scrimNote = outcome.scrimNotes.length
    ? ` ${outcome.scrimNotes.join(" ")}`
    : "";
  return {
    message:
      (intent === "reset"
        ? "Playoff bracket reset and reseeded"
        : "Playoff bracket created") + scrimNote,
  };
}

/** Remove the postseason and reopen the existing regular season for repair. */
export async function returnToRegularSeasonAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await adminOrError();
  if ("error" in actor) return actor;
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
    }, actor);
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
        reason: "BRACKET_WITHDRAWN",
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
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const matchId = str(formData, "matchId");
  const homeScore = clampInt(formData, "homeScore", 0, 0, 99);
  const awayScore = clampInt(formData, "awayScore", 0, 0, 99);
  // A forfeit is a RULED score. Its recorded score remains official for the
  // standings and head-to-head differential; the flag keeps the ruling visible
  // and lets performance-only power rankings skip it.
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
              : match.phase === MATCH_PHASE.TIEBREAKER
                ? "Tiebreaker results can only change before playoffs during the active Regular season phase."
                : "Playoff results can only change while the active season is in Playoffs.",
          );
        }
        const resultLock = await matchResultLockReason(tx, match);
        if (resultLock) throw new ResultWriteError(resultLock);
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

        if (match.phase === MATCH_PHASE.TIEBREAKER && homeScore === awayScore) {
          throw new ResultWriteError(
            "A tiebreaker series cannot end in a draw — record the decider or forfeit winner.",
          );
        }
        if (isPlayoffPhase(match.phase)) {
          if (homeScore === awayScore) {
            throw new ResultWriteError(
              "A playoff series can't end in a draw — record the forfeit/decider winner",
            );
          }
          const playoffs = await tx.match.findMany({
            where: {
              seasonId: match.seasonId,
              phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
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
        // A queued "we couldn't find your games" nudge is answered now.
        await invalidateMatchNudges(tx, match.id);
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
        await stampResultChange(tx);
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
    if (isSerializationConflict(error)) {
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
        isPlayoff: isPlayoffPhase(outcome.phase),
        isTiebreaker: outcome.phase === MATCH_PHASE.TIEBREAKER,
        reason: "FORFEIT",
      }),
      mentionsOf([booking.standin.discordId]),
    );
  }

  // Playoff results auto-advance the bracket (and crown the champion at the end).
  let tiebreakerPending = false;
  if (isPlayoffPhase(outcome.phase)) {
    await advancePlayoffBracket(outcome.seasonId);
  } else if (outcome.phase === MATCH_PHASE.TIEBREAKER) {
    try {
      await advanceTiebreakerWeek(outcome.seasonId);
    } catch {
      // The score is committed. Automatic sync retries the next same-week
      // game, so never report the saved result as a failed write.
      tiebreakerPending = true;
      console.error("[admin] tiebreaker advancement deferred (TIEBREAKER_ADVANCE_FAILED)");
    }
  } else if (outcome.phase === MATCH_PHASE.REGULAR) {
    // Manual results can also close out a week — send its honors (idempotent).
    await maybeAnnounceWeekHonors(outcome.seasonId, outcome.week);
  }
  refresh();
  return {
    message: `Result saved · ${homeScore}–${awayScore}${forfeit ? " (forfeit / ruling)" : ""}${tiebreakerPending ? ". The next tiebreaker game is pending automatic retry; reload the schedule before playing." : ""}`,
  };
}

/** Import a specific Dota game (by id or URL) into a scheduled match. */
export async function importGameAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const matchId = str(formData, "matchId");
  const dotaMatchId = parseMatchId(str(formData, "dotaMatchRef"));
  if (!dotaMatchId) return { error: "Enter a valid match id or URL" };
  const res = await importGameForMatch(matchId, dotaMatchId, {
    providerActorId: admin.id,
  });
  if (!res.ok) return { error: res.error };
  await logAdminAction({
    action: "importGameAction",
    summary: `Imported Dota match ${dotaMatchId} into ${await fixtureLogName(matchId)}`,
  });
  refreshGames();
  return { ok: true, message: "Game imported" };
}

/** Auto-detect a scheduled match's games from the rosters' recent games. */
export async function autoDetectAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
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
      summary: `Auto-detected ${res.imported} game(s) for ${await fixtureLogName(matchId)} after scanning ${res.scanned} player(s)`,
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
  const admin = await adminOrError();
  if ("error" in admin) return admin;
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
          isPlayoffPhase(match.phase) &&
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
              : match.phase === MATCH_PHASE.TIEBREAKER
                ? "Tiebreaker results can only change before playoffs during the active Regular season phase."
                : "Playoff results can only change while the active season is in Playoffs.",
          );
        }
        const resultLock = await matchResultLockReason(tx, match);
        if (resultLock) throw new ResultWriteError(resultLock);
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
        if (isPlayoffPhase(match.phase)) {
          const playoffs = await tx.match.findMany({
            where: {
              seasonId: match.seasonId,
              phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
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
        await stampResultChange(tx);
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
    if (isSerializationConflict(error)) {
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
  const admin = await adminOrError();
  if ("error" in admin) return admin;
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
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
        },
      },
    },
  });
  if (!game) return { error: "That game is already gone" };
  // Names, not ids: the log has no foreign keys and must read on its own.
  const fixtureName = fixtureLogLabel({
    phase: game.match.phase,
    week: game.match.week,
    bracketSlot: game.match.bracketSlot,
    homeName: game.match.homeTeam.name,
    awayName: game.match.awayTeam.name,
  });
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
          : game.match.phase === MATCH_PHASE.TIEBREAKER
            ? "Tiebreaker results can only change before playoffs during the active Regular season phase."
            : "Playoff results can only change while the active season is in Playoffs.",
    };
  }

  const resultLock = await matchResultLockReason(prisma, game.match);
  if (resultLock) return { error: resultLock };


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
                homeScore: true,
                awayScore: true,
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
        const resultLock = await matchResultLockReason(tx, match);
        if (resultLock) throw new ResultWriteError(resultLock);
        // Once a decided playoff series has advanced, changing its source
        // games would strand the old winner downstream. Read descendants and
        // delete the game in the same Serializable snapshot as advancement.
        if (
          isPlayoffPhase(match.phase) &&
          match.status === MATCH_STATUS.COMPLETED
        ) {
          const playoffs = await tx.match.findMany({
            where: {
              seasonId: match.seasonId,
              phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
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
        // The exclusion and removal are one correction: concurrent removals
        // cannot overwrite each other's IDs and a rollback leaves neither.
        await rememberImportSkip(match.seasonId, fresh.dotaMatchId, tx);
        const removed = await tx.game.deleteMany({ where: { id: fresh.id } });
        if (removed.count === 0) {
          throw new ResultWriteError("That game is already gone");
        }
        // Release the cross-mode ownership record with the game correction.
        // Existing pre-scrim games legitimately have no claim, so deleteMany
        // keeps this migration-safe while preventing a removed import from
        // permanently blocking the same Valve id on a corrected event.
        await tx.dotaMatchClaim.deleteMany({
          where: {
            dotaMatchId: fresh.dotaMatchId,
            kind: DOTA_MATCH_KIND.LEAGUE,
            contextId: match.id,
          },
        });
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
        // A consequential correction and its actor/history are one command.
        // If the required audit cannot be stored, the game and suppression
        // roll back together instead of leaving an untraceable correction.
        await raceHook("admin.removeGame.beforeAudit");
        await tx.adminAction.create({
          data: {
            actorId: admin.id,
            actorName: admin.name,
            action: "removeGame",
            seasonId: match.seasonId,
            summary: `Removed Dota game ${fresh.dotaMatchId} from ${fixtureName}; score ${match.homeScore}-${match.awayScore} → ${projection.homeScore}-${projection.awayScore}`.slice(0, 500),
          },
        });
        await stampResultChange(tx);
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
    if (isSerializationConflict(error)) {
      return {
        error:
          "The result or playoff bracket changed while you removed that game — reload and try again.",
      };
    }
    throw error;
  }

  // The deletion is already committed. Expire every public game aggregate
  // before attempting Discord, honors, or bracket follow-ups so a
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
      isPlayoffPhase(corrected.phase) &&
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
    } else if (corrected.phase === MATCH_PHASE.TIEBREAKER) {
      await runFollowUp("tiebreaker advancement", () =>
        advanceTiebreakerWeek(corrected.seasonId),
      );
    } else if (corrected.phase === MATCH_PHASE.REGULAR) {
      await runFollowUp("weekly-honors reconciliation", () =>
        maybeAnnounceWeekHonors(corrected.seasonId, corrected.week),
      );
    }
  }
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
        ? "Game removed — series recomputed; the corrected grand final is still decided, so the champion was re-crowned. No sync or captain can re-import it; press \u201cAuto-fetch games\u201d on this match to add it back."
        : corrected.uncrownedFinal
          ? "Game removed — series recomputed; the corrected grand final is still decided, but champion re-crowning could not be confirmed. No sync or captain can re-import it; press \u201cAuto-fetch games\u201d on this match to add it back."
          : "Game removed — series recomputed. No sync or captain can re-import it; press \u201cAuto-fetch games\u201d on this match to add it back.";
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
  const admin = await adminOrError();
  if ("error" in admin) return admin;
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
    /** Retimed fixtures that had no kickoff before (announced as "set"). */
    firstTimeIds: string[];
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
          scheduledAt: shiftMatchNight(match.scheduledAt!, new Date(current!), night),
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
            firstTimeIds: [],
            rsvps: 0,
            proposals: 0,
            hadCanonicalNight: current != null,
          };
        }

        for (const { match, scheduledAt } of moves) {
          const scrimClash = await findConfirmedScrimConflict(tx, {
            seasonId: expectedActiveSeasonId,
            teamIds: [match.homeTeamId, match.awayTeamId],
            scheduledAt,
          });
          if (scrimClash) {
            throw new ScrimScheduleConflictError(scrimClash);
          }
          const updated = await tx.match.updateMany({
            where: {
              id: match.id,
              seasonId: expectedActiveSeasonId,
              status: MATCH_STATUS.SCHEDULED,
              scheduledAt: match.scheduledAt,
            },
            data: { scheduledAt, scheduleRevision: { increment: 1 }, autoSyncedAt: null, autoSyncAttempts: 0 },
          });
          if (updated.count !== 1) throw new ScheduleMatchChangedError();
          // A nudge queued for the old kickoff must not post about it.
          await invalidateMatchNudges(tx, match.id);
        }

        // Keep the arithmetic anchor used for future playoff rounds aligned with
        // the moved league rhythm. If generation had no first night, derive the
        // missing week-1 anchor from the newly scheduled week.
        let firstMatchNight = currentSeason.firstMatchNight;
        if (week === 1) {
          firstMatchNight = night;
        } else if (firstMatchNight && delta !== 0) {
          firstMatchNight = shiftMatchNight(firstMatchNight, new Date(current!), night);
        } else if (!firstMatchNight) {
          firstMatchNight = matchNightForWeek(night, 2 - week);
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
          firstTimeIds: moves
            .filter(({ match }) => match.scheduledAt == null)
            .map(({ match }) => match.id),
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
    if (error instanceof ScrimScheduleConflictError) {
      return {
        error: `A new kickoff in this move falls within four hours of ${error.scrim}. ${error.fix} first, or pick another time.`,
      };
    }
    if (isSerializationConflict(error)) {
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
  const announced = await announceAdminRetime(
    outcome.retimedIds,
    outcome.rsvps,
    outcome.firstTimeIds,
  );
  return {
    ok: true,
    message:
      `Week ${week} moved to ${formatLeagueTime(night)} (${outcome.currentRetimed} scheduled match${outcome.currentRetimed === 1 ? "" : "es"} retimed)` +
      (cascade
        ? outcome.laterRetimed > 0
          ? ` · ${outcome.laterRetimed} later match${outcome.laterRetimed === 1 ? "" : "es"} shifted with it`
          : outcome.hadCanonicalNight
            ? " · later weeks unchanged (no time change)"
            : " · couldn't cascade (week had no previous time)"
        : "") +
      ` · ${outcome.rsvps} check-in(s) cleared · ${outcome.proposals} open reschedule proposal(s) cancelled` +
      (announced ? " · captains notified on Discord" : "") +
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
  const admin = await adminOrError();
  if ("error" in admin) return admin;
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
    /** The fixture had no kickoff before: announced as "set", not "moved". */
    firstTime: boolean;
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
                homeTeamId: true,
                awayTeamId: true,
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
            firstTime: false,
          };
        }
        const scrimClash = scheduledAt
          ? await findConfirmedScrimConflict(tx, {
              seasonId: expectedActiveSeasonId,
              teamIds: [before.homeTeamId, before.awayTeamId],
              scheduledAt,
            })
          : null;
        if (scrimClash) {
          throw new ScrimScheduleConflictError(scrimClash);
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
          data: { scheduledAt, scheduleRevision: { increment: 1 }, autoSyncedAt: null, autoSyncAttempts: 0 },
        });
        if (updated.count !== 1) throw new ScheduleMatchChangedError();
        // A nudge queued for the old kickoff must not post about it.
        await invalidateMatchNudges(tx, matchId);

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
          firstTime: before.scheduledAt == null,
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
    if (error instanceof ScrimScheduleConflictError) {
      return {
        error: `That kickoff falls within four hours of ${error.scrim}. ${error.fix} first, or pick another time.`,
      };
    }
    if (isSerializationConflict(error)) {
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
    summary: `${scheduledAt ? "Set" : "Cleared"} the kickoff for ${await fixtureLogName(matchId)} — cleared ${outcome.rsvps} check-in(s) and cancelled ${outcome.proposals} open reschedule proposal(s)`,
    seasonId: outcome.seasonId,
  });
  refresh();
  // Same double-booking risk as the week mover above. Clearing a kickoff
  // cannot create a same-night collision, so it needs no clash scan.
  const clashes = scheduledAt
    ? await clashesAfterRetime(outcome.seasonId, [matchId])
    : [];
  const announced = await announceAdminRetime(
    [matchId],
    outcome.rsvps,
    outcome.firstTime ? [matchId] : [],
  );
  return {
    message: `${
      scheduledAt
        ? `Kickoff time set to ${formatLeagueTime(scheduledAt)}`
        : "Kickoff time cleared · this match is now unscheduled; auto-sync, reminders and pick'em locks stay off until a new time is set"
    } · ${outcome.rsvps} check-in(s) cleared · ${outcome.proposals} open reschedule proposal(s) cancelled${
      scheduledAt
        ? " · the week's Discord reminder is eligible to re-send with the new time"
        : ""
    }${announced ? " · captains notified on Discord" : ""}${
      clashes.length
        ? ` · ⚠ standin clash: ${clashes.join("; ")} — remove one of those assignments`
        : ""
    }`,
  };
}

/** Import all games from the season's Dota league id (OpenDota). */
export async function syncLeagueAction(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const res = await syncLeagueGames(season.id);
  if (res.error) return { error: res.error };
  refreshGames();
  // Removed games stay removed here too; say how many, and the way back.
  const removed = res.removedSkipped ?? 0;
  return {
    message: `League sync · imported ${res.imported} of ${res.scanned} league games${
      removed > 0
        ? ` · skipped ${removed} ${removed === 1 ? "game" : "games"} an admin removed. To bring one back, open its match and press “Add game” with its match ID, or “Auto-fetch games”`
        : ""
    }`,
  };
}
