import { cache } from "react";
import { prisma } from "./prisma";
import { getActiveSeason } from "./season";
import { capacityInfo } from "./capacity";
import { REGISTRATION_STATUS, REGISTRATION_TYPE } from "./constants";

// The reads below are request-cached with React cache(): one query per render
// pass however many of the root layout, a page and its generateMetadata ask
// for the same row. Outside a render (actions, route handlers, services)
// cache() passes through and every call reads fresh.

/**
 * A season's auction status; null before its Draft row exists. During DRAFT
 * the root layout (menus, phase chip), Home's snapshot and Home's link
 * preview all need it.
 */
export const getSeasonDraftStatus = cache(async function getSeasonDraftStatus(
  seasonId: string,
): Promise<string | null> {
  const draft = await prisma.draft.findUnique({
    where: { seasonId },
    select: { status: true },
  });
  return draft?.status ?? null;
});

/**
 * The viewer's signup in a season, or null. During signups the header's
 * "Join Season N" and Home's snapshot both read it.
 */
export const getViewerRegistration = cache(async function getViewerRegistration(
  seasonId: string,
  userId: string,
) {
  return prisma.registration.findUnique({
    where: { seasonId_userId: { seasonId, userId } },
  });
});

/**
 * Whether the viewer has a fantasy roster in a season. The menus and Home's
 * Fantasy tile both need it once rosters can be locked.
 */
export const getViewerFantasyEntered = cache(
  async function getViewerFantasyEntered(
    seasonId: string,
    userId: string,
  ): Promise<boolean> {
    const roster = await prisma.fantasyRoster.findUnique({
      where: { seasonId_userId: { seasonId, userId } },
      select: { id: true },
    });
    return roster !== null;
  },
);

/**
 * Every match of a season, in week order. Home's views and, once the season
 * is complete, its link preview's champion both read it.
 */
export const getSeasonMatches = cache(async function getSeasonMatches(
  seasonId: string,
) {
  return prisma.match.findMany({
    where: { seasonId },
    orderBy: [{ week: "asc" }],
  });
});

/**
 * The dashboard's viewer-aware season snapshot. Home's page and its link
 * preview share one copy per request, so the preview costs no queries. The
 * viewer's id is a required argument (undefined when signed out) so every
 * caller passes one argument and hits the same cache entry.
 */
export const getSeasonSnapshot = cache(async function getSeasonSnapshot(
  userId: string | undefined,
) {
  const season = await getActiveSeason();
  if (!season) return null;

  const [playerCount, standinCount, teams, myReg, draftStatus] = await Promise.all([
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
      ? getViewerRegistration(season.id, userId)
      : Promise.resolve(null),
    getSeasonDraftStatus(season.id),
  ]);

  return {
    season,
    playerCount,
    standinCount,
    teams,
    myReg,
    draftStatus,
    capacity: capacityInfo(season, playerCount),
  };
});

export type SeasonSnapshot = NonNullable<
  Awaited<ReturnType<typeof getSeasonSnapshot>>
>;
