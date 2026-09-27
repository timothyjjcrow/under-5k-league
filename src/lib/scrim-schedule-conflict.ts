import type { Prisma } from "@prisma/client";
import { SCRIM_STATUS } from "./constants";
import { formatLeagueTime } from "./zoned-time";

export const SCRIM_COLLISION_WINDOW_MS = 4 * 60 * 60 * 1000;

export function scrimCollisionRange(scheduledAt: Date) {
  return {
    gte: new Date(scheduledAt.getTime() - SCRIM_COLLISION_WINDOW_MS),
    lte: new Date(scheduledAt.getTime() + SCRIM_COLLISION_WINDOW_MS),
  };
}

/** A booked (SCHEDULED or LIVE) scrim that sits too close to another time. */
export type ScrimConflict = {
  id: string;
  scheduledAt: Date;
  hostTeamName: string;
  opponentTeamName: string | null;
};

/**
 * The earliest booked (SCHEDULED or LIVE) scrim within four hours of
 * `scheduledAt` for any of these teams, or null. Every refusal names it via
 * `describeScrimConflict`: "a booked scrim" on its own sent admins and
 * captains hunting through /scrims for a booking they could not identify.
 */
export async function findConfirmedScrimConflict(
  db: Pick<Prisma.TransactionClient, "scrim">,
  options: {
    seasonId: string;
    teamIds: string[];
    scheduledAt: Date;
    exceptScrimId?: string;
  },
): Promise<ScrimConflict | null> {
  if (options.teamIds.length === 0) return null;
  const scrim = await db.scrim.findFirst({
    where: {
      seasonId: options.seasonId,
      id: options.exceptScrimId
        ? { not: options.exceptScrimId }
        : undefined,
      scheduledAt: scrimCollisionRange(options.scheduledAt),
      status: { in: [SCRIM_STATUS.SCHEDULED, SCRIM_STATUS.LIVE] },
      OR: [
        { hostTeamId: { in: options.teamIds } },
        { opponentTeamId: { in: options.teamIds } },
      ],
    },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      scheduledAt: true,
      hostTeam: { select: { name: true } },
      opponentTeam: { select: { name: true } },
    },
  });
  return scrim
    ? {
        id: scrim.id,
        scheduledAt: scrim.scheduledAt,
        hostTeamName: scrim.hostTeam.name,
        opponentTeamName: scrim.opponentTeam?.name ?? null,
      }
    : null;
}

/**
 * "the Raccoons vs Dire Straits scrim on Tue, Sep 30, 8:00 PM PDT": both
 * teams and the time on the league's clock (never the server's), so a refusal
 * says exactly which booking to cancel. Lower-case on purpose — every caller
 * puts it mid-sentence.
 */
export function describeScrimConflict(
  conflict: Pick<
    ScrimConflict,
    "hostTeamName" | "opponentTeamName" | "scheduledAt"
  >,
): string {
  const teams = conflict.opponentTeamName
    ? `${conflict.hostTeamName} vs ${conflict.opponentTeamName}`
    : conflict.hostTeamName;
  return `the ${teams} scrim on ${formatLeagueTime(conflict.scheduledAt)}`;
}

/**
 * One sentence for the admin (toast and activity log) about a scrim a
 * playoff round overrode: cancelled when it was only booked, kept when games
 * were already recorded. Names teams and both times on the league clock.
 */
export function describeScrimYield(
  clash: Pick<
    ScrimConflict,
    "hostTeamName" | "opponentTeamName" | "scheduledAt"
  > & { cancelled: boolean },
  fixtureLabel: string,
  fixtureAt: Date,
): string {
  const scrim = describeScrimConflict(clash);
  const fixture = `${fixtureLabel} on ${formatLeagueTime(fixtureAt)}`;
  return clash.cancelled
    ? `Cancelled ${scrim}: it clashed with ${fixture}.`
    : `Kept ${scrim} because games were already recorded, but it clashes with ${fixture}; its captains need to finish it or end it at its current score.`;
}
