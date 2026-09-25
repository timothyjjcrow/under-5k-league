import { cache } from "react";
import { prisma } from "./prisma";

export const getRosterHistory = cache(async (userId: string) => {
  const [tenures, current] = await Promise.all([
    prisma.rosterTenure.findMany({
      where: { userId }, include: { season: true, team: true },
      orderBy: [{ joinedAt: "desc" }, { id: "asc" }],
    }),
    prisma.teamMember.findMany({
      where: { userId }, include: { team: { include: { season: true } } },
    }),
  ]);
  const currentIds = new Set(current.map((row) => row.id));
  const capturedIds = new Set(tenures.map((row) => row.sourceMembershipId));
  return [
    ...tenures.map((row) => ({
      id: row.id, teamId: row.teamId, teamName: row.team?.name ?? row.teamNameSnapshot,
      seasonId: row.seasonId, seasonName: row.season.name,
      joinedAt: row.joinedAt, endedAt: row.endedAt,
      active: row.openKey !== null && currentIds.has(row.sourceMembershipId),
      provenance: row.startProvenance, acquisitionKind: row.acquisitionKind,
      price: row.acquisitionPrice, mmr: row.acquisitionMmr,
      endReason: row.endReason, recorded: true,
    })),
    // Old application writers or a not-yet-run capture are explicit read
    // fallbacks. Viewing a profile never invents or writes historical facts.
    ...current.filter((row) => !capturedIds.has(row.id)).map((row) => ({
      id: row.id, teamId: row.teamId, teamName: row.team.name,
      seasonId: row.seasonId, seasonName: row.team.season.name,
      joinedAt: row.createdAt, endedAt: null, active: true,
      provenance: "LEGACY_ROW", acquisitionKind: "LEGACY_CAPTURE",
      price: row.price, mmr: null, endReason: null, recorded: false,
    })),
  ].sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime() || a.id.localeCompare(b.id));
});

export type RosterHistoryRow = Awaited<ReturnType<typeof getRosterHistory>>[number];
