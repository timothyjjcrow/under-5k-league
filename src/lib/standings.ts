// Compute league standings from completed matches. Pure + testable.
// Points: 3 per series win, 0 per loss. Tiebreakers: game (map) differential,
// then total series wins.

export type MatchLike = {
  homeTeamId: string;
  awayTeamId: string;
  status: string;
  homeScore: number;
  awayScore: number;
  winnerTeamId: string | null;
  phase: string;
};

export type TeamStanding = {
  teamId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  gameWins: number;
  gameLosses: number;
  gameDiff: number;
};

/**
 * Sanity-check a recorded series score against its best-of. Partial results
 * (forfeits, abandoned series) are fine — only impossible scores are rejected.
 * Returns an error message, or null when the score is plausible.
 */
export function seriesScoreError(
  bestOf: number,
  homeScore: number,
  awayScore: number,
): string | null {
  if (homeScore + awayScore > bestOf) {
    return `A best-of-${bestOf} has at most ${bestOf} games — ${homeScore}–${awayScore} is too many.`;
  }
  // Odd series stop at the clinching win; even ones (Bo2) play every game,
  // so for those the total-games cap above is the only constraint.
  if (bestOf % 2 === 1) {
    const needed = Math.ceil(bestOf / 2);
    if (homeScore > needed || awayScore > needed) {
      return `A best-of-${bestOf} is first to ${needed} — a team can't win ${Math.max(homeScore, awayScore)} games.`;
    }
  }
  return null;
}

export type ClinchStatus = "CLINCHED" | "ELIMINATED" | null;

/**
 * Which teams have already locked up (or lost) a playoff spot, given the
 * remaining regular-season schedule. Deliberately conservative on both sides —
 * tiebreakers and shared remaining games are ignored, so a team is only marked
 * when the raw points math is beyond doubt:
 * - CLINCHED: even losing out, at most cut−1 other teams could catch them
 *   (ties counted against them).
 * - ELIMINATED: even winning out, at least `cut` teams already sit beyond
 *   reach on banked points alone.
 */
export function clinchStatuses(
  standings: TeamStanding[],
  matches: MatchLike[],
  playoffCut: number,
): Map<string, ClinchStatus> {
  const remaining = new Map<string, number>();
  for (const m of matches) {
    if (m.phase !== "REGULAR" || m.status === "COMPLETED") continue;
    remaining.set(m.homeTeamId, (remaining.get(m.homeTeamId) ?? 0) + 1);
    remaining.set(m.awayTeamId, (remaining.get(m.awayTeamId) ?? 0) + 1);
  }
  const maxPts = new Map(
    standings.map((s) => [
      s.teamId,
      s.points + 3 * (remaining.get(s.teamId) ?? 0),
    ]),
  );

  const result = new Map<string, ClinchStatus>();
  for (const t of standings) {
    const othersWhoCouldFinishAhead = standings.filter(
      (o) => o.teamId !== t.teamId && maxPts.get(o.teamId)! >= t.points,
    ).length;
    const othersCertainlyAhead = standings.filter(
      (o) => o.teamId !== t.teamId && o.points > maxPts.get(t.teamId)!,
    ).length;
    result.set(
      t.teamId,
      othersWhoCouldFinishAhead <= playoffCut - 1
        ? "CLINCHED"
        : othersCertainlyAhead >= playoffCut
          ? "ELIMINATED"
          : null,
    );
  }
  return result;
}

export function computeStandings(
  teamIds: string[],
  matches: MatchLike[],
): TeamStanding[] {
  const table = new Map<string, TeamStanding>();
  for (const id of teamIds) {
    table.set(id, {
      teamId: id,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      points: 0,
      gameWins: 0,
      gameLosses: 0,
      gameDiff: 0,
    });
  }

  for (const m of matches) {
    if (m.status !== "COMPLETED") continue;
    if (m.phase !== "REGULAR") continue; // playoffs don't affect the table
    const home = table.get(m.homeTeamId);
    const away = table.get(m.awayTeamId);
    if (!home || !away) continue;

    home.played++;
    away.played++;
    home.gameWins += m.homeScore;
    home.gameLosses += m.awayScore;
    away.gameWins += m.awayScore;
    away.gameLosses += m.homeScore;

    if (m.winnerTeamId === m.homeTeamId) {
      home.wins++;
      home.points += 3;
      away.losses++;
    } else if (m.winnerTeamId === m.awayTeamId) {
      away.wins++;
      away.points += 3;
      home.losses++;
    } else {
      // A drawn series (e.g. a 1-1 best-of-2) — a point each.
      home.draws++;
      away.draws++;
      home.points += 1;
      away.points += 1;
    }
  }

  const rows = [...table.values()];
  for (const r of rows) r.gameDiff = r.gameWins - r.gameLosses;
  rows.sort(
    (a, b) =>
      b.points - a.points ||
      b.gameDiff - a.gameDiff ||
      b.wins - a.wins ||
      a.teamId.localeCompare(b.teamId),
  );
  return rows;
}
