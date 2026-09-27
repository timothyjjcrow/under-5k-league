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
  const currentById = new Map(current.map((row) => [row.id, row]));
  const capturedIds = new Set(tenures.map((row) => row.sourceMembershipId));
  return [
    ...tenures.map((row) => ({
      id: row.id, teamId: row.teamId, teamName: row.team?.name ?? row.teamNameSnapshot,
      teamLogoUrl: row.team?.logoUrl ?? null,
      seasonId: row.seasonId, seasonName: row.season.name,
      seasonCreatedAt: row.season.createdAt,
      joinedAt: row.joinedAt, endedAt: row.endedAt,
      active: row.openKey !== null && currentById.has(row.sourceMembershipId),
      provenance: row.startProvenance, acquisitionKind: row.acquisitionKind,
      price: row.acquisitionPrice, mmr: row.acquisitionMmr,
      // Captaincy can change after joining (a handover), so the live roster
      // row wins while it exists; otherwise what was recorded at joining.
      captain: currentById.get(row.sourceMembershipId)?.isCaptain ?? row.isCaptainAtJoin,
      endReason: row.endReason, recorded: true,
    })),
    // Old application writers or a not-yet-run capture are explicit read
    // fallbacks. Viewing a profile never invents or writes historical facts.
    ...current.filter((row) => !capturedIds.has(row.id)).map((row) => ({
      id: row.id, teamId: row.teamId, teamName: row.team.name,
      teamLogoUrl: row.team.logoUrl,
      seasonId: row.seasonId, seasonName: row.team.season.name,
      seasonCreatedAt: row.team.season.createdAt,
      joinedAt: row.createdAt, endedAt: null, active: true,
      provenance: "LEGACY_ROW", acquisitionKind: "LEGACY_CAPTURE",
      price: row.price, mmr: null, captain: row.isCaptain as boolean | null,
      endReason: null, recorded: false,
    })),
  ].sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime() || a.id.localeCompare(b.id));
});
