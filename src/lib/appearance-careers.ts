import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";

type MatchFact = {
  id: string; seasonId: string; status: string; winnerTeamId: string | null;
  homeTeamId: string; awayTeamId: string;
};
type GameFact = { id: string; matchId: string; players: string; radiantWin: boolean };
export type AppearanceCareer = {
  userId: string; teamId: string; seasonId: string;
  games: number; wins: number; seriesWins: number; seriesLosses: number; seriesDraws: number;
  championshipContribution: boolean;
};

/** Played careers use recorded appearances, never today's roster. Team honors
 * remain official team outcomes; an individual's contribution is explicitly
 * the fact that they appeared for that team during its championship season. */
export function appearanceCareers(
  games: readonly GameFact[],
  matches: readonly MatchFact[],
  champions: readonly { seasonId: string; teamId: string }[],
) {
  const matchOf = new Map(matches.map((match) => [match.id, match]));
  const championOf = new Map(champions.map((row) => [row.seasonId, row.teamId]));
  const rows = new Map<string, AppearanceCareer>();
  const seenGames = new Set<string>();
  const seenSeries = new Set<string>();
  let trustedGames = 0;
  let attributedLines = 0;
  let unattributedLines = 0;
  for (const game of games) {
    if (seenGames.has(game.id)) continue;
    seenGames.add(game.id);
    const match = matchOf.get(game.matchId);
    if (!match) continue;
    const players = trustedGamePlayers(decodeGamePlayers(game.players));
    if (!players.length) continue;
    trustedGames++;
    for (const player of players) {
      if (!player.userId || !player.teamId ||
        (player.teamId !== match.homeTeamId && player.teamId !== match.awayTeamId)) {
        unattributedLines++;
        continue;
      }
      attributedLines++;
      const key = JSON.stringify([player.userId, player.teamId]);
      let row = rows.get(key);
      if (!row) {
        row = { userId: player.userId, teamId: player.teamId, seasonId: match.seasonId,
          games: 0, wins: 0, seriesWins: 0, seriesLosses: 0, seriesDraws: 0,
          championshipContribution: championOf.get(match.seasonId) === player.teamId };
        rows.set(key, row);
      }
      row.games++;
      if (player.isRadiant === game.radiantWin) row.wins++;
      const seriesKey = JSON.stringify([match.id, player.userId, player.teamId]);
      if (match.status !== "COMPLETED" || seenSeries.has(seriesKey)) continue;
      seenSeries.add(seriesKey);
      if (!match.winnerTeamId) row.seriesDraws++;
      else if (match.winnerTeamId === player.teamId) row.seriesWins++;
      else row.seriesLosses++;
    }
  }
  const seriesWins = new Map<string, number>();
  const championshipContributions = new Map<string, number>();
  for (const row of rows.values()) {
    seriesWins.set(row.userId, (seriesWins.get(row.userId) ?? 0) + row.seriesWins);
    if (row.championshipContribution) {
      championshipContributions.set(row.userId, (championshipContributions.get(row.userId) ?? 0) + 1);
    }
  }
  return { rows: [...rows.values()], seriesWins, championshipContributions,
    coverage: { importedGames: seenGames.size, trustedGames, attributedLines, unattributedLines } };
}
