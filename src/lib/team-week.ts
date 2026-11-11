// The team page's "Match prep" card, pure: what the team's own people are
// told about their next series (check-ins, cover, a pending time change) and
// which match-page card each line opens. The match page has the controls;
// this card says what is waiting there, so a captain doesn't have to open the
// match and scroll to learn anything is.

import type { CheckinRole, CheckinSideCounts } from "./checkin-side";
import { MATCH_ANCHOR } from "./match-anchors";

export type TeamWeekNote = {
  key: string;
  /** "danger": a seat has nobody; "accent": an answer is owed; "muted": a fact. */
  tone: "danger" | "accent" | "muted";
  text: string;
  /** The match-page card that deals with it; null for a plain fact. */
  link: {
    anchor: (typeof MATCH_ANCHOR)[keyof typeof MATCH_ANCHOR];
    label: string;
  } | null;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The card's lines, most urgent first. Only the captain gets the lines that
 * ask for something only a captain can do (cover, a standin request); every
 * teammate sees who is standing in and that a new time is on the table, since
 * each of them answers the ready check.
 */
export function teamWeekNotes(input: {
  role: CheckinRole;
  counts: CheckinSideCounts;
  /**
   * Who is out with no cover, when the viewer may see named answers (the
   * card then lists every name itself); null when they may not.
   */
  outNames: readonly string[] | null;
  /** The Standins card would take a booking (`captainCardsOpen`). */
  standinsOpen: boolean;
  /** This team's standin bookings for the match. */
  bookings: readonly { standinName: string; replacingName: string | null }[];
  /** Standin requests waiting for a captain's OK: this team's asks and the other team's. */
  requests: { mine: number; theirs: number };
  otherTeamName: string;
  /** An open ready check with a time still ahead; null when there is none. */
  readyCheck: { mine: boolean; options: number } | null;
}): TeamWeekNote[] {
  const { counts, requests, readyCheck } = input;
  const captain = input.role === "captain";
  const notes: TeamWeekNote[] = [];
  const cover = input.standinsOpen
    ? { anchor: MATCH_ANCHOR.standins, label: "Find a standin" }
    : null;

  if (captain && counts.out > 0) {
    const who =
      input.outNames && input.outNames.length > 0
        ? input.outNames.join(", ")
        : plural(counts.out, "player");
    notes.push({
      key: "out",
      tone: "danger",
      text: `${who} can't make it and ${counts.out === 1 ? "has" : "have"} no cover yet.`,
      link: cover,
    });
  }
  if (captain && counts.openSeats > 0) {
    notes.push({
      key: "open-seats",
      tone: "danger",
      text: `${plural(counts.openSeats, "open seat")} with nobody lined up.`,
      link: cover,
    });
  }
  if (captain && requests.theirs > 0) {
    notes.push({
      key: "requests-theirs",
      tone: "accent",
      text: `The ${input.otherTeamName} captain wants ${
        requests.theirs === 1 ? "a standin" : `${requests.theirs} standins`
      } and needs your OK.`,
      link: { anchor: MATCH_ANCHOR.standins, label: "Answer the request" },
    });
  }
  if (readyCheck) {
    const times =
      readyCheck.options === 1 ? "a new time" : `${readyCheck.options} new times`;
    notes.push(
      captain && readyCheck.mine
        ? {
            key: "ready-check",
            tone: "accent",
            text: `Your ready check is open: you offered ${times}.`,
            link: { anchor: MATCH_ANCHOR.reschedule, label: "See the answers" },
          }
        : {
            key: "ready-check",
            tone: "accent",
            text: `A captain offered ${times} for this match.`,
            link: {
              anchor: MATCH_ANCHOR.reschedule,
              label: "Answer the ready check",
            },
          },
    );
  }
  if (captain && requests.mine > 0) {
    notes.push({
      key: "requests-mine",
      tone: "accent",
      text: `Waiting on the ${input.otherTeamName} captain's OK for ${
        requests.mine === 1 ? "your standin" : `${requests.mine} standins`
      }.`,
      link: { anchor: MATCH_ANCHOR.standins, label: "See the request" },
    });
  }
  // A viewer who gets names already reads the cover in the card's Covered
  // row and "(standin)" tags; everyone else gets it as one line.
  if (input.outNames === null && input.bookings.length > 0) {
    notes.push({
      key: "bookings",
      tone: "muted",
      text: `Standing in: ${input.bookings
        .map((b) =>
          b.replacingName
            ? `${b.standinName} for ${b.replacingName}`
            : `${b.standinName} in an open seat`,
        )
        .join("; ")}.`,
      link: null,
    });
  }
  return notes;
}
