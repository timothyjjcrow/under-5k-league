// Pure selection for the /admin "Tonight" card: the fixtures an admin works on
// match night, so their result controls are one tap from the top of the page
// instead of thousands of pixels down Schedule & results.

import { AUTO_SYNC, MATCH_STATUS, SEASON_STATUS } from "./constants";
import {
  expectedSideSize,
  matchNightRoster,
  teamAvailability,
  type AvailabilityRow,
  type StandinLike,
} from "./availability";

const HOUR_MS = 3600_000;

/** How far ahead an upcoming kickoff counts as tonight's. */
export const TONIGHT_AHEAD_HOURS = 12;
/** How long a finished match stays on the card after its kickoff. */
export const TONIGHT_FINISHED_HOURS = 12;

type NightMatch = { id: string; status: string; scheduledAt: Date | null };

/**
 * Tonight's fixtures in kickoff order: every LIVE series, every open match
 * that kicks off within TONIGHT_AHEAD_HOURS or kicked off inside the automatic
 * result window (still waiting on a result), and matches that finished after
 * kicking off in the last TONIGHT_FINISHED_HOURS, so the admin sees a result
 * land. Only the Regular season and Playoffs have a match night. A match with
 * no kickoff time is left to Needs attention, which already flags it.
 */
export function matchNightSlate<M extends NightMatch>(
  seasonStatus: string,
  matches: readonly M[],
  nowMs: number,
): M[] {
  if (
    seasonStatus !== SEASON_STATUS.REGULAR_SEASON &&
    seasonStatus !== SEASON_STATUS.PLAYOFFS
  ) {
    return [];
  }
  const tonight = matches.filter((match) => {
    if (match.status === MATCH_STATUS.LIVE) return true;
    if (!match.scheduledAt) return false;
    const kickoff = match.scheduledAt.getTime();
    if (match.status === MATCH_STATUS.COMPLETED) {
      return (
        kickoff <= nowMs && kickoff >= nowMs - TONIGHT_FINISHED_HOURS * HOUR_MS
      );
    }
    return (
      kickoff <= nowMs + TONIGHT_AHEAD_HOURS * HOUR_MS &&
      kickoff >= nowMs - AUTO_SYNC.WINDOW_HOURS * HOUR_MS
    );
  });
  return tonight.sort(
    (a, b) =>
      (a.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY) -
        (b.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export type NightSide = {
  /** Players on the match-night roster who checked in. */
  confirmed: number;
  /** Players who will play (standins included) and said they can't. */
  out: number;
  /** The count check-ins are shown out of (never below the side size). */
  expected: number;
  /** Standins booked for this side on this match. */
  standins: number;
};

/**
 * One side's check-ins for the card, on the same standin-aware roster the
 * schedule and the week reminder use: a covered player's old "out" is not a
 * gap any more, and the standin's own answer is the one that counts.
 */
export function matchNightSide(
  roster: string[],
  teamId: string,
  standins: readonly (StandinLike & { teamId: string })[],
  rsvps: AvailabilityRow[],
  teamSize: number,
): NightSide {
  const covers = standins.filter((cover) => cover.teamId === teamId);
  const side = matchNightRoster(roster, covers);
  const summary = teamAvailability(side, rsvps);
  return {
    confirmed: summary.confirmed,
    out: summary.out,
    expected: expectedSideSize(teamSize, side.length),
    standins: covers.length,
  };
}

/** "3/5 checked in · 1 out · 1 standin" — the out and standin parts only when non-zero. */
export function nightSideLabel(side: NightSide): string {
  return [
    `${side.confirmed}/${side.expected} checked in`,
    ...(side.out > 0 ? [`${side.out} out`] : []),
    ...(side.standins > 0
      ? [`${side.standins} standin${side.standins === 1 ? "" : "s"}`]
      : []),
  ].join(" · ");
}
