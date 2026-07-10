// Weekly honors — pure and unit-tested. When a week's results are in, crown
// the Player of the Week (best fantasy score across the week's games — the
// same scoring identity the fantasy league uses) and the Team of the Week
// (most game wins, summed player points as the tiebreak).

import { fantasyPoints, type FantasyStatLine } from "./fantasy";

export type HonorsGame = {
  radiantWin: boolean;
  players: (FantasyStatLine & {
    userId?: string | null;
    isRadiant: boolean;
    heroId?: number;
  })[];
};

export type WeeklyHonors = {
  player: { userId: string; points: number; heroId: number | null } | null;
  team: { teamId: string; gameWins: number; points: number } | null;
};

/**
 * Compute one week's honors from its imported games. `teamOf` maps league
 * players to their team. Returns null honors when there's nothing to grade.
 */
export function weeklyHonors(
  games: HonorsGame[],
  teamOf: Map<string, string>,
): WeeklyHonors {
  const playerPoints = new Map<string, { points: number; heroId: number | null }>();
  const teamPoints = new Map<string, number>();
  const teamWins = new Map<string, number>();

  for (const g of games) {
    const winningTeams = new Set<string>();
    for (const p of g.players) {
      if (!p.userId) continue;
      const won = p.isRadiant === g.radiantWin;
      const pts = fantasyPoints(p, won);
      const prev = playerPoints.get(p.userId);
      playerPoints.set(p.userId, {
        points: Math.round(((prev?.points ?? 0) + pts) * 10) / 10,
        heroId: p.heroId ?? prev?.heroId ?? null,
      });
      const teamId = teamOf.get(p.userId);
      if (teamId) {
        teamPoints.set(
          teamId,
          Math.round(((teamPoints.get(teamId) ?? 0) + pts) * 10) / 10,
        );
        if (won) winningTeams.add(teamId);
      }
    }
    for (const t of winningTeams) {
      teamWins.set(t, (teamWins.get(t) ?? 0) + 1);
    }
  }

  let player: WeeklyHonors["player"] = null;
  for (const [userId, v] of playerPoints) {
    if (!player || v.points > player.points) {
      player = { userId, points: v.points, heroId: v.heroId };
    }
  }

  let team: WeeklyHonors["team"] = null;
  for (const [teamId, points] of teamPoints) {
    const gameWins = teamWins.get(teamId) ?? 0;
    if (
      !team ||
      gameWins > team.gameWins ||
      (gameWins === team.gameWins && points > team.points)
    ) {
      team = { teamId, gameWins, points };
    }
  }

  return { player, team };
}
