import type { Prisma } from "@prisma/client";
import { SCRIM_STATUS } from "./constants";

export const SCRIM_COLLISION_WINDOW_MS = 4 * 60 * 60 * 1000;

export function scrimCollisionRange(scheduledAt: Date) {
  return {
    gte: new Date(scheduledAt.getTime() - SCRIM_COLLISION_WINDOW_MS),
    lte: new Date(scheduledAt.getTime() + SCRIM_COLLISION_WINDOW_MS),
  };
}

export async function hasConfirmedScrimConflict(
  db: Pick<Prisma.TransactionClient, "scrim">,
  options: {
    seasonId: string;
    teamIds: string[];
    scheduledAt: Date;
    exceptScrimId?: string;
  },
): Promise<boolean> {
  if (options.teamIds.length === 0) return false;
  return !!(await db.scrim.findFirst({
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
    select: { id: true },
  }));
}
