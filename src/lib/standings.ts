// Compute league standings from completed matches. Pure + testable.
// Points: 3 per series win, 0 per loss. Tiebreakers: game (map) differential,
// total series wins, then HEAD-TO-HEAD among the still-tied (a mini-table of
// the tied teams' meetings — mini points, then mini game diff), and only then
// team id — determinism's last resort, never the thing that decides a playoff
// seed between teams the schedule actually separated.

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
 * How many places each team moved vs. the table before the latest completed
 * regular week's results (positive = climbed). Zero for everyone until a
 * second data point exists.
 */
export function standingsMovement(
  teamIds: string[],
  matches: (MatchLike & { week: number })[],
): Map<string, number> {
  const completedRegular = matches.filter(
    (m) => m.phase === "REGULAR" && m.status === "COMPLETED",
  );
  const movement = new Map(teamIds.map((id) => [id, 0]));
  if (completedRegular.length === 0) return movement;
  const lastWeek = Math.max(...completedRegular.map((m) => m.week));
  // One completed week is a single data point: the "before" table would be
  // the all-zero preseason ordering (arbitrary teamId order), so any arrows
  // would be alphabetical noise dressed up as movement.
  if (!completedRegular.some((m) => m.week !== lastWeek)) return movement;

  const rankOf = (rows: TeamStanding[]) =>
    new Map(rows.map((r, i) => [r.teamId, i]));
  const now = rankOf(computeStandings(teamIds, matches));
  const before = rankOf(
    computeStandings(
      teamIds,
      matches.filter(
        (m) =>
          !(
            m.phase === "REGULAR" &&
            m.status === "COMPLETED" &&
            m.week === lastWeek
          ),
      ),
    ),
  );
  for (const id of teamIds) {
    movement.set(id, (before.get(id) ?? 0) - (now.get(id) ?? 0));
  }
  return movement;
}

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

  // Head-to-head pass: re-order each group tied on EVERY criterion above
  // (bar the id fallback) by their own meetings. Done as a second pass —
  // not inside the comparator — because a mini-table is a property of the
  // whole tied GROUP, and pairwise comparison of a 3-way tie isn't
  // transitive (A beat B, B beat C, C beat A would break Array.sort).
  const samePrimary = (a: TeamStanding, b: TeamStanding) =>
    a.points === b.points && a.gameDiff === b.gameDiff && a.wins === b.wins;
  for (let i = 0; i < rows.length; ) {
    let j = i + 1;
    while (j < rows.length && samePrimary(rows[i], rows[j])) j++;
    if (j - i > 1) {
      const group = rows.slice(i, j);
      const h2h = headToHeadRanks(
        group.map((r) => r.teamId),
        matches,
      );
      group.sort(
        (a, b) =>
          h2h.get(a.teamId)! - h2h.get(b.teamId)! ||
          a.teamId.localeCompare(b.teamId),
      );
      rows.splice(i, j - i, ...group);
    }
    i = j;
  }
  return rows;
}

/**
 * Rank a fully-tied group by a mini-table of ONLY their meetings (regular
 * season, same 3/1/0 scoring; mini game diff as its own tiebreak). Teams with
 * identical mini-records SHARE a rank — head-to-head must never invent an
 * ordering it can't justify, so the caller's deterministic id fallback decides
 * those (exactly the pre-head-to-head behavior). Pure and exported for tests.
 */
export function headToHeadRanks(
  tiedIds: string[],
  matches: MatchLike[],
): Map<string, number> {
  const inGroup = new Set(tiedIds);
  const mini = new Map(tiedIds.map((id) => [id, { points: 0, diff: 0 }]));
  for (const m of matches) {
    if (m.status !== "COMPLETED" || m.phase !== "REGULAR") continue;
    if (!inGroup.has(m.homeTeamId) || !inGroup.has(m.awayTeamId)) continue;
    const home = mini.get(m.homeTeamId)!;
    const away = mini.get(m.awayTeamId)!;
    home.diff += m.homeScore - m.awayScore;
    away.diff += m.awayScore - m.homeScore;
    if (m.winnerTeamId === m.homeTeamId) home.points += 3;
    else if (m.winnerTeamId === m.awayTeamId) away.points += 3;
    else {
      home.points += 1;
      away.points += 1;
    }
  }
  const ordered = [...mini.entries()].sort(
    ([, a], [, b]) => b.points - a.points || b.diff - a.diff,
  );
  const ranks = new Map<string, number>();
  ordered.forEach(([id, rec], i) => {
    const prev = i > 0 ? ordered[i - 1] : null;
    ranks.set(
      id,
      prev && prev[1].points === rec.points && prev[1].diff === rec.diff
        ? ranks.get(prev[0])!
        : i,
    );
  });
  return ranks;
}
