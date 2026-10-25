// When a post about an upcoming fixture may stay quiet: the rule behind "ping
// on a change, not on the calendar" (Tim's call, 2026-10-24). A routine
// fixture's post still goes to the channel and still names who owes an
// answer, in plain text; only the @-mention goes.

import { MATCH_PHASE } from "./constants";

/**
 * Whether one side's players already know this kickoff, so the week reminder
 * names them without pinging them.
 *
 * A regular-season fixture whose kickoff never moved (`scheduleRevision` 0:
 * Set time, Move a match night and a reschedule lock all bump it) is on the
 * weekly slot the schedule gave it. The exception is the side's FIRST fixture
 * (`sideFirstMatchId`, see firstFixtureBySide): no post before its reminder
 * pings a player about their opponent and kickoff. Tiebreakers and playoff
 * rounds are always news.
 */
export function kickoffIsRoutine(
  match: { id: string; phase: string; scheduleRevision: number },
  sideFirstMatchId: string | undefined,
): boolean {
  return (
    match.phase === MATCH_PHASE.REGULAR &&
    match.scheduleRevision === 0 &&
    sideFirstMatchId !== undefined &&
    match.id !== sideFirstMatchId
  );
}

/**
 * Each team's first regular fixture: its earliest kickoff, then the lowest
 * week and id. Pass every regular fixture that has a kickoff and is not a
 * no-game forfeit. Earliest by kickoff, not week 1, so a team with a week-1
 * bye is told about its first game, and so is one whose week-1 fixture moved
 * past week 2 or was forfeited before anyone played it. A regenerated
 * schedule starts over at its own first fixture.
 */
export function firstFixtureBySide(
  fixtures: {
    id: string;
    week: number;
    scheduledAt: Date;
    homeTeamId: string;
    awayTeamId: string;
  }[],
): Map<string, string> {
  const ordered = [...fixtures].sort(
    (a, b) =>
      a.scheduledAt.getTime() - b.scheduledAt.getTime() ||
      a.week - b.week ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const first = new Map<string, string>();
  for (const f of ordered) {
    for (const teamId of [f.homeTeamId, f.awayTeamId]) {
      if (!first.has(teamId)) first.set(teamId, f.id);
    }
  }
  return first;
}
