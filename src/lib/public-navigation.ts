import { MATCH_STATUS } from "./constants";
import { hasOfficialChampion } from "./official-champion";
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
// and the Hall of Fame are offered at all: any imported league game, and an
// official champion. League-wide, so the callers pass null and share one
// entry. Imports, game removals and crowning all stamp the public game
// revision this is keyed by; the snapshot's 60-second expiry covers the rest.
// The champion test is hasOfficialChampion, the one the Hall of Fame itself
// opens on, so no menu, footer or in-page link sends anyone to a Hall of Fame
// that only says "No champion yet" (a crowned season whose saved final
// disagrees with it is an admin repair state, and does not count).
export const getPublicLeagueContent = createPublicSnapshot(
  "public-navigation-content-v2",
  async () => {
    const [game, hasChampion] = await Promise.all([
      prisma.game.findFirst({ select: { id: true } }),
      hasOfficialChampion(),
    ]);
    return { hasGames: game !== null, hasChampion };
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
