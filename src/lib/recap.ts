import type { AwardGame } from "./awards";
import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";

export type RecapGameInput = {
  matchId: string;
  radiantWin: boolean;
  radiantScore: number;
  direScore: number;
  durationSecs: number;
  players: string;
};

export type RecapGameSummary = {
  awardGames: AwardGame[];
  totalKills: number;
  trustedStatGames: number;
  totalDuration: number;
  timedGames: number;
  playerIds: Set<string>;
  heroIds: Set<number>;
};

/**
 * Build recap rollups through the same complete-5v5 trust boundary as Leaders
 * and Hero meta. Header-vs-line kill fallback is chosen per game because old
 * and new imports routinely coexist within one season.
 */
export function summarizeRecapGames(
  games: RecapGameInput[],
): RecapGameSummary {
  const awardGames: AwardGame[] = [];
  const playerIds = new Set<string>();
  const heroIds = new Set<number>();
  let totalKills = 0;
  let trustedStatGames = 0;
  let totalDuration = 0;
  let timedGames = 0;

  for (const game of games) {
    if (game.durationSecs > 0) {
      totalDuration += game.durationSecs;
      timedGames++;
    }
    const trusted = trustedGamePlayers(decodeGamePlayers(game.players));
    if (trusted.length === 0) continue;

    const lines = trusted.map((player) => {
      if (player.userId) playerIds.add(player.userId);
      heroIds.add(player.heroId);
      return {
        userId: player.userId,
        heroId: player.heroId,
        isRadiant: player.isRadiant,
        kills: player.kills,
        deaths: player.deaths,
        assists: player.assists,
        netWorth: player.netWorth,
        gpm: player.gpm,
      };
    });
    trustedStatGames++;
    const headerKills = game.radiantScore + game.direScore;
    const lineKills = lines.reduce((sum, line) => sum + line.kills, 0);
    totalKills += headerKills > 0 ? headerKills : lineKills;
    awardGames.push({
      matchId: game.matchId,
      radiantWin: game.radiantWin,
      radiantScore: game.radiantScore,
      direScore: game.direScore,
      lines,
    });
  }

  return {
    awardGames,
    totalKills,
    trustedStatGames,
    totalDuration,
    timedGames,
    playerIds,
    heroIds,
  };
}
