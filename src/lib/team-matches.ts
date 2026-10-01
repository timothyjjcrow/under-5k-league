// Per-team match views: recent form + head-to-head records. Pure + testable
// (no DB). Unlike standings (regular season only), these summarize *all*
// completed meetings, so playoff rematches show up in a team's history too.

import { MATCH_STATUS, SEASON_STATUS } from "./constants";

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
  const done = orderedMatches.filter((m) => m.status === MATCH_STATUS.COMPLETED);
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

export type SeriesOrderMatch = TeamMatchLike & {
  id: string;
  week: number;
  scheduledAt: Date | null;
};

/**
 * Series in the order the league played them: week, then kickoff (an
 * untimed fixture last in its week), then id. Never lean on a query's
 * order: Home reads matches by week alone and /schedule by week then
 * createdAt, so two series of one team in one week (a tiebreaker knockout)
 * could come back either way round.
 */
export function compareSeriesOrder(
  a: SeriesOrderMatch,
  b: SeriesOrderMatch,
): number {
  const kickoff = (m: SeriesOrderMatch) =>
    m.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return a.week - b.week || kickoff(a) - kickoff(b) || a.id.localeCompare(b.id);
}

/** A run of series wins is news from this many in a row. */
export const WIN_STREAK_MIN = 2;

/**
 * Consecutive series wins up to the team's latest result: a draw or a loss
 * ends it. `orderedMatches` must be in play order (`compareSeriesOrder`), the
 * same list the Last 5 strip reads, so the chip and the strip always agree.
 * Every phase counts, as in the strip.
 */
export function seriesWinStreak(
  teamId: string,
  orderedMatches: readonly TeamMatchLike[],
): number {
  const mine = orderedMatches.filter(
    (m) =>
      m.status === MATCH_STATUS.COMPLETED &&
      (m.homeTeamId === teamId || m.awayTeamId === teamId),
  );
  let streak = 0;
  for (let i = mine.length - 1; i >= 0; i--) {
    if (resultFor(teamId, mine[i]) !== "W") break;
    streak += 1;
  }
  return streak;
}

/**
 * Streak chips belong on a live table: the active season's regular season or
 * playoffs. A finished or archived season's last run is history, not news.
 */
export function standingsStreaksShown(season: {
  isActive: boolean;
  status: string;
}): boolean {
  return (
    season.isActive &&
    (season.status === SEASON_STATUS.REGULAR_SEASON ||
      season.status === SEASON_STATUS.PLAYOFFS)
  );
}

/**
 * The standings' Last 5 strip and win streaks for every team, from ONE list
 * in play order, so a "W3" chip always matches the strip beside it.
 * `streaks` is set only when asked for (`standingsStreaksShown`).
 */
export function standingsForm(
  teamIds: string[],
  matches: readonly SeriesOrderMatch[],
  options: { streaks: boolean },
): { form: Map<string, FormResult[]>; streaks?: Map<string, number> } {
  const ordered = [...matches].sort(compareSeriesOrder);
  return {
    form: formByTeam(teamIds, ordered),
    streaks: options.streaks
      ? new Map(teamIds.map((id) => [id, seriesWinStreak(id, ordered)]))
      : undefined,
  };
}

export type SeriesRecordCounts = {
  wins: number;
  draws: number;
  losses: number;
};

/**
 * A team's series record in the standings' order (wins, draws, losses) with
 * the letters attached: "5W 1D 2L". Every page that shows a team's record
 * uses this, because bare numbers in another order ("5–2–1") read as draws
 * where the losses are to anyone used to the standings.
 */
export function seriesRecordText(r: SeriesRecordCounts): string {
  return `${r.wins}W ${r.draws}D ${r.losses}L`;
}

/** The same record for a screen reader: "5 won, 1 drawn, 2 lost". */
export function seriesRecordSpoken(r: SeriesRecordCounts): string {
  return `${r.wins} won, ${r.draws} drawn, ${r.losses} lost`;
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
    if (m.status !== MATCH_STATUS.COMPLETED) continue;
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

/**
 * The head-to-head rows worth their own card: opponents met in more than one
 * completed series (a tiebreaker week, a playoff rematch, a double round
 * robin). A single meeting is already the result on the team's match list.
 */
export function rematches(rows: readonly HeadToHead[]): HeadToHead[] {
  return rows.filter((r) => r.wins + r.draws + r.losses > 1);
}

export type FixtureOrderMatch = {
  id: string;
  status: string;
  week: number;
  scheduledAt: Date | null;
};

/**
 * A team page's fixture list, most useful first: a live series, then the
 * series still to play by kickoff (untimed ones last), then results newest
 * first. Results sort by kickoff (untimed as oldest), then week, the same
 * "latest result" rule as the team's match spotlight.
 */
export function teamFixtureOrder<T extends FixtureOrderMatch>(
  matches: readonly T[],
): T[] {
  const kickoff = (m: T, missing: number) =>
    m.scheduledAt?.getTime() ?? missing;
  const upcoming = (a: T, b: T) =>
    kickoff(a, Number.MAX_SAFE_INTEGER) - kickoff(b, Number.MAX_SAFE_INTEGER) ||
    a.week - b.week ||
    a.id.localeCompare(b.id);
  const live = matches.filter((m) => m.status === MATCH_STATUS.LIVE);
  const open = matches.filter(
    (m) =>
      m.status !== MATCH_STATUS.LIVE && m.status !== MATCH_STATUS.COMPLETED,
  );
  const done = matches.filter((m) => m.status === MATCH_STATUS.COMPLETED);
  return [
    ...live.sort(upcoming),
    ...open.sort(upcoming),
    ...done.sort(
      (a, b) =>
        kickoff(b, 0) - kickoff(a, 0) ||
        b.week - a.week ||
        b.id.localeCompare(a.id),
    ),
  ];
}
