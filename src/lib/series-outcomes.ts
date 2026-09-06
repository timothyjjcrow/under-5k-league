import { playedSeriesFinalError, seriesScoreError } from "./standings";

export type SeriesProgress = {
  bestOf: number;
  homeScore?: number;
  awayScore?: number;
};

/** Scorelines preserve games already recorded; null requests a safe fallback. */
export function possibleSeriesScores(
  match: SeriesProgress,
  playedToCompletion: boolean,
): { homeScore: number; awayScore: number }[] | null {
  const { bestOf } = match;
  const home = match.homeScore ?? 0;
  const away = match.awayScore ?? 0;
  // Bound input work independently of the outcome-tree cap.
  if (!Number.isInteger(bestOf) || bestOf < 1 || bestOf > 15 ||
      !Number.isInteger(home) || !Number.isInteger(away) ||
      home < 0 || away < 0 || seriesScoreError(bestOf, home, away)) return null;
  const scores = [];
  for (let h = home; h <= bestOf; h++) {
    for (let a = away; a <= bestOf - h; a++) {
      const invalid = playedToCompletion
        ? playedSeriesFinalError(bestOf, h, a) : seriesScoreError(bestOf, h, a);
      if (!invalid) scores.push({ homeScore: h, awayScore: a });
    }
  }
  return scores.length ? scores : null;
}

/** Includes legal partial/abandoned results, unlike the normal-series forecast. */
export function possibleSeriesOutcomes(match: SeriesProgress): number[] {
  const scores = possibleSeriesScores(match, false);
  if (!scores) return [0, 1, 2];
  return [...new Set(scores.map(({ homeScore: h, awayScore: a }) =>
    h > a ? 0 : h < a ? 1 : 2))];
}
