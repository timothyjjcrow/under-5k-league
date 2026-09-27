import { MATCH_STATUS, SEASON_STATUS } from "./constants";
import { prisma } from "./prisma";
import { createPublicSnapshot } from "./public-cache";

// Only the public existence flag persists. Active-season authorization,
// sessions, and membership continue to read fresh within each render.
export const getPublicHasHistory = createPublicSnapshot(
  "public-navigation-history-v1",
  async () => (await prisma.season.findFirst({
    where: { isActive: false },
    select: { id: true },
  })) !== null,
);

// The header's "Series live" chip, read on every page during the season, so
// it is one indexed row behind the shared public snapshot. Game imports move a
// match in and out of LIVE in the same transaction that stamps the public game
// revision this is keyed by; any other writer is covered by the snapshot's
// 60-second expiry.
export const getPublicHasLiveMatch = createPublicSnapshot(
  "public-navigation-live-match-v1",
  async (seasonId) => seasonId !== null && (await prisma.match.findFirst({
    where: { seasonId, status: MATCH_STATUS.LIVE },
    select: { id: true },
  })) !== null,
);

// What the league has on record, which decides whether the statistics pages
// and the Hall of Fame are offered at all: any imported league game, and any
// season with a champion. League-wide, so the callers pass null and share one
// entry. Imports, game removals and crowning all stamp the public game
// revision this is keyed by; the snapshot's 60-second expiry covers the rest.
// A cheap stand-in for resolveChampionPresentation: a crowned season whose
// saved final disagrees with it is an admin repair state, not a normal one.
export const getPublicLeagueContent = createPublicSnapshot(
  "public-navigation-content-v1",
  async () => {
    const [game, champion] = await Promise.all([
      prisma.game.findFirst({ select: { id: true } }),
      prisma.season.findFirst({
        where: {
          status: SEASON_STATUS.COMPLETE,
          championTeamId: { not: null },
        },
        select: { id: true },
      }),
    ]);
    return { hasGames: game !== null, hasChampion: champion !== null };
  },
);

// Whether the active season has an imported game, which locks its fantasy
// rosters. The first import also stamps Season.fantasyLockedAt; this covers
// seasons whose games arrived without it (seeded fixtures), the way the
// fantasy page and Home check both.
export const getPublicSeasonHasGames = createPublicSnapshot(
  "public-navigation-season-games-v1",
  async (seasonId) => seasonId !== null && (await prisma.game.findFirst({
    where: { match: { seasonId } },
    select: { id: true },
  })) !== null,
);
