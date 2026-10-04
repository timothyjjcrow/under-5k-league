// The match-night poll's database side. The rules (slots, labels, the
// instant-runoff count) are pure in match-night-poll.ts; this file stores
// polls and ballots under the guards CLAUDE.md's two concurrency rules ask
// for.
//
// The rivals, by path:
// - a ballot against "Close voting now" or a deadline passing: every ballot
//   write first claims the poll row with `closesAt > now` in its WHERE, so a
//   close that commits first refuses the ballot, and one that commits second
//   waits on the row lock and counts it.
// - two admins opening polls, or reopening an old poll while another opens:
//   "at most one open poll" is a predicate over the whole table, so both
//   sides re-read it inside a Serializable transaction (a write-skew pair:
//   each side reads the rows the other writes).

import { Prisma, type MatchNightPoll } from "@prisma/client";
import { REGISTRATION_STATUS } from "./constants";
import { LEAGUE_CONFIG } from "./league-config";
import {
  POLL_QUESTION_MAX,
  POLL_RESULT_DAYS,
  buildPollView,
  cleanRanking,
  parseSlots,
  pollSignupsOpen,
  type PollSlot,
  type PollView,
} from "./match-night-poll";
import { prisma } from "./prisma";
import { isSerializationConflict, isUniqueViolation } from "./prisma-errors";
import { raceHook } from "./race-hook";
import { singleActiveSeason } from "./season";
import { hasActiveLeagueParticipation } from "./visibility";
import { LEAGUE_LOCALE } from "./zoned-time";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The furthest ahead a poll may close. */
const POLL_MAX_DAYS = 60;

export type PollOutcome<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

class PollClosedError extends Error {}
class NotSignedUpError extends Error {}
class PollGoneError extends Error {}
class PollAlreadyOpenError extends Error {
  constructor(readonly question: string) {
    super("POLL_ALREADY_OPEN");
  }
}

/** Run a Serializable transaction again after an ordinary SSI abort. */
async function retrySerializable<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isSerializationConflict(error) || attempt >= 3) throw error;
    }
  }
}

function alreadyOpenError(question: string): string {
  return `"${question}" is still open. Close it before opening another poll.`;
}

/** A closing time a poll may take, or the refusal. */
function closingTimeError(closesAt: Date, nowMs: number): string | null {
  if (Number.isNaN(closesAt.getTime())) return "Pick when voting closes.";
  if (closesAt.getTime() <= nowMs) {
    return "Pick a closing time in the future.";
  }
  if (closesAt.getTime() > nowMs + POLL_MAX_DAYS * DAY_MS) {
    return `Voting can stay open for at most ${POLL_MAX_DAYS} days.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Who may vote
// ---------------------------------------------------------------------------

type Db = Pick<Prisma.TransactionClient, "season" | "registration" | "teamMember" | "team">;

/**
 * The season whose signed-up players vote: the active one, or in the
 * offseason (no active season) the most recent. Polls belong to no season,
 * so the electorate follows the league: during signups for a new season its
 * signups vote, and while a finished season rests in COMPLETE its players do.
 */
async function votingSeason(
  db: Db,
): Promise<{ id: string; name: string; status: string; isActive: boolean } | null> {
  const select = { id: true, name: true, status: true } as const;
  // singleActiveSeason, like getActiveSeason: two active rows fail closed
  // instead of quietly picking one.
  const active = singleActiveSeason(
    await db.season.findMany({ where: { isActive: true }, select, take: 2 }),
  );
  if (active) return { ...active, isActive: true };
  const latest = await db.season.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select,
  });
  return latest ? { ...latest, isActive: false } : null;
}

/**
 * Signed up for the season, as the rest of the league counts it
 * (hasActiveLeagueParticipation): an ACTIVE signup, player or standin, or a
 * current roster or captain seat, which stays authoritative after the draft.
 */
async function signedUpFor(db: Db, userId: string, seasonId: string) {
  const registration = await db.registration.findFirst({
    where: { seasonId, userId, status: REGISTRATION_STATUS.ACTIVE },
    select: { id: true },
  });
  if (registration) return true;
  const [member, captain] = await Promise.all([
    db.teamMember.findFirst({ where: { seasonId, userId }, select: { id: true } }),
    db.team.findFirst({ where: { seasonId, captainId: userId }, select: { id: true } }),
  ]);
  return hasActiveLeagueParticipation(false, !!member || !!captain);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function viewOf(
  poll: Pick<MatchNightPoll, "id" | "question" | "slots" | "closesAt">,
  viewer: { id: string; role: string } | null,
  nowMs: number,
): Promise<PollView> {
  const [ballots, season] = await Promise.all([
    prisma.matchNightBallot.findMany({
      where: { pollId: poll.id },
      select: { userId: true, ranking: true, updatedAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    votingSeason(prisma),
  ]);
  const canVote =
    !!viewer && !!season && (await signedUpFor(prisma, viewer.id, season.id));
  return buildPollView({
    poll,
    ballots,
    viewerId: viewer?.id ?? null,
    isAdmin: viewer?.role === "ADMIN",
    electorate: season
      ? { seasonName: season.name, signupsOpen: pollSignupsOpen(season) }
      : null,
    canVote,
    nowMs,
    timeZone: LEAGUE_CONFIG.timeZone,
    locale: LEAGUE_LOCALE,
  });
}

/**
 * The poll Home shows: the open one, else the one that closed most recently
 * if that was within POLL_RESULT_DAYS. At most one poll is open and an open
 * poll closes later than any closed one, so the latest closing time is the
 * open poll whenever there is one.
 */
export async function loadHomePoll(
  viewer: { id: string; role: string } | null,
  nowMs: number,
): Promise<PollView | null> {
  const poll = await prisma.matchNightPoll.findFirst({
    where: { closesAt: { gt: new Date(nowMs - POLL_RESULT_DAYS * DAY_MS) } },
    orderBy: [{ closesAt: "desc" }, { id: "desc" }],
    select: { id: true, question: true, slots: true, closesAt: true },
  });
  return poll ? viewOf(poll, viewer, nowMs) : null;
}

/** The newest poll, however old, for the admin card. */
export async function loadLatestPoll(
  viewer: { id: string; role: string },
  nowMs: number,
): Promise<PollView | null> {
  const poll = await prisma.matchNightPoll.findFirst({
    orderBy: [{ closesAt: "desc" }, { id: "desc" }],
    select: { id: true, question: true, slots: true, closesAt: true },
  });
  return poll ? viewOf(poll, viewer, nowMs) : null;
}

/** One poll by id, as an admin sees it (results always included for admins). */
export async function loadPollById(
  pollId: string,
  viewer: { id: string; role: string },
  nowMs: number,
): Promise<PollView | null> {
  const poll = await prisma.matchNightPoll.findUnique({
    where: { id: pollId },
    select: { id: true, question: true, slots: true, closesAt: true },
  });
  return poll ? viewOf(poll, viewer, nowMs) : null;
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

/**
 * Save (or replace) one voter's ranking. `ranking` is the submitted list of
 * slot keys, best first; keys the poll doesn't offer and repeats are dropped
 * and the result says what was stored. An empty ranking is a vote too: none
 * of the slots work for this voter.
 *
 * The poll's deadline is enforced by the claim alone, never by a read-time
 * check: the claim is the first write of the transaction and re-asserts
 * `closesAt > now` against the committed row, so a close landing after the
 * read below still refuses the ballot.
 */
export async function castBallot(input: {
  pollId: string;
  userId: string;
  ranking: unknown;
  now?: Date;
}): Promise<PollOutcome<{ ranking: string[]; slots: PollSlot[]; dropped: number }>> {
  const poll = await prisma.matchNightPoll.findUnique({
    where: { id: input.pollId },
    select: { id: true, slots: true },
  });
  if (!poll) return { ok: false, error: "This poll no longer exists." };
  const slots = parseSlots(poll.slots);
  const submitted = Array.isArray(input.ranking) ? input.ranking.length : 0;
  const ranking = cleanRanking(input.ranking, slots);
  if (submitted > 0 && ranking.length === 0) {
    return {
      ok: false,
      error: "None of the slots you ranked are in this poll. Reload and rank again.",
    };
  }
  const value = JSON.stringify(ranking);
  await raceHook("matchNightPoll.castBallot.afterRead");

  try {
    await prisma.$transaction(async (tx) => {
      const now = input.now ?? new Date();
      const claimed = await tx.matchNightPoll.updateMany({
        where: { id: poll.id, closesAt: { gt: now } },
        data: { lastBallotAt: now },
      });
      if (claimed.count === 0) throw new PollClosedError();
      // Only signed-up players vote. Checked here, past the claim, so a
      // refusal throws and rolls the claim back. A signup withdrawn while
      // this transaction runs can still let this one ballot through; that
      // ends exactly where voting a moment earlier and withdrawing after
      // would (ballots aren't recounted on withdrawal), so it needs no lock.
      const season = await votingSeason(tx);
      if (!season || !(await signedUpFor(tx, input.userId, season.id))) {
        throw new NotSignedUpError();
      }
      await tx.matchNightBallot.upsert({
        where: { pollId_userId: { pollId: poll.id, userId: input.userId } },
        create: { pollId: poll.id, userId: input.userId, ranking: value },
        update: { ranking: value },
      });
    });
  } catch (error) {
    if (error instanceof PollClosedError) {
      return { ok: false, error: "Voting on this poll has closed." };
    }
    if (error instanceof NotSignedUpError) {
      return {
        ok: false,
        error: "Only players signed up for the league can vote in this poll.",
      };
    }
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        error:
          "Your vote was sent twice at once. Reload to see the ranking that was saved.",
      };
    }
    throw error;
  }
  return { ok: true, ranking, slots, dropped: submitted - ranking.length };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/**
 * Open a poll. Refused while another poll is open: Home shows one poll, and
 * two would split the league's votes. The check and the insert share one
 * Serializable transaction, so two admins opening polls at once can't both
 * see an empty table and both insert (Postgres aborts one; its retry then
 * finds the other's poll and refuses).
 */
export async function createPoll(input: {
  question: string;
  slots: PollSlot[];
  closesAt: Date;
  createdById: string;
  now?: Date;
}): Promise<PollOutcome<{ poll: MatchNightPoll }>> {
  const now = input.now ?? new Date();
  const question = input.question.trim().slice(0, POLL_QUESTION_MAX);
  if (!question) return { ok: false, error: "Write the question voters see." };
  const closing = closingTimeError(input.closesAt, now.getTime());
  if (closing) return { ok: false, error: closing };
  try {
    const poll = await retrySerializable(() =>
      prisma.$transaction(
        async (tx) => {
          const open = await tx.matchNightPoll.findFirst({
            where: { closesAt: { gt: now } },
            select: { question: true },
          });
          if (open) throw new PollAlreadyOpenError(open.question);
          await raceHook("matchNightPoll.createPoll.afterOpenCheck");
          return tx.matchNightPoll.create({
            data: {
              question,
              slots: JSON.stringify(input.slots),
              closesAt: input.closesAt,
              createdById: input.createdById,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    return { ok: true, poll };
  } catch (error) {
    if (error instanceof PollAlreadyOpenError) {
      return { ok: false, error: alreadyOpenError(error.question) };
    }
    if (isSerializationConflict(error)) {
      return {
        ok: false,
        error: "Another poll was opened at the same moment. Reload to see it.",
      };
    }
    throw error;
  }
}

/**
 * End voting now. The WHERE re-asserts that the poll is still open, so a
 * second "Close voting now" (or one after the deadline) changes nothing and
 * says so, instead of moving a closed poll's recorded closing time.
 */
export async function closePollNow(input: {
  pollId: string;
  now?: Date;
}): Promise<PollOutcome<{ question: string; ballots: number }>> {
  const now = input.now ?? new Date();
  const closed = await prisma.matchNightPoll.updateMany({
    where: { id: input.pollId, closesAt: { gt: now } },
    data: { closesAt: now },
  });
  if (closed.count === 0) {
    return { ok: false, error: "This poll has already closed." };
  }
  const [poll, ballots] = await Promise.all([
    prisma.matchNightPoll.findUnique({
      where: { id: input.pollId },
      select: { question: true },
    }),
    prisma.matchNightBallot.count({ where: { pollId: input.pollId } }),
  ]);
  return { ok: true, question: poll?.question ?? "", ballots };
}

/**
 * Move a poll's closing time to a future moment: extend or shorten an open
 * poll, or reopen a closed one. Reopening is refused while a different poll
 * is open, re-read in the same Serializable transaction as the write, which
 * is the other half of createPoll's write-skew pair.
 */
export async function setPollClosesAt(input: {
  pollId: string;
  closesAt: Date;
  now?: Date;
}): Promise<PollOutcome<{ question: string; reopened: boolean }>> {
  const now = input.now ?? new Date();
  const closing = closingTimeError(input.closesAt, now.getTime());
  if (closing) return { ok: false, error: closing };
  try {
    const outcome = await retrySerializable(() =>
      prisma.$transaction(
        async (tx) => {
          const poll = await tx.matchNightPoll.findUnique({
            where: { id: input.pollId },
            select: { question: true, closesAt: true },
          });
          if (!poll) throw new PollGoneError();
          const other = await tx.matchNightPoll.findFirst({
            where: { id: { not: input.pollId }, closesAt: { gt: now } },
            select: { question: true },
          });
          if (other) throw new PollAlreadyOpenError(other.question);
          await raceHook("matchNightPoll.setPollClosesAt.afterOpenCheck");
          const moved = await tx.matchNightPoll.updateMany({
            where: { id: input.pollId },
            data: { closesAt: input.closesAt },
          });
          if (moved.count === 0) throw new PollGoneError();
          return {
            question: poll.question,
            reopened: poll.closesAt.getTime() <= now.getTime(),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    return { ok: true, ...outcome };
  } catch (error) {
    if (error instanceof PollGoneError) {
      return { ok: false, error: "This poll no longer exists." };
    }
    if (error instanceof PollAlreadyOpenError) {
      return { ok: false, error: alreadyOpenError(error.question) };
    }
    if (isSerializationConflict(error)) {
      return {
        ok: false,
        error: "The polls changed at the same moment. Reload and try again.",
      };
    }
    throw error;
  }
}

/**
 * Delete a poll and every ballot in it. There is no undo, so the admin types
 * the poll's question (DangerSubmit's `confirmationName`), and it is checked
 * here too: a disabled button is not authorization.
 */
export async function deletePoll(
  pollId: string,
  confirmation: string,
): Promise<PollOutcome<{ question: string; ballots: number }>> {
  const [poll, ballots] = await Promise.all([
    prisma.matchNightPoll.findUnique({
      where: { id: pollId },
      select: { question: true },
    }),
    prisma.matchNightBallot.count({ where: { pollId } }),
  ]);
  if (!poll) return { ok: false, error: "This poll was already deleted." };
  if (confirmation.trim() !== poll.question.trim()) {
    return {
      ok: false,
      error: `Type the poll's question, “${poll.question}”, to confirm deleting it.`,
    };
  }
  const removed = await prisma.matchNightPoll.deleteMany({ where: { id: pollId } });
  if (removed.count === 0) {
    return { ok: false, error: "This poll was already deleted." };
  }
  return { ok: true, question: poll.question, ballots };
}
