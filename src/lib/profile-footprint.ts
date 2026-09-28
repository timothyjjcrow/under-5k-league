import { cache } from "react";
import { prisma } from "./prisma";
import { INHOUSE_STATUS } from "./constants";
import { getPlayerGameFacts } from "./player-game-history";
import { getRosterHistory } from "./player-roster-history";

/**
 * Has this account joined anything the league records: a season signup in any
 * status, a roster spot, a league game, or a completed inhouse game?
 *
 * Signing in with Steam creates an account, and pick'em, fantasy and inhouse
 * boards link every account's /players page. An account that has joined none
 * of the above gets a minimal, noindex profile (name, avatar, "Hasn't joined a
 * season yet") rather than a page that reads like a season signup, with a
 * medal, pub numbers and outbound links. Metadata and the page share this
 * read within a request; the roster and game reads are the page's own
 * cached reads.
 */
export const hasJoinedLeague = cache(async (userId: string): Promise<boolean> => {
  const [registration, captaincy, inhouse, roster, games] = await Promise.all([
    prisma.registration.findFirst({ where: { userId }, select: { id: true } }),
    // A team's captain is on its roster even where an older season kept no
    // TeamMember row for them.
    prisma.team.findFirst({ where: { captainId: userId }, select: { id: true } }),
    prisma.inhouseLobby.findFirst({
      where: {
        status: INHOUSE_STATUS.COMPLETED,
        players: { some: { userId } },
      },
      select: { id: true },
    }),
    getRosterHistory(userId),
    getPlayerGameFacts(userId),
  ]);
  // getPlayerGameFacts only returns games with a trusted line for this user.
  return (
    !!registration ||
    !!captaincy ||
    !!inhouse ||
    roster.length > 0 ||
    games.length > 0
  );
});
