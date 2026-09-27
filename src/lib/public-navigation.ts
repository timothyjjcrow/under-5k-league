import { MATCH_STATUS } from "./constants";
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
