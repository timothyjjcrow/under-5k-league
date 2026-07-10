import { prisma } from "./prisma";
import { weeklyHonors, type HonorsGame, type WeeklyHonors } from "./honors";
import { getSetting, setSetting } from "./settings";
import { sendDiscordMessage, weeklyHonorsMessage } from "./discord";
import { getHeroNames } from "./dota";

function parsePlayers(json: string): HonorsGame["players"] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Compute one week's honors from the season's imported games. */
export async function getWeekHonors(
  seasonId: string,
  week: number,
): Promise<WeeklyHonors> {
  const [games, members] = await Promise.all([
    prisma.game.findMany({
      where: { match: { seasonId, week } },
      select: { players: true, radiantWin: true },
    }),
    prisma.teamMember.findMany({
      where: { seasonId },
      select: { userId: true, teamId: true },
    }),
  ]);
  return weeklyHonors(
    games.map((g) => ({
      radiantWin: g.radiantWin,
      players: parsePlayers(g.players),
    })),
    new Map(members.map((m) => [m.userId, m.teamId])),
  );
}

/**
 * Announce a week's honors in Discord once every one of its regular-season
 * matches is completed. Idempotent via a Setting marker, so result edits and
 * repeated imports can't double-announce.
 */
export async function maybeAnnounceWeekHonors(
  seasonId: string,
  week: number,
): Promise<void> {
  const weekMatches = await prisma.match.findMany({
    where: { seasonId, week, phase: "REGULAR" },
    select: { status: true },
  });
  if (weekMatches.length === 0) return;
  if (weekMatches.some((m) => m.status !== "COMPLETED")) return;

  const marker = `honorsAnnounced:${seasonId}:${week}`;
  if (await getSetting(marker)) return;

  const honors = await getWeekHonors(seasonId, week);
  if (!honors.player && !honors.team) return; // nothing imported — stay quiet

  const [playerUser, team, heroNames] = await Promise.all([
    honors.player
      ? prisma.user.findUnique({ where: { id: honors.player.userId } })
      : null,
    honors.team
      ? prisma.team.findUnique({ where: { id: honors.team.teamId } })
      : null,
    honors.player?.heroId ? getHeroNames() : ({} as Record<number, string>),
  ]);

  // Claim the marker before sending so a concurrent import can't race us
  // into a duplicate announcement.
  await setSetting(marker, new Date().toISOString());
  await sendDiscordMessage(
    weeklyHonorsMessage({
      week,
      playerName: playerUser?.name ?? null,
      playerPoints: honors.player?.points ?? 0,
      heroName:
        honors.player?.heroId != null
          ? (heroNames[honors.player.heroId] ?? null)
          : null,
      teamName: team?.name ?? null,
      teamGameWins: honors.team?.gameWins ?? 0,
    }),
  );
}
