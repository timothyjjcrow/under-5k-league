import type { Prisma } from "@prisma/client";

export type ImportIdentity = {
  userId: string; name: string; teamId: string | null;
  plannedPosition?: number; positionSource?: string;
  ratingSnapshot?: number; ratingSource?: string; ratingAt?: string;
};

const lineupSelect = {
  matchId: true, teamId: true, revision: true, confirmedAt: true, supersededAt: true,
  seats: { select: {
    userId: true, userNameSnapshot: true, accountId: true, position: true,
    mmr: true, mmrSource: true, ratingAt: true,
  } },
} as const;

export type ImportLineup = Prisma.MatchLineupGetPayload<{ select: typeof lineupSelect }>;

export function loadImportLineups(
  db: Pick<Prisma.TransactionClient, "matchLineup">,
  where: Prisma.MatchLineupWhereInput,
) {
  return db.matchLineup.findMany({
    where: { AND: [where, { status: { in: ["CONFIRMED", "SUPERSEDED"] } }] },
    select: lineupSelect,
  });
}

export function lineupAt(lineups: ImportLineup[], matchId: string, teamId: string, startTime: number) {
  const at = startTime * 1000;
  if (!Number.isFinite(at) || at <= 0) return undefined;
  return lineups.filter((lineup) => lineup.matchId === matchId && lineup.teamId === teamId &&
    lineup.confirmedAt.getTime() <= at &&
    (lineup.supersededAt === null || lineup.supersededAt.getTime() > at))
    .sort((a, b) => b.confirmedAt.getTime() - a.confirmedAt.getTime() || b.revision - a.revision)[0];
}

/** Apply immutable historical seats, keeping current-roster fallback explicit. */
export function applyImportLineups<T extends { homeSet: Set<number>; awaySet: Set<number>; accountMap?: Map<number, ImportIdentity> }>(
  current: T,
  match: { id: string; homeTeamId: string; awayTeamId: string },
  lineups: ImportLineup[],
  startTime: number,
): T {
  const result = { ...current, homeSet: new Set(current.homeSet), awaySet: new Set(current.awaySet),
    ...(current.accountMap ? { accountMap: new Map(current.accountMap) } : {}) };
  for (const [teamId, side] of [[match.homeTeamId, "homeSet"], [match.awayTeamId, "awaySet"]] as const) {
    const lineup = lineupAt(lineups, match.id, teamId, startTime);
    if (!lineup) continue;
    result[side] = new Set(lineup.seats.flatMap((seat) => seat.accountId === null ? [] : [seat.accountId]));
    if (!result.accountMap) continue;
    for (const [account, identity] of result.accountMap) {
      if (identity.teamId === teamId) result.accountMap.set(account, { ...identity, teamId: null });
    }
    for (const seat of lineup.seats) {
      if (seat.accountId === null) continue;
      const metadata: Partial<ImportIdentity> = {};
      if (seat.position !== null) {
        metadata.plannedPosition = seat.position;
        metadata.positionSource = "LINEUP_PLANNED";
      }
      // A later rating observation cannot become a historical snapshot just
      // because it was attached to a backdated/malformed seat.
      if (seat.mmr !== null && seat.ratingAt && seat.ratingAt.getTime() <= startTime * 1000) {
        metadata.ratingSnapshot = seat.mmr;
        metadata.ratingSource = seat.mmrSource ?? "LINEUP_SNAPSHOT";
        metadata.ratingAt = seat.ratingAt.toISOString();
      }
      result.accountMap.set(seat.accountId, {
        userId: seat.userId, name: seat.userNameSnapshot, teamId, ...metadata,
      });
    }
  }
  return result;
}
