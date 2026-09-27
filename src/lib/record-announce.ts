import { prisma } from "./prisma";
import { heroById } from "./heroes";
import {
  brokenPlayerRecord,
  compareRecordChronology,
  formatRecordMark,
  toRecordGames,
} from "./records";
import type { matchResultMessage } from "./discord";

export type SeriesRecordLine = NonNullable<
  Parameters<typeof matchResultMessage>[0]["record"]
>;

/**
 * The "New league record" line for a decided series' result post, or null.
 * Reads the whole all-time book with the same trusted mapping and order as
 * /records, so the post can never name a record the book does not show.
 * brokenPlayerRecord holds the rules: a strict improvement, at most one,
 * and nothing until the book has RECORD_ANNOUNCE_MIN_GAMES complete games.
 */
export async function seriesRecordLine(
  matchId: string,
): Promise<SeriesRecordLine | null> {
  const rows = await prisma.game.findMany({
    select: {
      id: true,
      matchId: true,
      startTime: true,
      radiantWin: true,
      durationSecs: true,
      radiantScore: true,
      direScore: true,
      players: true,
      match: { select: { seasonId: true } },
    },
  });
  rows.sort(compareRecordChronology);
  const broken = brokenPlayerRecord(toRecordGames(rows), matchId);
  if (!broken) return null;
  const holder = await prisma.user.findUnique({
    where: { id: broken.record.userId },
    select: { name: true },
  });
  if (!holder) return null;
  return {
    emoji: broken.record.emoji,
    holderName: holder.name,
    mark: formatRecordMark(broken.record.key, broken.record.value),
    heroName: heroById(broken.record.heroId)?.name ?? null,
    previousMark: formatRecordMark(broken.previous.key, broken.previous.value),
  };
}
