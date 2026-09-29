// Pure helpers for the profile's match history and standout game.

import { fantasyPoints, type FantasyStatLine } from "./fantasy";

/**
 * The player's best game: the highest fantasy (impact) points, the same
 * rating that crowns Match MVP, so a support's big game can stand out as much
 * as a carry's. Net worth used to decide it, which meant the richest game
 * always won. Ties go to more kills, then fewer deaths, then the first row
 * given (callers pass games newest first, so the more recent one).
 */
export function pickStandout<T extends { stat: FantasyStatLine; won: boolean }>(
  rows: readonly T[],
): T | null {
  let best: { row: T; pts: number } | null = null;
  for (const row of rows) {
    const pts = fantasyPoints(row.stat, row.won);
    if (
      !best ||
      pts > best.pts ||
      (pts === best.pts &&
        (row.stat.kills > best.row.stat.kills ||
          (row.stat.kills === best.row.stat.kills &&
            row.stat.deaths < best.row.stat.deaths)))
    ) {
      best = { row, pts };
    }
  }
  return best?.row ?? null;
}

/**
 * A player's games grouped one entry per series (league match), in the order
 * the series first appear (callers pass games newest first, so the latest
 * series leads). Inside a series the games run in the order they were played;
 * a game with no recorded start time goes last.
 */
export function groupBySeries<T extends { matchId: string; startTime: number }>(
  rows: readonly T[],
): { matchId: string; games: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const list = groups.get(row.matchId);
    if (list) list.push(row);
    else groups.set(row.matchId, [row]);
  }
  const played = (t: number) => (t > 0 ? t : Number.POSITIVE_INFINITY);
  return [...groups].map(([matchId, games]) => ({
    matchId,
    games: games
      .map((game, i) => ({ game, i }))
      .sort((a, b) => played(a.game.startTime) - played(b.game.startTime) || a.i - b.i)
      .map(({ game }) => game),
  }));
}

export type SeriesOutcome = {
  /** W/L/D for a decided series, null while it is still being played. */
  result: "W" | "L" | "D" | null;
  /** "Won 2–0", "Lost 1–2", "Drew 1–1", "In progress · 1–0". */
  label: string;
};

/**
 * The series result from the player's side: the team they played for in it.
 * When their line carries no team (an unattributed box score), fall back to
 * their own games in the series.
 */
export function seriesOutcome(
  match: {
    status: string;
    winnerTeamId: string | null;
    homeTeamId: string;
    awayTeamId: string;
    homeScore: number;
    awayScore: number;
    forfeit?: boolean;
  },
  teamId: string | null | undefined,
  games: readonly { won: boolean }[],
): SeriesOutcome {
  const side =
    teamId === match.homeTeamId ? "home" : teamId === match.awayTeamId ? "away" : null;
  if (!side) {
    const wins = games.filter((g) => g.won).length;
    const losses = games.length - wins;
    return {
      result: wins > losses ? "W" : wins < losses ? "L" : "D",
      label: `${wins}–${losses} in their games`,
    };
  }
  const us = side === "home" ? match.homeScore : match.awayScore;
  const them = side === "home" ? match.awayScore : match.homeScore;
  const score = `${us}–${them}`;
  if (match.status !== "COMPLETED") {
    return { result: null, label: `In progress · ${score}` };
  }
  // The flag means at least part of the score was ruled by an admin, which
  // can include a series they partly played, so it is a note, not "by".
  const ruled = match.forfeit ? " · forfeit" : "";
  if (match.winnerTeamId === null) {
    return { result: "D", label: `Drew ${score}${ruled}` };
  }
  return match.winnerTeamId === teamId
    ? { result: "W", label: `Won ${score}${ruled}` }
    : { result: "L", label: `Lost ${score}${ruled}` };
}

/**
 * The other side of a league match from the team the player played for. When
 * their line carries no team (an unattributed box score), both teams are
 * named, since either could have been the opponent.
 */
export function seriesOpponent(
  match: {
    homeTeamId: string;
    awayTeamId: string;
    homeTeam: { name: string };
    awayTeam: { name: string };
  },
  teamId: string | null | undefined,
): string {
  if (teamId === match.homeTeamId) return match.awayTeam.name;
  if (teamId === match.awayTeamId) return match.homeTeam.name;
  return `${match.homeTeam.name} / ${match.awayTeam.name}`;
}

/**
 * The mean of the values a game actually recorded, rounded, or null when none
 * did. Older imports lack the economy fields (net worth, GPM, last hits), so a
 * missing value is left out rather than averaged in as zero.
 */
export function recordedAverage(
  values: readonly (number | null | undefined)[],
): number | null {
  const recorded = values.filter((v): v is number => v != null);
  if (recorded.length === 0) return null;
  return Math.round(recorded.reduce((sum, v) => sum + v, 0) / recorded.length);
}

type HistorySeriesLike = {
  match: { seasonId: string; season: { name: string } };
};

type SeasonHistoryGroup<T> = {
  seasonId: string;
  seasonName: string;
  series: T[];
};

export type SeasonHistoryView<T> = {
  groups: SeasonHistoryGroup<T>[];
  multiSeason: boolean;
  /** The `?season=` group, when it names a season they played in. */
  selected: SeasonHistoryGroup<T> | undefined;
  /** The series the list shows: one season's, or every season's in order. */
  visible: T[];
  countBySeason: ReadonlyMap<string, number>;
  /** A header per season only when the list mixes seasons. */
  showSeasonHeaders: boolean;
};

/**
 * The profile's match history split by season. Series arrive latest first and
 * keep that order; a season stays one group even when a game with no start
 * time sorts out of order. `selectedSeasonId` is the `?season=` filter: an
 * unknown id falls back to every season rather than showing a misleading
 * empty history, so a link copied from an old profile stays useful after a
 * season is removed.
 */
export function seasonHistoryView<T extends HistorySeriesLike>(
  series: readonly T[],
  selectedSeasonId: string | undefined,
): SeasonHistoryView<T> {
  const groups: SeasonHistoryGroup<T>[] = [];
  for (const entry of series) {
    const group = groups.find((g) => g.seasonId === entry.match.seasonId);
    if (group) group.series.push(entry);
    else
      groups.push({
        seasonId: entry.match.seasonId,
        seasonName: entry.match.season.name,
        series: [entry],
      });
  }
  const multiSeason = groups.length > 1;
  const selected = selectedSeasonId
    ? groups.find((group) => group.seasonId === selectedSeasonId)
    : undefined;
  return {
    groups,
    multiSeason,
    selected,
    visible: selected ? selected.series : groups.flatMap((g) => g.series),
    countBySeason: new Map(groups.map((g) => [g.seasonId, g.series.length])),
    showSeasonHeaders: multiSeason && !selected,
  };
}
