import { resolveChampionPresentation } from "./champion-presentation";
import { MATCH_PHASE } from "./constants";
import { finalDecidedAt } from "./news";
import { prisma } from "./prisma";
import { raceHook } from "./race-hook";

/**
 * Unpin what was pinned for a season that has ended, when the next one opens.
 *
 * A post pinned for the end of a season ("Grand final this Sunday") stayed
 * pinned under the hero of the next season's signups, because nothing but an
 * admin's memory ever unpinned it. Create season calls this for the season it
 * closes (or, from the offseason, the last archived one) and unpins the posts
 * published before that season's grand final was decided. Anything pinned
 * after the final ("Signups are open") stays, and every post stays in /news.
 *
 * Only a season with an authoritative final has a line to draw; a season
 * cancelled before its final, or an old one with no bracket saved, unpins
 * nothing. Returns the titles it unpinned, oldest first, for the toast.
 */
export async function unpinNewsBeforeFinal(
  seasonId: string,
): Promise<string[]> {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { status: true, championTeamId: true },
  });
  if (!season) return [];
  const postseason = await prisma.match.findMany({
    where: {
      seasonId,
      phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
    },
    select: {
      id: true,
      phase: true,
      bracketSlot: true,
      status: true,
      winnerTeamId: true,
      homeTeamId: true,
      awayTeamId: true,
      scheduledAt: true,
      completedAt: true,
      games: { select: { startTime: true, durationSecs: true } },
    },
  });
  const { authoritativeFinalId } = resolveChampionPresentation(
    season,
    postseason,
  );
  const final = postseason.find((match) => match.id === authoritativeFinalId);
  const cutoff = final ? finalDecidedAt(final, final.games) : null;
  if (!cutoff) return [];

  const stale = await prisma.newsPost.findMany({
    where: { pinned: true, createdAt: { lt: cutoff } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, title: true },
  });
  await raceHook("news.unpinNewsBeforeFinal.beforeUnpin");
  const unpinned: string[] = [];
  for (const post of stale) {
    // Re-asserts the pin read above: another admin may unpin (or delete) the
    // post in the meantime, and only a post this call actually unpinned may
    // be named as unpinned in the toast.
    const { count } = await prisma.newsPost.updateMany({
      where: { id: post.id, pinned: true },
      data: { pinned: false },
    });
    if (count === 1) unpinned.push(post.title);
  }
  return unpinned;
}
