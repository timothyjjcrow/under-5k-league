// Captain-to-captain rescheduling rules, separated from the server actions
// so the guards are integration-testable (same pattern as draft-service).
// Every expected rule violation throws UserFacingError; the action boundary
// never serializes arbitrary database or provider exception text.
//
// A proposal is a ready check (reschedule-ready-check.ts decides): a captain
// offers up to three times, everyone playing the match answers each one, and
// the match moves when an option has both captains and a full lineup on each
// side (voteReschedule), or when a captain locks in a time the other captain
// has said yes to (lockInReschedule; respondReschedule's accept is the
// opposing captain's lock). Every move goes through retimeToOption.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS } from "@/lib/constants";
import { clashesAfterRetime } from "./standin-service";
import { loadSidePlayerIds } from "./availability-service";
import { AVAILABILITY } from "./availability";
import { isPlayoffPhase, matchLogisticsOpen } from "./league-lifecycle";
import { weekReminderKey } from "./settings";
import { invalidateMatchNudges } from "./announcement-marker";
import { singleActiveSeason } from "./season";
import { UserFacingError } from "./user-facing-error";
import {
  describeScrimConflict,
  findConfirmedScrimConflict,
  scrimConflictFix,
} from "./scrim-schedule-conflict";
import { findFixtureConflict } from "./fixture-conflict";
import {
  RESCHEDULE_MAX_AHEAD_MS,
  RESCHEDULE_PAST_GRACE_MS,
  rescheduleDeadline,
} from "./schedule";
import { roundLabelsForPost } from "./playoff-rounds";
import { isSerializationConflict } from "./prisma-errors";
import { raceHook } from "./race-hook";
import { formatLeagueTime } from "./zoned-time";
import {
  lockRefusal,
  normalizeRescheduleNote,
  normalizeRescheduleOptions,
  parseRescheduleOptions,
  serializeRescheduleOptions,
  tallyOption,
  withProposerYes,
  type ReadySide,
  type ReadyVote,
} from "./reschedule-ready-check";

type Tx = Prisma.TransactionClient;

/** How the locked time stood in the ready check when it moved the match. */
export type LockedReadyCheck = {
  /** Both captains and a full lineup each side were in: it locked itself. */
  everyoneIn: boolean;
  /** Players (seats) who said yes to the locked time, out of `seats`. */
  ready: number;
  seats: number;
  /** Seats who said they can't make it: now checked in as OUT. */
  outNames: string[];
  /** Seats who never answered the locked time: they still owe a check-in,
   *  so the announcement mentions them. User ids, not snowflakes. */
  awaitingUserIds: string[];
  /** Answers carried over as check-ins for the new kickoff. */
  carriedIn: number;
  carriedOut: number;
};

export type AcceptedReschedule = {
  /** For the announcement's match-page link. */
  matchId: string;
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  /** `matchRoundLabel` ("Semifinal"), so the post names a playoff round. */
  roundLabel: string | null;
  newTime: Date;
  /** The captain who PROPOSED it — they asked and have been waiting. */
  notifyUserId: string | null;
  /** Check-in rows the retime replaced (answers about the old night). */
  clearedRsvps: number;
  /** Standins now double-booked because this match moved — surfaced in the toast. */
  standinClashes: string[];
  /**
   * Standins ASSIGNED to this match — their personally-@-mentioned assignment
   * message embedded the OLD kickoff, and the acceptance broadcast is the one
   * message that carries the new one, so the action mentions them alongside
   * the proposer. User ids, not snowflakes (the notifyUserId rule).
   */
  standinUserIds: string[];
  readyCheck: LockedReadyCheck;
};

// Announcement data for a fresh proposal (mirrors AcceptedReschedule) — the
// action layer does the Discord send, so a webhook failure can never affect
// the proposal write itself.
export type ProposedReschedule = {
  /** For the announcement's link to the Reschedule card. */
  matchId: string;
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  /** `matchRoundLabel` ("Semifinal"), so the post names a playoff round. */
  roundLabel: string | null;
  /** The earliest option (every option is in `options`). */
  proposedTime: Date;
  /** Every time on offer, ascending. */
  options: Date[];
  note: string | null;
  /**
   * The captain who owes an answer (the OTHER one). A proposal is a question
   * addressed to exactly one person; the action resolves this to a mention so
   * it doesn't sit unread in a channel until kickoff. User id, not a snowflake
   * — the service stays free of Discord concerns.
   */
  notifyUserId: string | null;
  /**
   * Everyone else who answers the ready check: the players on both sides
   * (standins included), minus the proposer and the other captain. Read
   * after the commit; user ids, not snowflakes.
   */
  readyCheckUserIds: string[];
  /** The match's kickoff revision: the roster-ping throttle's window key. */
  scheduleRevision: number;
};

export type DeclinedReschedule = {
  /** For the announcement's link to the Reschedule card. */
  matchId: string;
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  /** `matchRoundLabel` ("Semifinal"), so the post names a playoff round. */
  roundLabel: string | null;
  /** The time that was refused — named so a channel that has seen several
   *  proposals go by can tell WHICH one this closes. */
  proposedTime: Date;
  /** Every time the ready check offered (epoch ms, ascending), all of them
   *  turned down by "None of these work". */
  optionTimes: number[];
  /** The PROPOSER. They asked a question and have been waiting; a decline is
   *  addressed to exactly one person, same as the proposal was. */
  notifyUserId: string;
};

/**
 * Discriminated so the action can send the right message without a null check
 * that silently means "declined" — which is exactly how the decline went
 * unannounced for as long as it did: `respondReschedule` returned null and the
 * action's `if (accepted)` skipped every send.
 */
export type RescheduleOutcome =
  | (AcceptedReschedule & { accepted: true })
  | (DeclinedReschedule & { accepted: false });

export type RespondRescheduleOptions = {
  /**
   * Which option to accept. Required when the proposal offers more than one
   * time; a single-option proposal accepts its only time.
   */
  optionTime?: Date;
  /**
   * Runs immediately after an accepted retime commits and before fallible
   * presentation reads. It is deliberately best-effort: cache signalling can
   * never turn a successful database write into a failed response.
   */
  onAcceptedCommit?: () => void;
};

/** A ready-check answer, and the move it triggered if it was the last one. */
export type VoteOutcome =
  | { locked: AcceptedReschedule }
  | {
      locked: null;
      /** Everyone was in, but the time no longer fits the calendar: the
       *  answer is saved and this says why nothing moved. */
      lockBlocked: string | null;
    };

/** Tries for a ready-check answer that loses a serialization race. */
const VOTE_ATTEMPTS = 3;

// Sanity bounds for a proposed time (`schedule.ts` explains them; /rules
// quotes them).

function assertSaneProposedTime(proposedTime: Date, now = new Date()): void {
  if (!Number.isFinite(proposedTime.getTime()))
    throw new UserFacingError("Choose a valid proposed time");
  if (proposedTime.getTime() < now.getTime() - RESCHEDULE_PAST_GRACE_MS)
    throw new UserFacingError("That time is in the past");
  if (proposedTime.getTime() > now.getTime() + RESCHEDULE_MAX_AHEAD_MS)
    throw new UserFacingError("That time is too far out — check the year");
}

type CalendarMatch = {
  id: string;
  seasonId: string;
  phase: string;
  homeTeamId: string;
  awayTeamId: string;
};

/**
 * Why `time` can't be this match's kickoff, or null when it fits: a booked
 * scrim of either team, another fixture of either team within four hours, or
 * past the playoff deadline. Checked when a time is proposed and again when
 * it is locked in (a proposal can sit open while the schedule moves);
 * `stage` picks the wording for each.
 */
async function calendarProblem(
  tx: Tx,
  match: CalendarMatch,
  firstMatchNight: Date | null,
  time: Date,
  stage: "propose" | "lock",
): Promise<string | null> {
  const scrimClash = await findConfirmedScrimConflict(tx, {
    seasonId: match.seasonId,
    teamIds: [match.homeTeamId, match.awayTeamId],
    scheduledAt: time,
  });
  if (scrimClash)
    return stage === "propose"
      ? `That time is within four hours of ${describeScrimConflict(scrimClash)}. ${scrimConflictFix(scrimClash)} first, or pick another time.`
      : `That time is now within four hours of ${describeScrimConflict(scrimClash)}. ${scrimConflictFix(scrimClash)} first, or propose another time.`;
  const clash = await findFixtureConflict(tx, {
    seasonId: match.seasonId,
    teamIds: [match.homeTeamId, match.awayTeamId],
    scheduledAt: time,
    exceptMatchId: match.id,
  });
  if (clash)
    return `That is within four hours of ${clash.homeName} vs ${clash.awayName} (${clash.label}) — pick another time`;
  const deadline = await loadRescheduleDeadline(
    tx,
    match,
    firstMatchNight,
    Date.now(),
  );
  if (deadline && time.getTime() >= deadline.getTime())
    return "Regular-season matches must be played before the playoffs start — pick an earlier time, or ask an admin";
  return null;
}

/**
 * The instant a regular-season match must move to BEFORE (exclusive), or null
 * when there is no limit. One read for both the propose/accept check above
 * and the match page's form hint, so the two can't disagree.
 */
export async function loadRescheduleDeadline(
  db: Pick<Prisma.TransactionClient, "match">,
  match: { seasonId: string; phase: string },
  firstMatchNight: Date | null,
  nowMs: number,
): Promise<Date | null> {
  if (match.phase !== MATCH_PHASE.REGULAR) return null;
  const [lastRegular, firstPostseason] = await Promise.all([
    db.match.aggregate({
      where: { seasonId: match.seasonId, phase: MATCH_PHASE.REGULAR },
      _max: { week: true },
    }),
    db.match.findFirst({
      where: {
        seasonId: match.seasonId,
        phase: { not: MATCH_PHASE.REGULAR },
        scheduledAt: { not: null },
      },
      orderBy: { scheduledAt: "asc" },
      select: { scheduledAt: true },
    }),
  ]);
  return rescheduleDeadline({
    phase: match.phase,
    firstMatchNight,
    lastRegularWeek: lastRegular._max.week ?? 0,
    earliestPostseasonKickoffMs: firstPostseason?.scheduledAt?.getTime() ?? null,
    nowMs,
  });
}

/**
 * The fixture's round name for a post (`matchRoundLabel`, "Semifinal"). Read
 * after the write commits, never inside the SERIALIZABLE transaction: a
 * display label has no business in its read set.
 */
async function postRoundLabel(match: {
  id: string;
  seasonId: string;
  phase: string;
  week: number;
  bracketSlot: string | null;
}): Promise<string | null> {
  return (await roundLabelsForPost([match])).get(match.id) ?? null;
}

/** The active season, with what every reschedule decision reads from it. */
function loadActiveSeason(tx: Tx) {
  return tx.season
    .findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: {
        id: true,
        status: true,
        teamSize: true,
        firstMatchNight: true,
        draft: { select: { status: true } },
      },
    })
    .then(singleActiveSeason);
}

type ActiveSeason = NonNullable<Awaited<ReturnType<typeof loadActiveSeason>>>;

/**
 * Refuse unless `match` can still move: it belongs to the active season, the
 * league is past the auction, and the series hasn't started. These are
 * authority reads, so season turnover, a phase change or a result between a
 * page render and this click is decisive here at write time.
 */
function assertMatchCanMove(
  activeSeason: ActiveSeason | null,
  match: { seasonId: string; status: string },
): asserts activeSeason is ActiveSeason {
  // An archived season's unplayed match keeps its captains. Opening or
  // settling a negotiation there would also send a live Discord mention
  // about a dead fixture. Decline/withdraw remain legal cleanup.
  if (!activeSeason || match.seasonId !== activeSeason.id)
    throw new UserFacingError("This match belongs to an archived season");
  if (
    !matchLogisticsOpen(
      activeSeason.status,
      activeSeason.draft?.status,
      match.status,
    )
  ) {
    if (match.status === MATCH_STATUS.COMPLETED)
      throw new UserFacingError("This match is already played");
    if (match.status === MATCH_STATUS.LIVE)
      throw new UserFacingError("This match is already live");
    throw new UserFacingError("Rescheduling is not open in this league phase");
  }
}

/** Who plays each side of this fixture tonight (loadSidePlayerIds). */
async function loadSides(
  tx: Tx,
  match: {
    id: string;
    seasonId: string;
    homeTeamId: string;
    awayTeamId: string;
    homeTeam: { captainId: string };
    awayTeam: { captainId: string };
  },
): Promise<{ home: ReadySide; away: ReadySide }> {
  const [home, away] = await Promise.all([
    loadSidePlayerIds(tx, match, match.homeTeamId),
    loadSidePlayerIds(tx, match, match.awayTeamId),
  ]);
  return {
    home: {
      teamId: match.homeTeamId,
      captainId: match.homeTeam.captainId,
      seatIds: [...home],
    },
    away: {
      teamId: match.awayTeamId,
      captainId: match.awayTeam.captainId,
      seatIds: [...away],
    },
  };
}

/** Every answer to one option, the proposer's implied yes included. */
async function loadOptionVotes(
  tx: Tx,
  request: { id: string; proposedById: string },
  time: Date,
): Promise<ReadyVote[]> {
  const rows = await tx.rescheduleVote.findMany({
    where: { requestId: request.id, time },
    select: { userId: true, ready: true },
  });
  return withProposerYes(
    rows.map((row) => ({
      userId: row.userId,
      timeMs: time.getTime(),
      ready: row.ready,
    })),
    request.proposedById,
    [time.getTime()],
  );
}

/** Option `time` of this request, or a refusal when it isn't one. */
function assertIsOption(
  request: { options: string | null; proposedTime: Date },
  time: Date,
): void {
  if (
    !parseRescheduleOptions(request.options, request.proposedTime).includes(
      time.getTime(),
    )
  )
    throw new UserFacingError("That time isn't one of the options");
}

/** What retimeToOption hands back to the caller's announcement. */
type RetimeCommit = {
  clearedRsvps: number;
  standinUserIds: string[];
  readyCheck: Omit<LockedReadyCheck, "outNames"> & { outUserIds: string[] };
};

/**
 * Move the match to the locked option, inside the caller's SERIALIZABLE
 * transaction, after every refusal has been judged. It claims the request
 * (PENDING to ACCEPTED, recording the winning time and when) and the match (still
 * SCHEDULED), then follows the retime contract (season-schedule-playoffs.md):
 * new scheduleRevision, fresh auto-sync window, queued nudges dropped,
 * reminder markers released. Check-ins answered the OLD night, so they go;
 * each player's answer to the locked time becomes their check-in for the new
 * one, so nobody answers twice. Past the first write every failure throws.
 */
async function retimeToOption(
  tx: Tx,
  request: { id: string },
  match: {
    id: string;
    seasonId: string;
    week: number;
    scheduleRevision: number;
  },
  time: Date,
  sides: { home: ReadySide; away: ReadySide },
  votes: ReadyVote[],
  everyoneIn: boolean,
): Promise<RetimeCommit> {
  const lockedAt = new Date();
  const accepted = await tx.rescheduleRequest.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: { status: "ACCEPTED", proposedTime: time, lockedAt: lockedAt },
  });
  if (accepted.count === 0)
    throw new UserFacingError("That proposal is no longer open");
  const retimed = await tx.match.updateMany({
    where: { id: match.id, status: MATCH_STATUS.SCHEDULED },
    // New kickoff ⇒ new detection window: clear the backoff accrued
    // against the old one so the moved night is scanned promptly.
    data: {
      scheduledAt: time,
      scheduleRevision: { increment: 1 },
      autoSyncedAt: null,
      autoSyncAttempts: 0,
    },
  });
  if (retimed.count === 0)
    throw new UserFacingError("That match is no longer awaiting play");
  // A "we couldn't find your games" nudge queued for the old kickoff
  // must not post about it.
  await invalidateMatchNudges(tx, match.id);

  // Every RSVP answered the OLD night. Clear them and release the old
  // reminder marker atomically with the retime.
  const [cleared, standins] = await Promise.all([
    tx.matchAvailability.deleteMany({ where: { matchId: match.id } }),
    tx.standinAssignment.findMany({
      where: { matchId: match.id },
      select: { standinUserId: true },
    }),
    tx.setting.deleteMany({
      where: {
        OR: [
          { key: weekReminderKey(match.seasonId, match.week) },
          {
            key: {
              startsWith: `${weekReminderKey(match.seasonId, match.week)}:`,
            },
          },
        ],
      },
    }),
  ]);

  // The ready check already asked about THIS night: carry each seat's answer
  // over as their check-in for the new kickoff (the revision just bumped).
  const answerOf = new Map(
    votes
      .filter((v) => v.timeMs === time.getTime())
      .map((v) => [v.userId, v.ready]),
  );
  const seatIds = [...new Set([...sides.home.seatIds, ...sides.away.seatIds])];
  const carried = seatIds.flatMap((userId) => {
    const ready = answerOf.get(userId);
    return ready === undefined
      ? []
      : [
          {
            matchId: match.id,
            userId,
            status: ready ? AVAILABILITY.IN : AVAILABILITY.OUT,
            scheduleRevision: match.scheduleRevision + 1,
          },
        ];
  });
  if (carried.length) await tx.matchAvailability.createMany({ data: carried });
  const outUserIds = carried
    .filter((row) => row.status === AVAILABILITY.OUT)
    .map((row) => row.userId);
  return {
    clearedRsvps: cleared.count,
    standinUserIds: standins.map((s) => s.standinUserId),
    readyCheck: {
      everyoneIn,
      ready: carried.length - outUserIds.length,
      seats: seatIds.length,
      outUserIds,
      awaitingUserIds: seatIds.filter((id) => !answerOf.has(id)),
      carriedIn: carried.length - outUserIds.length,
      carriedOut: outUserIds.length,
    },
  };
}

/** The committed lock, before the presentation reads that follow it. */
type LockCommit = RetimeCommit & {
  matchId: string;
  seasonId: string;
  phase: string;
  week: number;
  bracketSlot: string | null;
  homeName: string;
  awayName: string;
  newTime: Date;
  proposerId: string;
};

/**
 * The announcement for a committed lock. Every read here comes after the
 * commit (never inside the SERIALIZABLE transaction) and is presentation.
 */
async function acceptedFromCommit(
  commit: LockCommit,
  onAcceptedCommit?: () => void,
): Promise<AcceptedReschedule> {
  try {
    onAcceptedCommit?.();
  } catch {
    // A missed cache signal is bounded by the automation gate's hard wake.
  }
  // Accepting a reschedule moves the fixture, which can put a standin on two
  // games the same night — standinConflict is only checked when cover is
  // arranged, never when a match later moves onto that night. Reported, not
  // refused: the reschedule is the legitimate act.
  const [standinClashes, roundLabel, outPeople] = await Promise.all([
    clashesAfterRetime(commit.seasonId, [commit.matchId]),
    postRoundLabel({
      id: commit.matchId,
      seasonId: commit.seasonId,
      phase: commit.phase,
      week: commit.week,
      bracketSlot: commit.bracketSlot,
    }),
    commit.readyCheck.outUserIds.length
      ? prisma.user.findMany({
          where: { id: { in: commit.readyCheck.outUserIds } },
          select: { name: true },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        })
      : Promise.resolve([]),
  ]);
  const { outUserIds: _out, ...readyCheck } = commit.readyCheck;
  void _out;
  return {
    matchId: commit.matchId,
    homeName: commit.homeName,
    awayName: commit.awayName,
    week: commit.week,
    isPlayoff: isPlayoffPhase(commit.phase),
    isTiebreaker: commit.phase === MATCH_PHASE.TIEBREAKER,
    roundLabel,
    newTime: commit.newTime,
    notifyUserId: commit.proposerId,
    clearedRsvps: commit.clearedRsvps,
    standinUserIds: commit.standinUserIds,
    standinClashes,
    readyCheck: { ...readyCheck, outNames: outPeople.map((p) => p.name) },
  };
}

/**
 * Create (or supersede) the match's open proposal: one time, or up to three
 * for the ready check. Captains only.
 */
export async function proposeReschedule(
  userId: string,
  matchId: string,
  proposed: Date | Date[],
  extra: { note?: string | null } = {},
): Promise<ProposedReschedule> {
  const picked = Array.isArray(proposed) ? proposed : [proposed];
  for (const time of picked) assertSaneProposedTime(time);
  const normalized = normalizeRescheduleOptions(picked.map((t) => t.getTime()));
  if ("error" in normalized) throw new UserFacingError(normalized.error);
  const noteResult = normalizeRescheduleNote(extra.note);
  if ("error" in noteResult) throw new UserFacingError(noteResult.error);
  const times = normalized.times.map((t) => new Date(t));
  // With several options a refusal names the one it is about.
  const which = (time: Date) =>
    times.length > 1 ? `${formatLeagueTime(time)}: ` : "";

  // Replace any open proposal — the newest ask is the only live one.
  // SERIALIZABLE because there is no unique constraint enforcing "at most one
  // PENDING per match": on Postgres read-committed, two captains proposing in
  // the same instant each cancel what they can see and then both insert,
  // leaving TWO open proposals. The loser was a zombie the other captain could
  // accept days later, retiming the match out from under everyone.
  let proposed_;
  try {
    proposed_ = await prisma.$transaction(
      async (tx) => {
        const [activeSeason, match] = await Promise.all([
          loadActiveSeason(tx),
          tx.match.findUnique({
            where: { id: matchId },
            include: { homeTeam: true, awayTeam: true },
          }),
        ]);
        if (!match) throw new UserFacingError("Match not found");
        if (
          match.homeTeam.captainId !== userId &&
          match.awayTeam.captainId !== userId
        )
          throw new UserFacingError("Only the two captains can propose a time");
        assertMatchCanMove(activeSeason, match);
        for (const time of times) {
          // An unscheduled SCHEDULED match may use a proposal to receive its
          // first kickoff. Once it has one, proposing that exact instant
          // creates a notification and approval task that cannot change
          // anything.
          if (match.scheduledAt?.getTime() === time.getTime())
            throw new UserFacingError(
              `${which(time)}That is already this match's kickoff`,
            );
          const problem = await calendarProblem(
            tx,
            match,
            activeSeason.firstMatchNight,
            time,
            "propose",
          );
          if (problem) throw new UserFacingError(`${which(time)}${problem}`);
        }

        await tx.rescheduleRequest.updateMany({
          where: { matchId, status: "PENDING" },
          data: { status: "CANCELLED" },
        });
        await tx.rescheduleRequest.create({
          data: {
            matchId,
            proposedById: userId,
            proposedTime: times[0],
            options: serializeRescheduleOptions(times.map((t) => t.getTime())),
            note: noteResult.note,
          },
        });

        return {
          match,
          fixture: {
            id: match.id,
            seasonId: match.seasonId,
            phase: match.phase,
            week: match.week,
            bracketSlot: match.bracketSlot,
          },
          announcement: {
            matchId: match.id,
            homeName: match.homeTeam.name,
            awayName: match.awayTeam.name,
            week: match.week,
            isPlayoff: isPlayoffPhase(match.phase),
            isTiebreaker: match.phase === MATCH_PHASE.TIEBREAKER,
            proposedTime: times[0],
            options: times,
            note: noteResult.note,
            // The proposer is one of the two captains (asserted above), so
            // the counterpart is simply the other one.
            notifyUserId:
              match.homeTeam.captainId === userId
                ? match.awayTeam.captainId
                : match.homeTeam.captainId,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isSerializationConflict(error))
      throw new UserFacingError(
        "That match just changed — reload and try again",
      );
    throw error;
  }
  const { match, fixture, announcement } = proposed_;
  // Who answers the ready check, read after the commit: an announcement
  // audience, not part of the decision.
  const sides = await loadSides(prisma, match);
  const readyCheckUserIds = [
    ...new Set([...sides.home.seatIds, ...sides.away.seatIds]),
  ].filter((id) => id !== userId && id !== announcement.notifyUserId);
  return {
    ...announcement,
    roundLabel: await postRoundLabel(fixture),
    readyCheckUserIds,
    scheduleRevision: match.scheduleRevision,
  };
}

/** The open request and its match, as every ready-check write reads them. */
function loadRequest(tx: Tx, requestId: string) {
  return tx.rescheduleRequest.findUnique({
    where: { id: requestId },
    include: { match: { include: { homeTeam: true, awayTeam: true } } },
  });
}

type LoadedRequest = NonNullable<Awaited<ReturnType<typeof loadRequest>>>;

/**
 * Judge and commit a lock of `time` by `userId`, inside the caller's
 * SERIALIZABLE transaction. Every refusal is judged before the first write.
 */
async function lockInTx(
  tx: Tx,
  request: LoadedRequest,
  userId: string,
  time: Date,
): Promise<LockCommit> {
  const { match } = request;
  const activeSeason = await loadActiveSeason(tx);
  assertMatchCanMove(activeSeason, match);
  assertIsOption(request, time);
  // A proposal may have sat open while the time aged out or an admin
  // independently moved the match. Recheck both against fresh state.
  assertSaneProposedTime(time);
  if (match.scheduledAt?.getTime() === time.getTime())
    throw new UserFacingError("That is already this match's kickoff");
  const problem = await calendarProblem(
    tx,
    match,
    activeSeason.firstMatchNight,
    time,
    "lock",
  );
  if (problem) throw new UserFacingError(problem);

  const sides = await loadSides(tx, match);
  // Locking agrees to the TIME; it is the locker's yes only when they gave
  // no answer of their own. A captain who said "✗ Can't" can still lock a
  // time their team can make with cover, and their ✗ stands: it carries
  // over as an OUT check-in and is listed as out, never silently rewritten
  // to IN (the team turned up one short, with no "out with no cover" to-do).
  const stored = await loadOptionVotes(tx, request, time);
  const own = stored.find((v) => v.userId === userId);
  const votes = [
    ...stored.filter((v) => v.userId !== userId),
    own ?? { userId, timeMs: time.getTime(), ready: true },
  ];
  const tally = tallyOption(time.getTime(), sides, votes, activeSeason.teamSize);
  const refusal = lockRefusal(tally, userId, {
    homeCaptainId: match.homeTeam.captainId,
    awayCaptainId: match.awayTeam.captainId,
  });
  if (refusal) throw new UserFacingError(refusal);

  // Seam: a result completing the match between the SCHEDULED read (the
  // request's Match, loaded with it) and the retime below, which racing
  // cannot steer (the accept may just as well commit first, a legitimate
  // retime-then-play). The rival writes only the Match row, which this
  // transaction has READ but not written, so a second connection cannot
  // deadlock on it. Named for the accept that first carried it; a captain's
  // lock runs the same code.
  await raceHook("reschedule.respondReschedule.beforeAccept");
  const commit = await retimeToOption(
    tx,
    request,
    match,
    time,
    sides,
    votes,
    tally.everyoneIn,
  );
  // Record the yes the lock implied when the locker hadn't answered, so the
  // request's answers say who agreed; an answer they gave is left as given.
  await tx.rescheduleVote.upsert({
    where: {
      requestId_userId_time: { requestId: request.id, userId, time },
    },
    create: { requestId: request.id, userId, time, ready: true },
    update: {},
  });
  return {
    ...commit,
    matchId: match.id,
    seasonId: match.seasonId,
    phase: match.phase,
    week: match.week,
    bracketSlot: match.bracketSlot,
    homeName: match.homeTeam.name,
    awayName: match.awayTeam.name,
    newTime: time,
    proposerId: request.proposedById,
  };
}

/**
 * Answer the ready check: can `userId` make option `time`? Anyone playing the
 * match (a seat on either side) and both captains may answer, and change
 * their answer, while the proposal is open. The answer that brings an option
 * to "everyone's in" moves the match in the same transaction.
 *
 * An answer that loses a serialization race is retried: it is an idempotent
 * upsert, and the retry is what notices when two last answers arrived at
 * once (each alone saw the option one short).
 */
export async function voteReschedule(
  userId: string,
  requestId: string,
  time: Date,
  ready: boolean,
  options: { onAcceptedCommit?: () => void } = {},
): Promise<VoteOutcome> {
  for (let attempt = 1; ; attempt++) {
    let outcome;
    try {
      outcome = await prisma.$transaction(
        async (tx) => {
          const request = await loadRequest(tx, requestId);
          if (!request) throw new UserFacingError("That proposal is gone");
          if (request.status === "ACCEPTED")
            throw new UserFacingError(
              "A time is already locked in — reload to see it",
            );
          if (request.status !== "PENDING")
            throw new UserFacingError("That proposal is no longer open");
          const { match } = request;
          const activeSeason = await loadActiveSeason(tx);
          assertMatchCanMove(activeSeason, match);
          assertIsOption(request, time);
          if (time.getTime() <= Date.now())
            throw new UserFacingError("That time has already passed");

          const sides = await loadSides(tx, match);
          const plays =
            sides.home.seatIds.includes(userId) ||
            sides.away.seatIds.includes(userId) ||
            userId === match.homeTeam.captainId ||
            userId === match.awayTeam.captainId;
          if (!plays)
            throw new UserFacingError(
              "Only the players and captains in this match answer its ready check",
            );

          await tx.rescheduleVote.upsert({
            where: {
              requestId_userId_time: { requestId, userId, time },
            },
            create: { requestId, userId, time, ready },
            update: { ready },
          });

          const votes = await loadOptionVotes(tx, request, time);
          const tally = tallyOption(
            time.getTime(),
            sides,
            votes,
            activeSeason.teamSize,
          );
          if (!tally.everyoneIn) return { locked: null, lockBlocked: null };
          // Everyone's in. Re-judge the calendar now (it may have moved since
          // the proposal); a time that no longer fits keeps the answer and
          // says why it didn't move.
          const blocked =
            match.scheduledAt?.getTime() === time.getTime()
              ? "That is already this match's kickoff"
              : await calendarProblem(
                  tx,
                  match,
                  activeSeason.firstMatchNight,
                  time,
                  "lock",
                );
          if (blocked) return { locked: null, lockBlocked: blocked };
          const commit = await retimeToOption(
            tx,
            request,
            match,
            time,
            sides,
            votes,
            true,
          );
          return {
            locked: {
              ...commit,
              matchId: match.id,
              seasonId: match.seasonId,
              phase: match.phase,
              week: match.week,
              bracketSlot: match.bracketSlot,
              homeName: match.homeTeam.name,
              awayName: match.awayTeam.name,
              newTime: time,
              proposerId: request.proposedById,
            } satisfies LockCommit,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isSerializationConflict(error)) {
        if (attempt < VOTE_ATTEMPTS) continue;
        throw new UserFacingError(
          "That ready check just changed — reload and try again",
        );
      }
      throw error;
    }
    if (!outcome.locked)
      return { locked: null, lockBlocked: outcome.lockBlocked };
    return {
      locked: await acceptedFromCommit(
        outcome.locked,
        options.onAcceptedCommit,
      ),
    };
  }
}

/**
 * A captain locks option `time` in without waiting for the rest of the ready
 * check. Allowed once the OTHER captain has said yes to it (the locker's yes
 * is the lock itself): the lineup is reported, never required.
 */
export async function lockInReschedule(
  userId: string,
  requestId: string,
  time: Date,
  options: { onAcceptedCommit?: () => void } = {},
): Promise<AcceptedReschedule> {
  let commit;
  try {
    commit = await prisma.$transaction(
      async (tx) => {
        const request = await loadRequest(tx, requestId);
        if (!request || request.status !== "PENDING")
          throw new UserFacingError("That proposal is no longer open");
        return lockInTx(tx, request, userId, time);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isSerializationConflict(error))
      throw new UserFacingError(
        "That proposal or match just changed — reload and try again",
      );
    throw error;
  }
  return acceptedFromCommit(commit, options.onAcceptedCommit);
}

/**
 * Accept or decline the open proposal. Only the opposing captain may respond;
 * accepting is their lock of one option (lockInTx) and retimes the match.
 */
export async function respondReschedule(
  userId: string,
  requestId: string,
  accept: boolean,
  options: RespondRescheduleOptions = {},
): Promise<RescheduleOutcome> {
  let outcome;
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        const request = await loadRequest(tx, requestId);
        if (!request || request.status !== "PENDING")
          throw new UserFacingError("That proposal is no longer open");
        const { match } = request;
        const isCaptain =
          match.homeTeam.captainId === userId ||
          match.awayTeam.captainId === userId;
        if (!isCaptain || request.proposedById === userId)
          throw new UserFacingError("Only the opposing captain can respond");

        if (!accept) {
          // Decline is cleanup, so it stays legal after a phase change, result,
          // or season archival. Authority and request state are still read and
          // claimed in this transaction so an old page cannot override a
          // concurrent supersede/withdraw.
          const declined = await tx.rescheduleRequest.updateMany({
            where: { id: requestId, status: "PENDING" },
            data: { status: "DECLINED" },
          });
          if (declined.count === 0)
            throw new UserFacingError("That proposal is no longer open");
          return {
            accepted: false as const,
            fixture: {
              id: match.id,
              seasonId: match.seasonId,
              phase: match.phase,
              week: match.week,
              bracketSlot: match.bracketSlot,
            },
            matchId: match.id,
            homeName: match.homeTeam.name,
            awayName: match.awayTeam.name,
            week: match.week,
            isPlayoff: isPlayoffPhase(match.phase),
            isTiebreaker: match.phase === MATCH_PHASE.TIEBREAKER,
            proposedTime: request.proposedTime,
            // Every time on offer: the post names how many were turned down.
            optionTimes: parseRescheduleOptions(
              request.options,
              request.proposedTime,
            ),
            notifyUserId: request.proposedById,
          };
        }

        const offered = parseRescheduleOptions(
          request.options,
          request.proposedTime,
        );
        const time =
          options.optionTime ??
          (offered.length === 1 ? new Date(offered[0]) : null);
        if (!time) throw new UserFacingError("Pick which time to accept");
        return {
          accepted: true as const,
          commit: await lockInTx(tx, request, userId, time),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isSerializationConflict(error))
      throw new UserFacingError(
        "That proposal or match just changed — reload and try again",
      );
    throw error;
  }

  if (!outcome.accepted) {
    const { fixture, ...declined } = outcome;
    return { ...declined, roundLabel: await postRoundLabel(fixture) };
  }
  return {
    accepted: true,
    ...(await acceptedFromCommit(outcome.commit, options.onAcceptedCommit)),
  };
}

/** Withdraw an open proposal — the proposer or an admin. */
export async function cancelReschedule(
  userId: string,
  requestId: string,
  isAdmin: boolean,
): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        const request = await tx.rescheduleRequest.findUnique({
          where: { id: requestId },
        });
        if (!request || request.status !== "PENDING")
          throw new UserFacingError("That proposal is no longer open");
        if (request.proposedById !== userId && !isAdmin)
          throw new UserFacingError("Only the proposer can withdraw it");
        const cancelled = await tx.rescheduleRequest.updateMany({
          where: { id: requestId, status: "PENDING" },
          data: { status: "CANCELLED" },
        });
        if (cancelled.count === 0)
          throw new UserFacingError("That proposal is no longer open");
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isSerializationConflict(error))
      throw new UserFacingError(
        "That proposal just changed — reload and try again",
      );
    throw error;
  }
}
