// What Home's personal panel (the hero's control slot, mid-season) says to a
// signed-in league member: the match they check in for, their series being
// played right now, a fixture a standin covers for them, and otherwise which
// of a few plain states they are in. Pure so every state is tested; the page
// only draws what this returns.

import { AUTO_SYNC, MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "./constants";
import { byKickoff } from "./schedule";

export type PanelMatch = {
  id: string;
  status: string;
  phase: string;
  week: number;
  homeTeamId: string;
  awayTeamId: string;
  scheduledAt: Date | null;
  createdAt: Date;
  winnerTeamId: string | null;
};

/** A standin booking that names the viewer, as standin or as the covered player. */
export type PanelBooking = {
  matchId: string;
  teamId: string;
  standinUserId: string;
  replacingUserId: string | null;
};

/**
 * What to say when there is nothing to check in for:
 * - `no-fixtures`: on a team whose fixtures aren't published yet
 * - `games-played`: every regular-season fixture of the team is final
 * - `no-upcoming`: the team's next fixture has no kickoff time yet, or its
 *   result is overdue
 * - `bracket-pending`: playoffs, but the bracket isn't drawn yet
 * - `through`: won their round; the next one isn't drawn yet
 * - `champion`: won the final
 * - `season-over`: missed the playoffs or knocked out
 * - `withdrawn`: every team they are on has withdrawn
 * - `standin-list`: registered as a standin, no booking coming up
 * - `no-team`: none of the above (an undrafted player, a removed signup)
 */
export type PanelIdle =
  | "no-fixtures"
  | "games-played"
  | "no-upcoming"
  | "bracket-pending"
  | "through"
  | "champion"
  | "season-over"
  | "withdrawn"
  | "standin-list"
  | "no-team";

export type MyMatchPanel<M extends PanelMatch, B extends PanelBooking> = {
  /** The fixture the check-in answers for: timed, not yet started, not stale. */
  next: M | null;
  /** The viewer's series being played now. Not a check-in: a link to it. */
  live: { match: M; teamId: string } | null;
  /** The earliest open fixture where a standin has the viewer's seat, when it
   *  comes before `next` (or there is no `next`). */
  covered: { match: M; booking: B } | null;
  idle: PanelIdle;
  /** The roster the idle state speaks for (not withdrawn), if any. */
  teamId: string | null;
};

export function myMatchPanel<
  M extends PanelMatch,
  B extends PanelBooking,
>(input: {
  userId: string;
  seasonStatus: string;
  /** Teams the viewer is rostered on this season, withdrawn ones included. */
  rosterTeamIds: readonly string[];
  withdrawnTeamIds: ReadonlySet<string>;
  /** An ACTIVE standin registration. */
  standin: boolean;
  matches: readonly M[];
  bookings: readonly B[];
  nowMs: number;
}): MyMatchPanel<M, B> {
  const { userId, rosterTeamIds, bookings } = input;
  // A check-in answers for an exact future match night: untimed fixtures and
  // ones past the result-sync window (results debt) never become the prompt.
  const freshFrom = input.nowMs - AUTO_SYNC.WINDOW_HOURS * 3600_000;
  const open = input.matches
    .filter(
      (m) =>
        m.status === MATCH_STATUS.LIVE ||
        (m.status === MATCH_STATUS.SCHEDULED &&
          m.scheduledAt != null &&
          m.scheduledAt.getTime() >= freshFrom),
    )
    // Chronological, not week order: an accepted reschedule can move a match
    // past the next week's night.
    .sort(byKickoff);

  let next: M | null = null;
  let live: MyMatchPanel<M, B>["live"] = null;
  let covered: MyMatchPanel<M, B>["covered"] = null;
  for (const m of open) {
    const onMatch = bookings.filter((b) => b.matchId === m.id);
    // A booked standin plays for the side that booked them.
    const asStandin = onMatch.find((b) => b.standinUserId === userId);
    const rosterTeamId = rosterTeamIds.find(
      (id) => id === m.homeTeamId || id === m.awayTeamId,
    );
    const teamId = asStandin?.teamId ?? rosterTeamId;
    if (!teamId) continue;
    // A named standin replaces the roster seat for this match: the covered
    // player's RSVP counts for nothing, so they get a note, not a prompt.
    const cover = asStandin
      ? undefined
      : onMatch.find(
          (b) => b.teamId === rosterTeamId && b.replacingUserId === userId,
        );
    if (cover) {
      if (!covered && !next) covered = { match: m, booking: cover };
      continue;
    }
    if (m.status === MATCH_STATUS.LIVE) {
      if (!live) live = { match: m, teamId };
      continue;
    }
    if (!next) next = m;
  }

  const activeTeamId =
    rosterTeamIds.find((id) => !input.withdrawnTeamIds.has(id)) ?? null;
  return {
    next,
    live,
    covered,
    idle: idleState(input, activeTeamId),
    teamId: activeTeamId,
  };
}

function idleState(
  input: {
    seasonStatus: string;
    rosterTeamIds: readonly string[];
    standin: boolean;
    matches: readonly PanelMatch[];
  },
  teamId: string | null,
): PanelIdle {
  if (input.rosterTeamIds.length === 0)
    return input.standin ? "standin-list" : "no-team";
  if (!teamId) return "withdrawn";
  const plays = (m: PanelMatch) =>
    m.homeTeamId === teamId || m.awayTeamId === teamId;
  if (input.seasonStatus === SEASON_STATUS.PLAYOFFS) {
    const bracket = input.matches.filter(
      (m) => m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL,
    );
    if (bracket.length === 0) return "bracket-pending";
    const decided = bracket.filter(
      (m) => plays(m) && m.status === MATCH_STATUS.COMPLETED && m.winnerTeamId,
    );
    if (decided.some((m) => m.phase === MATCH_PHASE.FINAL && m.winnerTeamId === teamId))
      return "champion";
    if (!bracket.some(plays) || decided.some((m) => m.winnerTeamId !== teamId))
      return "season-over";
    return bracket.some((m) => plays(m) && m.status !== MATCH_STATUS.COMPLETED)
      ? "no-upcoming"
      : "through";
  }
  const own = input.matches.filter(plays);
  if (own.length === 0) return "no-fixtures";
  return own.every((m) => m.status === MATCH_STATUS.COMPLETED)
    ? "games-played"
    : "no-upcoming";
}
