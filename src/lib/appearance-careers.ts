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

/**
 * The game half of appearanceCareers, small enough for the public cache: every
 * trusted line folded per match, player and team, with ids interned. It holds
 * no match outcome and no champion, so a reader folds those in from rows it
 * reads fresh (careersFromFacts) and a series result shows as soon as it is
 * written. Plain JSON: it survives the cache's round trip unchanged.
 */
export type AppearanceFacts = {
  /** Distinct imported games, trusted or not. */
  importedGames: number;
  /** [match id, trusted games in it], in first-seen order. */
  matches: [string, number][];
  users: string[];
  teams: string[];
  /** [match, user, team, lines, wins], indexes into the lists above (-1 for a
   *  line with no user or no team), in the order the lines were first seen. */
  lines: [number, number, number, number, number][];
};

export function appearanceFacts(games: readonly GameFact[]): AppearanceFacts {
  const facts: AppearanceFacts = { importedGames: 0, matches: [], users: [], teams: [], lines: [] };
  const matchIndex = new Map<string, number>();
  const userIndex = new Map<string, number>();
  const teamIndex = new Map<string, number>();
  const lineIndex = new Map<string, number>();
  const intern = (index: Map<string, number>, list: string[], id: string | null) => {
    if (!id) return -1;
    let at = index.get(id);
    if (at === undefined) {
      at = list.push(id) - 1;
      index.set(id, at);
    }
    return at;
  };
  const seenGames = new Set<string>();
  for (const game of games) {
    if (seenGames.has(game.id)) continue;
    seenGames.add(game.id);
    const players = trustedGamePlayers(decodeGamePlayers(game.players));
    if (!players.length) continue;
    let m = matchIndex.get(game.matchId);
    if (m === undefined) {
      m = facts.matches.push([game.matchId, 0]) - 1;
      matchIndex.set(game.matchId, m);
    }
    facts.matches[m][1]++;
    for (const player of players) {
      const u = intern(userIndex, facts.users, player.userId);
      const t = intern(teamIndex, facts.teams, player.teamId);
      const key = `${m}:${u}:${t}`;
      let at = lineIndex.get(key);
      if (at === undefined) {
        at = facts.lines.push([m, u, t, 0, 0]) - 1;
        lineIndex.set(key, at);
      }
      facts.lines[at][3]++;
      if (player.isRadiant === game.radiantWin) facts.lines[at][4]++;
    }
  }
  facts.importedGames = seenGames.size;
  return facts;
}

/** appearanceCareers over cached facts: the same rows, in the same order. */
export function careersFromFacts(
  facts: AppearanceFacts,
  matches: readonly MatchFact[],
  champions: readonly { seasonId: string; teamId: string }[],
) {
  const matchOf = new Map(matches.map((match) => [match.id, match]));
  const championOf = new Map(champions.map((row) => [row.seasonId, row.teamId]));
  const rows = new Map<string, AppearanceCareer>();
  let trustedGames = 0;
  let attributedLines = 0;
  let unattributedLines = 0;
  for (const [matchId, count] of facts.matches) {
    if (matchOf.has(matchId)) trustedGames += count;
  }
  // Each fact is one (match, user, team): its series counts once, as the
  // per-line walk counted it once per match, player and team.
  for (const [m, u, t, lines, wins] of facts.lines) {
    const match = matchOf.get(facts.matches[m][0]);
    if (!match) continue;
    const userId = u < 0 ? null : facts.users[u];
    const teamId = t < 0 ? null : facts.teams[t];
    if (!userId || !teamId ||
      (teamId !== match.homeTeamId && teamId !== match.awayTeamId)) {
      unattributedLines += lines;
      continue;
    }
    attributedLines += lines;
    const key = JSON.stringify([userId, teamId]);
    let row = rows.get(key);
    if (!row) {
      row = { userId, teamId, seasonId: match.seasonId,
        games: 0, wins: 0, seriesWins: 0, seriesLosses: 0, seriesDraws: 0,
        championshipContribution: championOf.get(match.seasonId) === teamId };
      rows.set(key, row);
    }
    row.games += lines;
    row.wins += wins;
    if (match.status !== "COMPLETED") continue;
    if (!match.winnerTeamId) row.seriesDraws++;
    else if (match.winnerTeamId === teamId) row.seriesWins++;
    else row.seriesLosses++;
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
    coverage: { importedGames: facts.importedGames, trustedGames, attributedLines, unattributedLines } };
}

/** Played careers use recorded appearances, never today's roster. Team honors
 * remain official team outcomes; an individual's contribution is explicitly
 * the fact that they appeared for that team during its championship season. */
export function appearanceCareers(
  games: readonly GameFact[],
  matches: readonly MatchFact[],
  champions: readonly { seasonId: string; teamId: string }[],
) {
  return careersFromFacts(appearanceFacts(games), matches, champions);
}
