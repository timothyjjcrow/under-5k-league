// Add or remove a break (a league night with no games, season-breaks.ts) in
// one Serializable transaction: claim the season's break list as the admin's
// page showed it, then move the fixtures each round takes with it under the
// retime contract (season-schedule-playoffs.md, "Every retime follows one
// contract"). Rounds with no fixtures yet need nothing: tiebreaker and
// playoff rounds are dated from the breaks when they are built, inside their
// own Serializable transactions, which read the Season row this one writes.

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { MATCH_STATUS } from "./constants";
import { singleActiveSeason } from "./season";
import { UserFacingError } from "./user-facing-error";
import { raceHook } from "./race-hook";
import { invalidateMatchNudges } from "./announcement-marker";
import { releaseRetimedReminderMarker } from "./reminder-service";
import {
  describeScrimConflict,
  findConfirmedScrimConflict,
  scrimConflictFix,
} from "./scrim-schedule-conflict";
import { isSerializationConflict } from "./prisma-errors";
import {
  breakRemoveRefusal,
  breakShift,
  chooseBreak,
  parseBreakDates,
  serializeBreakDates,
  breakNight,
  seasonBreaksEditable,
  seasonBreaksToken,
} from "./season-breaks";

export type SeasonBreakChange = "ADD" | "REMOVE";

export type SeasonBreakOutcome = {
  seasonId: string;
  change: SeasonBreakChange;
  /** The break's stored date. */
  date: string;
  /** The night it skips (or skipped), or null before week 1's night is set. */
  night: Date | null;
  /** The season's breaks after the change. */
  breaks: string[];
  firstMatchNight: Date | null;
  moved: { id: string; week: number; from: Date; to: Date }[];
  /** Fixtures of a moved round left on a time someone arranged. */
  kept: { id: string; week: number; at: Date }[];
  /** Check-ins cleared on the moved fixtures. */
  rsvps: number;
  /** Open reschedule proposals cancelled on the moved fixtures. */
  proposals: number;
};

const STALE =
  "The season's breaks or schedule changed while this page was open. Nothing was changed; reload and try again.";

/**
 * Add the break on `date` ("YYYY-MM-DD", the night to skip) or remove the one
 * stored there. Throws a `UserFacingError` for every refusal, before or after
 * the first write, so a refusal never commits half a move.
 */
export async function changeSeasonBreak(input: {
  change: SeasonBreakChange;
  expectedActiveSeasonId: string;
  /** `seasonBreaksToken` of the season the form showed. */
  expectedBreaks: string;
  date: string;
  nowMs?: number;
}): Promise<SeasonBreakOutcome> {
  await raceHook("seasonBreaks.change.beforeTx");
  try {
    return await prisma.$transaction(
      async (tx) => {
        const nowMs = input.nowMs ?? Date.now();
        const [active, season] = await Promise.all([
          tx.season
            .findMany({
              where: { isActive: true },
              orderBy: { createdAt: "desc" },
              take: 2,
              select: { id: true },
            })
            .then(singleActiveSeason),
          tx.season.findUnique({
            where: { id: input.expectedActiveSeasonId },
            select: {
              id: true,
              isActive: true,
              status: true,
              firstMatchNight: true,
              breakDates: true,
            },
          }),
        ]);
        if (!season?.isActive || active?.id !== season.id) {
          throw new UserFacingError(
            "The active season changed while this page was open. Reload before changing its breaks.",
          );
        }
        if (!seasonBreaksEditable(season.status)) {
          throw new UserFacingError("The season is complete, so its breaks can't change.");
        }
        if (seasonBreaksToken(season.breakDates) !== input.expectedBreaks) {
          throw new UserFacingError(STALE);
        }
        const before = parseBreakDates(season.breakDates);
        let date = input.date.trim();
        let after: string[];
        if (input.change === "ADD") {
          const choice = chooseBreak({
            date,
            firstMatchNight: season.firstMatchNight,
            breaks: before,
            nowMs,
          });
          if (!choice.ok) throw new UserFacingError(choice.error);
          date = choice.date;
          after = [...before, date];
        } else {
          const refusal = breakRemoveRefusal({
            date,
            firstMatchNight: season.firstMatchNight,
            breaks: before,
            nowMs,
          });
          if (refusal) throw new UserFacingError(refusal);
          after = before.filter((other) => other !== date);
        }
        const night = breakNight(season.firstMatchNight, date);

        const fixtures = season.firstMatchNight
          ? await tx.match.findMany({
              where: { seasonId: season.id },
              orderBy: [{ week: "asc" }, { id: "asc" }],
              select: {
                id: true,
                week: true,
                status: true,
                scheduledAt: true,
                homeTeamId: true,
                awayTeamId: true,
              },
            })
          : [];
        const shift = season.firstMatchNight
          ? breakShift({
              firstMatchNight: season.firstMatchNight,
              before,
              after,
              fixtures,
            })
          : { moves: [], kept: [], started: [] };
        if (shift.started.length > 0) {
          const weeks = [...new Set(shift.started.map((fixture) => fixture.week))];
          throw new UserFacingError(
            `Week ${weeks.join(", ")} has already started, so its night can't move. Record or reopen its results first, or pick a later night.`,
          );
        }
        // League fixtures never land on a booked scrim: a break that moves a
        // round onto one names it instead, the same rule as the week mover.
        const teamsOf = new Map(
          fixtures.map((fixture) => [fixture.id, [fixture.homeTeamId, fixture.awayTeamId]]),
        );
        for (const move of shift.moves) {
          const clash = await findConfirmedScrimConflict(tx, {
            seasonId: season.id,
            teamIds: teamsOf.get(move.id)!,
            scheduledAt: move.to,
          });
          if (clash) {
            throw new UserFacingError(
              `A moved kickoff would fall within four hours of ${describeScrimConflict(clash)}. ${scrimConflictFix(clash)} first, or pick another night.`,
            );
          }
        }

        // Test seam (Postgres-only): everything above has read, nothing is
        // written yet.
        await raceHook("seasonBreaks.change.beforeWrite");
        // The first write claims the season exactly as judged: its breaks,
        // week 1's night (the week mover's cascade moves it) and its phase
        // (Start playoffs builds round one from the breaks).
        const nextBreakDates = serializeBreakDates(after);
        const claimed = await tx.season.updateMany({
          where: {
            id: season.id,
            isActive: true,
            status: season.status,
            breakDates: season.breakDates,
            firstMatchNight: season.firstMatchNight,
          },
          data: { breakDates: nextBreakDates },
        });
        if (claimed.count !== 1) throw new UserFacingError(STALE);

        for (const move of shift.moves) {
          const retimed = await tx.match.updateMany({
            where: {
              id: move.id,
              seasonId: season.id,
              status: MATCH_STATUS.SCHEDULED,
              scheduledAt: move.from,
            },
            data: {
              scheduledAt: move.to,
              scheduleRevision: { increment: 1 },
              autoSyncedAt: null,
              autoSyncAttempts: 0,
            },
          });
          if (retimed.count !== 1) throw new UserFacingError(STALE);
          // A nudge or reminder queued for the old kickoff must not post.
          await invalidateMatchNudges(tx, move.id);
        }
        const movedIds = shift.moves.map((move) => move.id);
        const [rsvps, proposals] =
          movedIds.length > 0
            ? await Promise.all([
                tx.matchAvailability.deleteMany({ where: { matchId: { in: movedIds } } }),
                tx.rescheduleRequest.updateMany({
                  where: { matchId: { in: movedIds }, status: "PENDING" },
                  data: { status: "CANCELLED" },
                }),
              ])
            : [{ count: 0 }, { count: 0 }];
        // Each old kickoff's reminder marker, once nothing scheduled is left
        // on it, so the new kickoff is reminded afresh and a kept fixture
        // sharing a kickoff isn't reminded twice.
        const released = new Set<string>();
        for (const move of shift.moves) {
          const kickoffKey = `${move.week}:${move.from.getTime()}`;
          if (released.has(kickoffKey)) continue;
          released.add(kickoffKey);
          await releaseRetimedReminderMarker(tx, {
            id: move.id,
            seasonId: season.id,
            week: move.week,
            oldKickoff: move.from,
          });
        }
        return {
          seasonId: season.id,
          change: input.change,
          date,
          night,
          breaks: after,
          firstMatchNight: season.firstMatchNight,
          moved: shift.moves,
          kept: shift.kept,
          rsvps: rsvps.count,
          proposals: proposals.count,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isSerializationConflict(error)) throw new UserFacingError(STALE);
    throw error;
  }
}
