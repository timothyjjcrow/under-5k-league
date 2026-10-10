// Play later on the site (rules: inhouse-times.ts): the times players post
// on /inhouse and who said "I'm in" on each, one InhouseTimeRsvp row per
// player per time. A time is just the rows that share a start, so posting
// one and saying "I'm in" on it are the same write, and nothing is left over
// once its last player takes it back. No Discord, no worker clock: what is
// upcoming, on or over is worked out at read time, and rows from times
// that are over are pruned after the next "I'm in".
//
// Rivals, all on this table: the same player's other "I'm in" (the cap
// counts their upcoming rows), another player posting the same start (the
// first is told they posted it, the rest that they're in), and the player's
// own double tap. Each "I'm in" reads what it judges and writes in one
// Serializable transaction, so two that each read the other's rows can't
// both commit: a loser retries on a fresh read and is refused or told it's
// in. A double tap meets at the primary key, and since each tap read that
// key first, Postgres reports the second as a serialization conflict rather
// than a duplicate, so its retry reads the first tap's row and says "already
// in". The inhouse night is read before the transaction, from its Setting
// row. A night planned in that gap at worst leaves a new time inside it, the
// same as a night planned just after: the night only keeps new times out, it
// never removes one.

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { retrySerializable } from "./serializable-retry";
import { UserFacingError } from "./user-facing-error";
import { currentInhouseNight } from "./inhouse-night";
import { readInhouseNight } from "./inhouse-night-service";
import {
  INHOUSE_TIME_AT_CAP,
  INHOUSE_TIME_DURING_NIGHT,
  INHOUSE_TIME_MAX_PER_PLAYER,
  INHOUSE_TIME_ON_MS,
  groupInhouseTimes,
  inhouseTimePhase,
  inhouseTimeProblem,
  inhouseTimeDuringNight,
  inhouseTimesWindow,
  type InhouseTime,
} from "./inhouse-times";

/**
 * Tries for an "I'm in" that loses a serialization race: a double tap, two
 * players posting one time, or a player's two "I'm in"s at the cap. Each
 * loser waits out the winner's commit before trying again
 * (`retrySerializable`); three tries ran out inside one slow commit.
 */
const RSVP_ATTEMPTS = 6;

/** More rows than the list can plausibly hold (every player in on the cap); a bound, not a page. */
const READ_LIMIT = 500;

const ROW_SELECT = {
  startsAt: true,
  createdAt: true,
  user: { select: { id: true, name: true, avatar: true } },
} as const;

type Row = { startsAt: Date; createdAt: Date; user: { id: string; name: string; avatar: string | null } };

function toTimes(rows: Row[], nowMs: number): InhouseTime[] {
  return groupInhouseTimes(
    rows.map((row) => ({
      startsAtMs: row.startsAt.getTime(),
      createdAtMs: row.createdAt.getTime(),
      player: row.user,
    })),
    nowMs,
  );
}

/** Every time on the list now, soonest first, each with its players first in first. */
export async function readInhouseTimes(nowMs = Date.now()): Promise<InhouseTime[]> {
  const { afterMs, untilMs } = inhouseTimesWindow(nowMs);
  const rows = await prisma.inhouseTimeRsvp.findMany({
    where: { startsAt: { gt: new Date(afterMs), lte: new Date(untilMs) } },
    orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }, { userId: "asc" }],
    take: READ_LIMIT,
    select: ROW_SELECT,
  });
  return toTimes(rows, nowMs);
}

/** One time (its link's preview and calendar file), or null once nobody is in or it's over. */
export async function readInhouseTime(
  startsAtMs: number,
  nowMs = Date.now(),
): Promise<InhouseTime | null> {
  if (inhouseTimePhase(startsAtMs, nowMs) === "over") return null;
  const rows = await prisma.inhouseTimeRsvp.findMany({
    where: { startsAt: new Date(startsAtMs) },
    orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
    take: READ_LIMIT,
    select: ROW_SELECT,
  });
  return toTimes(rows, nowMs)[0] ?? null;
}

export type InhouseTimeRsvpOutcome =
  /** First in: the player posted this time. */
  | "posted"
  /** In on a time someone else posted. */
  | "in"
  | "already-in"
  | "out"
  | "already-out";

/**
 * "I'm in" on the time starting at `startsAtMs` (`going`), which posts it
 * when nobody is in on it yet, or taking it back. Saying so needs the time to
 * be ahead and within the next day, the player under the cap, and a new time
 * to keep out of the planned inhouse night. Taking it back always works.
 */
export async function setInhouseTimeRsvp(input: {
  userId: string;
  startsAtMs: number;
  going: boolean;
  nowMs?: number;
}): Promise<{ outcome: InhouseTimeRsvpOutcome }> {
  const nowMs = input.nowMs ?? Date.now();
  const startsAt = new Date(input.startsAtMs);
  if (!input.going) {
    const removed = await prisma.inhouseTimeRsvp.deleteMany({
      where: { startsAt, userId: input.userId },
    });
    return { outcome: removed.count > 0 ? "out" : "already-out" };
  }

  const problem = inhouseTimeProblem(input.startsAtMs, nowMs);
  if (problem) throw new UserFacingError(problem);
  const night = currentInhouseNight((await readInhouseNight()).night, nowMs);

  const outcome = await retrySerializable(() =>
    prisma.$transaction(
      async (tx) => {
        const mine = await tx.inhouseTimeRsvp.findUnique({
          where: { startsAt_userId: { startsAt, userId: input.userId } },
          select: { userId: true },
        });
        if (mine) return "already-in" as const;
        const others = await tx.inhouseTimeRsvp.count({ where: { startsAt } });
        if (others === 0 && inhouseTimeDuringNight(input.startsAtMs, night)) {
          throw new UserFacingError(INHOUSE_TIME_DURING_NIGHT);
        }
        const upcoming = await tx.inhouseTimeRsvp.count({
          where: { userId: input.userId, startsAt: { gt: new Date(nowMs) } },
        });
        if (upcoming >= INHOUSE_TIME_MAX_PER_PLAYER) {
          throw new UserFacingError(INHOUSE_TIME_AT_CAP);
        }
        await tx.inhouseTimeRsvp.create({ data: { startsAt, userId: input.userId } });
        return others === 0 ? ("posted" as const) : ("in" as const);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
    { attempts: RSVP_ATTEMPTS },
  );
  await pruneInhouseTimes(nowMs);
  return { outcome };
}

/**
 * Drop the rows of times that are over: no read shows them, so this only
 * keeps the table small. Best-effort; the next "I'm in" tries again.
 */
async function pruneInhouseTimes(nowMs: number): Promise<void> {
  try {
    await prisma.inhouseTimeRsvp.deleteMany({
      where: { startsAt: { lte: new Date(nowMs - INHOUSE_TIME_ON_MS) } },
    });
  } catch {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[inhouse-times] pruning old I'm-in rows failed");
    }
  }
}
