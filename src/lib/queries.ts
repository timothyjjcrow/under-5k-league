import { prisma } from "./prisma";
import { getActiveSeason } from "./season";
import { capacityInfo } from "./capacity";
import { REGISTRATION_STATUS, REGISTRATION_TYPE } from "./constants";

/** The dashboard's viewer-aware season snapshot (its only consumer — other pages run their own queries). */
export async function getSeasonSnapshot(userId?: string) {
  const season = await getActiveSeason();
  if (!season) return null;

  const [playerCount, standinCount, teams, myReg, draft] = await Promise.all([
    prisma.registration.count({
      where: {
        seasonId: season.id,
        status: REGISTRATION_STATUS.ACTIVE,
        type: REGISTRATION_TYPE.PLAYER,
      },
    }),
    prisma.registration.count({
      where: {
        seasonId: season.id,
        status: REGISTRATION_STATUS.ACTIVE,
        type: REGISTRATION_TYPE.STANDIN,
      },
    }),
    prisma.team.findMany({
      where: { seasonId: season.id },
      orderBy: { draftOrder: "asc" },
      include: {
        // Only the display fields — this snapshot serializes into the dashboard,
        // teams and admin RSC payloads, so shipping full user rows (steamId,
        // timestamps…) is wasted bytes the browser downloads + hydrates. tsc
        // enforces that every consumer sticks to these fields.
        captain: {
          select: { id: true, name: true, avatar: true, rankTier: true },
        },
        members: {
          include: {
            user: {
              select: { id: true, name: true, avatar: true, rankTier: true },
            },
          },
          orderBy: { price: "desc" },
        },
      },
    }),
    userId
      ? prisma.registration.findUnique({
          where: { seasonId_userId: { seasonId: season.id, userId } },
        })
      : Promise.resolve(null),
    prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true },
    }),
  ]);

  return {
    season,
    playerCount,
    standinCount,
    teams,
    myReg,
    draftStatus: draft?.status ?? null,
    capacity: capacityInfo(season, playerCount),
  };
}

export type SeasonSnapshot = NonNullable<
  Awaited<ReturnType<typeof getSeasonSnapshot>>
>;
