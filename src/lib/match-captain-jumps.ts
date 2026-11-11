// Pure: which shortcuts a captain gets in the match page's scoreboard.

import { matchLogisticsOpen, standinAssignmentOpen } from "./league-lifecycle";
import { MATCH_ANCHOR } from "./match-anchors";

/**
 * From this long before kickoff the night is on: hosting the lobby and
 * reporting the result lead, and finding cover or moving the time follow.
 */
export const MATCH_NIGHT_LEAD_MS = 3 * 60 * 60 * 1000;

export type CaptainJump = {
  anchor: (typeof MATCH_ANCHOR)[keyof typeof MATCH_ANCHOR];
  label: string;
  /** One jump at most is "primary": the thing the clock says comes next. */
  variant: "primary" | "secondary";
};

/**
 * The captain's jumps under the score, in order. Captain tools sit below the
 * preview and every box score, so these are how a captain learns the page
 * can find a standin or move the match at all.
 *
 * Days out, nothing is due: "Find a standin" and "Change the time" lead and
 * lobby setup follows, none of them primary. From `MATCH_NIGHT_LEAD_MS`
 * before kickoff (and once a game is in) lobby setup and reporting are the
 * primary jump. Each jump shows only while its card would take the action:
 * `standinsOpen` and `rescheduleOpen` are the cards' own gates
 * (`standinAssignmentOpen`, `matchLogisticsOpen`), so a jump never lands on a
 * card that isn't there.
 */
export function captainJumps(opts: {
  /** matchResultsOpen: results can be recorded for this fixture now. */
  resultsOpen: boolean;
  /** The series is LIVE or has a game in. */
  seriesStarted: boolean;
  kickoffMs: number | null;
  nowMs: number;
  standinsOpen: boolean;
  rescheduleOpen: boolean;
}): CaptainJump[] {
  const matchNight =
    opts.seriesStarted ||
    (opts.kickoffMs != null && opts.nowMs >= opts.kickoffMs - MATCH_NIGHT_LEAD_MS);
  const report: CaptainJump = !opts.resultsOpen
    ? { anchor: MATCH_ANCHOR.tools, label: "Captain tools", variant: "secondary" }
    : {
        anchor: MATCH_ANCHOR.report,
        label: opts.seriesStarted ? "Record next game" : "Set up & report",
        variant: matchNight ? "primary" : "secondary",
      };
  const logistics: CaptainJump[] = [
    ...(opts.standinsOpen
      ? [
          {
            anchor: MATCH_ANCHOR.standins,
            label: "Find a standin",
            variant: "secondary" as const,
          },
        ]
      : []),
    ...(opts.rescheduleOpen
      ? [
          {
            anchor: MATCH_ANCHOR.reschedule,
            label: "Change the time",
            variant: "secondary" as const,
          },
        ]
      : []),
  ];
  return matchNight ? [report, ...logistics] : [...logistics, report];
}

/**
 * Whether the captain's Standins and Reschedule cards would take a booking
 * or a proposal now: the cards' own gates, read once for the jumps.
 */
export function captainCardsOpen(
  match: { status: string; season: { isActive: boolean; status: string } },
  draftStatus: string | null | undefined,
): { standinsOpen: boolean; rescheduleOpen: boolean } {
  const { season } = match;
  return {
    standinsOpen:
      season.isActive &&
      standinAssignmentOpen(season.status, draftStatus, match.status),
    rescheduleOpen:
      season.isActive &&
      matchLogisticsOpen(season.status, draftStatus, match.status),
  };
}
