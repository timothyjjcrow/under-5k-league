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
  /**
   * The grand final has a result but the title isn't confirmed yet (season
   * not complete, or the final is under review). Neither finalist is crowned
   * or called runner-up until it is, the rule the team pages follow
   * (playoffStatuses).
   */
  | { kind: "finalPending" }
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
  const isFinal = (m: PlayoffRunMatch) =>
    m.phase === MATCH_PHASE.FINAL ||
    (totalRounds > 0 && slotRound(m.bracketSlot) === totalRounds - 1);

  const lost = mine.find(
    (m) =>
      m.status === MATCH_STATUS.COMPLETED &&
      m.winnerTeamId != null &&
      m.winnerTeamId !== teamId,
  );
  if (lost) {
    if (!isFinal(lost)) return { kind: "out", round: label(lost) };
    // Runner-up only once the final's winner is the confirmed champion.
    return championTeamId === lost.winnerTeamId
      ? { kind: "runnerUp" }
      : { kind: "finalPending" };
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
  const last = mine[mine.length - 1];
  // Won the final, but the champion (checked first) isn't this team yet.
  if (isFinal(last)) return { kind: "finalPending" };
  return { kind: "through", round: label(last) };
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
    case "finalPending":
      return { value: "Grand final", hint: "Result pending" };
    case "missed":
      return { value: "Missed", hint: "Didn't make the playoffs" };
  }
}

/** One completed series on a team's way through the bracket. */
export type PlayoffRoadStep = {
  matchId: string;
  /** "Quarterfinal", "Semifinal" (matchRoundLabel). */
  round: string;
  opponentId: string;
  /** Games this team won and lost in the series. */
  won: number;
  lost: number;
  /** Whether this team took the series. */
  wonSeries: boolean;
};

/**
 * The postseason series `teamId` finished before `match`'s round, earliest
 * first: a finalist's road to the final, a semifinalist's quarterfinal. Empty
 * in the first round, for a team the draw sent straight into this round, and
 * for a match with no bracket slot. Only rounds BEFORE this one count, so a
 * rematch in a later round never shows up as part of the way here.
 */
export function playoffRoad(
  teamId: string,
  match: { id: string; phase: string; bracketSlot: string | null },
  matches: readonly (PlayoffRunMatch & { homeScore: number; awayScore: number })[],
): PlayoffRoadStep[] {
  if (!isPostseason(match) || !match.bracketSlot) return [];
  const postseason = matches.filter(isPostseason);
  const totalRounds = playoffTotalRounds(postseason);
  const thisRound = slotRound(match.bracketSlot);
  return postseason
    .filter(
      (m) =>
        m.id !== match.id &&
        m.status === MATCH_STATUS.COMPLETED &&
        m.bracketSlot != null &&
        slotRound(m.bracketSlot) < thisRound &&
        (m.homeTeamId === teamId || m.awayTeamId === teamId),
    )
    .sort(
      (a, b) =>
        slotRound(a.bracketSlot) - slotRound(b.bracketSlot) ||
        a.id.localeCompare(b.id),
    )
    .map((m) => {
      const home = m.homeTeamId === teamId;
      return {
        matchId: m.id,
        round: matchRoundLabel(m, totalRounds),
        opponentId: home ? m.awayTeamId : m.homeTeamId,
        won: home ? m.homeScore : m.awayScore,
        lost: home ? m.awayScore : m.homeScore,
        wonSeries: m.winnerTeamId === teamId,
      };
    });
}

/**
 * The heading over both teams' roads, from the match's round label: "Road to
 * the grand final", "Road to the semifinal", "Road to round 2". A label it
 * can't place ("Playoffs") gives "Road here".
 */
export function playoffRoadTitle(roundLabel: string): string {
  if (/^(Grand final|Semifinal|Quarterfinal)$/.test(roundLabel)) {
    return `Road to the ${roundLabel.toLowerCase()}`;
  }
  if (/^Round \d+$/.test(roundLabel)) return `Road to ${roundLabel.toLowerCase()}`;
  return "Road here";
}
