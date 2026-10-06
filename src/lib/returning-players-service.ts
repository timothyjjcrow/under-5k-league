import { REGISTRATION_STATUS } from "./constants";
import { prisma } from "./prisma";
import type { ReturningPlayers } from "./returning-players";

/**
 * Last season's players against this season's signups, for /admin's
 * returning-player reminder. "Last season" is the latest season created
 * before this one. A player counts as back with an active signup now, and as
 * not back with no signup at all now: one who withdrew or was removed this
 * season isn't chased. Database reads only. Null with no earlier season.
 */
export async function loadReturningPlayers(
  seasonId: string,
): Promise<ReturningPlayers | null> {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { createdAt: true },
  });
  if (!season) return null;
  const previous = await prisma.season.findFirst({
    where: { id: { not: seasonId }, createdAt: { lte: season.createdAt } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, name: true },
  });
  if (!previous) return null;
  const [before, now] = await Promise.all([
    prisma.registration.findMany({
      where: {
        seasonId: previous.id,
        status: { not: REGISTRATION_STATUS.REMOVED },
      },
      select: {
        userId: true,
        user: { select: { name: true, discordId: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.registration.findMany({
      where: { seasonId },
      select: { userId: true, status: true },
    }),
  ]);
  const thisSeason = new Map(now.map((reg) => [reg.userId, reg.status]));
  return {
    previousSeasonName: previous.name,
    previous: before.length,
    back: before.filter(
      (reg) => thisSeason.get(reg.userId) === REGISTRATION_STATUS.ACTIVE,
    ).length,
    notBack: before
      .filter((reg) => !thisSeason.has(reg.userId))
      .map((reg) => ({ name: reg.user.name, discordId: reg.user.discordId })),
  };
}
