// A team's playoff run in one line, for the player profile's team tile. Once a
// season has a bracket, the regular-season rank ("#3 · 4–3 · 12 pts") no
// longer says where a team stands: a team in the final and one knocked out in
// the quarterfinal can share it. Pure and DB-free, over the same match rows
// the dashboard's bracket reads.

import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import { matchRoundLabel, playoffTotalRounds, slotRound } from "./schedule";

export type PlayoffRunMatch = {
  id: string;
  phase: string;
  week: number;
  bracketSlot: string | null;
  status: string;
  winnerTeamId: string | null;
  homeTeamId: string;
  awayTeamId: string;
};

export type PlayoffRun =
  /** The authoritative champion (resolveChampionPresentation's team). */
  | { kind: "champion" }
  | { kind: "runnerUp" }
  /** Knocked out before the final; `round` is the series they lost. */
  | { kind: "out"; round: string }
  /** Still alive with a series to play; `round` is that series. */
  | { kind: "alive"; round: string; live: boolean }
  /** Won everything so far, next round not drawn yet. */
  | { kind: "through"; round: string }
  /** The bracket exists and this team is not in it. */
  | { kind: "missed" };

const isPostseason = (m: { phase: string }) =>
  m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL;

/**
 * Where `teamId` stands in its season's playoffs, or null while there is no
 * bracket (regular season, or the bracket not seeded yet).
 *
 * `championTeamId` must be the resolved, public champion (null until the
 * season is complete and the final agrees), so a stale id never crowns a
 * team here that the rest of the site does not.
 */
export function teamPlayoffRun(
  teamId: string,
  matches: readonly PlayoffRunMatch[],
  championTeamId: string | null,
): PlayoffRun | null {
  const postseason = matches.filter(isPostseason);
  if (postseason.length === 0) return null;
  if (championTeamId === teamId) return { kind: "champion" };
  const totalRounds = playoffTotalRounds(postseason);
  const label = (m: PlayoffRunMatch) => matchRoundLabel(m, totalRounds);
  const mine = postseason
    .filter((m) => m.homeTeamId === teamId || m.awayTeamId === teamId)
    .sort(
      (a, b) =>
        slotRound(a.bracketSlot) - slotRound(b.bracketSlot) ||
        a.id.localeCompare(b.id),
    );
  if (mine.length === 0) return { kind: "missed" };

  const lost = mine.find(
    (m) =>
      m.status === MATCH_STATUS.COMPLETED &&
      m.winnerTeamId != null &&
      m.winnerTeamId !== teamId,
  );
  if (lost) {
    const isFinal =
      lost.phase === MATCH_PHASE.FINAL ||
      (totalRounds > 0 && slotRound(lost.bracketSlot) === totalRounds - 1);
    return isFinal ? { kind: "runnerUp" } : { kind: "out", round: label(lost) };
  }

  const open = mine.filter((m) => m.status !== MATCH_STATUS.COMPLETED);
  const next =
    open.find((m) => m.status === MATCH_STATUS.LIVE) ?? open[0] ?? null;
  if (next) {
    return {
      kind: "alive",
      round: label(next),
      live: next.status === MATCH_STATUS.LIVE,
    };
  }
  return { kind: "through", round: label(mine[mine.length - 1]) };
}

/** "in the quarterfinal", but "in round 1" (no article before a number). */
function inRound(round: string): string {
  return /^Round \d/.test(round)
    ? `in ${round.toLowerCase()}`
    : `in the ${round.toLowerCase()}`;
}

/** The profile tile's value and hint for a run. */
export function playoffRunTile(run: PlayoffRun): {
  value: string;
  hint: string;
} {
  switch (run.kind) {
    case "champion":
      return { value: "Champion", hint: "Won the grand final" };
    case "runnerUp":
      return { value: "Runner-up", hint: "Lost the grand final" };
    case "out":
      return { value: "Eliminated", hint: `Lost ${inRound(run.round)}` };
    case "alive":
      return { value: run.round, hint: run.live ? "Playing now" : "Up next" };
    case "through":
      return {
        value: "Through",
        hint: `Won ${inRound(run.round).replace(/^in /, "")}`,
      };
    case "missed":
      return { value: "Missed", hint: "Didn't make the playoffs" };
  }
}
