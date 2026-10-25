// The rows the free-agent MMR rule (free-agent-rule.ts) judges a signing by,
// for signFreeAgent and the admin sign form alike.

import type { Prisma, PrismaClient } from "@prisma/client";
import { freeAgentBaseline, type FreeAgentBaseline } from "./free-agent-rule";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Each team's baseline (who a signing would replace, or its lowest MMR), by
 * team id. Two reads in parallel whatever the team count, never one per team
 * or row: the teams' tenure history this season, with each player's signup
 * (Prisma batches the relations), and the rostered players' signups.
 */
export async function loadFreeAgentBaselines(
  db: Db,
  seasonId: string,
  teams: readonly {
    id: string;
    name: string;
    memberUserIds: readonly string[];
  }[],
): Promise<Record<string, FreeAgentBaseline>> {
  if (teams.length === 0) return {};
  const rosterUserIds = [...new Set(teams.flatMap((t) => t.memberUserIds))];
  const [tenures, rosterSignups] = await Promise.all([
    db.rosterTenure.findMany({
      where: { seasonId, teamId: { in: teams.map((t) => t.id) } },
      select: {
        id: true,
        teamId: true,
        userId: true,
        playerNameSnapshot: true,
        joinedAt: true,
        endedAt: true,
        endReason: true,
        acquisitionKind: true,
        acquisitionMmr: true,
        user: {
          select: {
            name: true,
            registrations: { where: { seasonId }, select: { mmr: true } },
          },
        },
      },
    }),
    db.registration.findMany({
      where: { seasonId, userId: { in: rosterUserIds } },
      select: { userId: true, mmr: true },
    }),
  ]);
  const signupMmr = new Map(rosterSignups.map((r) => [r.userId, r.mmr]));
  for (const tenure of tenures) {
    const mmr = tenure.user?.registrations[0]?.mmr;
    if (tenure.userId && mmr !== undefined) signupMmr.set(tenure.userId, mmr);
  }
  const baselines: Record<string, FreeAgentBaseline> = {};
  for (const team of teams) {
    baselines[team.id] = freeAgentBaseline({
      teamName: team.name,
      tenures: tenures
        .filter((t) => t.teamId === team.id)
        .map((t) => ({
          id: t.id,
          userId: t.userId,
          // Today's name when the account still exists: the snapshot is the
          // name they joined under.
          name: t.user?.name ?? t.playerNameSnapshot,
          joinedAt: t.joinedAt,
          endedAt: t.endedAt,
          endReason: t.endReason,
          acquisitionKind: t.acquisitionKind,
          acquisitionMmr: t.acquisitionMmr,
        })),
      rosterUserIds: team.memberUserIds,
      signupMmr,
    });
  }
  return baselines;
}
