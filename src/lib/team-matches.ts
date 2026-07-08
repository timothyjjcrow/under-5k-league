// Per-team match views: recent form + head-to-head records. Pure + testable
// (no DB). Unlike standings (regular season only), these summarize *all*
// completed meetings, so playoff rematches show up in a team's history too.

export type TeamMatchLike = {
  homeTeamId: string;
  awayTeamId: string;
  status: string;
  winnerTeamId: string | null;
  homeScore: number;
  awayScore: number;
};

export type FormResult = "W" | "L" | "D";

export function resultFor(teamId: string, m: TeamMatchLike): FormResult {
  if (m.winnerTeamId === teamId) return "W";
  if (m.winnerTeamId === null) return "D";
  return "L";
}

/**
 * Most-recent-first W/L/D strip for a team. `orderedMatches` is expected in
 * chronological (ascending) order; we take the last `limit` completed ones.
 */
export function recentForm(
  teamId: string,
  orderedMatches: TeamMatchLike[],
  limit = 5,
): FormResult[] {
  const done = orderedMatches.filter((m) => m.status === "COMPLETED");
  return done
    .slice(-limit)
    .reverse()
    .map((m) => resultFor(teamId, m));
}

/**
 * Recent form for every team, keyed by id. `orderedMatches` should be the
 * season's matches in chronological order; each team's slice preserves it.
 */
export function formByTeam(
  teamIds: string[],
  orderedMatches: TeamMatchLike[],
  limit = 5,
): Map<string, FormResult[]> {
  const map = new Map<string, FormResult[]>();
  for (const id of teamIds) {
    const mine = orderedMatches.filter(
      (m) => m.homeTeamId === id || m.awayTeamId === id,
    );
    map.set(id, recentForm(id, mine, limit));
  }
  return map;
}

export type HeadToHead = {
  opponentId: string;
  wins: number;
  losses: number;
  draws: number;
  gamesFor: number;
  gamesAgainst: number;
};

/** Series + game tallies against each opponent this team has played. */
export function headToHead(
  teamId: string,
  matches: TeamMatchLike[],
): HeadToHead[] {
  const map = new Map<string, HeadToHead>();
  for (const m of matches) {
    if (m.status !== "COMPLETED") continue;
    const isHome = m.homeTeamId === teamId;
    const isAway = m.awayTeamId === teamId;
    if (!isHome && !isAway) continue;
    const oppId = isHome ? m.awayTeamId : m.homeTeamId;
    if (oppId === teamId) continue; // guard against malformed self-matches

    const h = map.get(oppId) ?? {
      opponentId: oppId,
      wins: 0,
      losses: 0,
      draws: 0,
      gamesFor: 0,
      gamesAgainst: 0,
    };
    h.gamesFor += isHome ? m.homeScore : m.awayScore;
    h.gamesAgainst += isHome ? m.awayScore : m.homeScore;
    if (m.winnerTeamId === teamId) h.wins++;
    else if (m.winnerTeamId === null) h.draws++;
    else h.losses++;
    map.set(oppId, h);
  }
  return [...map.values()];
}
