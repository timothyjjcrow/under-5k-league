// What is waiting on a team's captain in one match, as data.
//
// The match page's "Waiting on you" list, Home's captain line and Captain's
// Quarters all read this one function, so the three can never disagree about
// what a captain owes. Each item uses the same capability gate as the card
// that answers it, so no surface points at a card that isn't there.
//
// Pure on purpose (no React, no Prisma): the service gathers the facts, this
// decides, the components render.

import { MATCH_STATUS } from "./constants";
import { matchLogisticsOpen, standinAssignmentOpen } from "./league-lifecycle";
import {
  lockOffered,
  readyCheckLive,
  type ReadyCheckView,
} from "./reschedule-ready-check";
import { coverChoices } from "./standin";
import { standinHubPath } from "./standin-offer";

export type CaptainTodo =
  /**
   * Seats with nobody lined up: players on the roster who said they can't
   * make it and have no cover, and empty roster seats; with how many
   * standins said they can play for this side.
   */
  | { kind: "uncovered"; names: string[]; emptySeats: number; offers: number }
  /** The other captain's standin request (over the MMR allowance). */
  | {
      kind: "standin-request";
      requesterName: string;
      standinName: string;
      count: number;
    }
  /** The other captain's ready check, with no yes from this captain yet. */
  | { kind: "answer-ready-check"; proposerName: string; times: number[] }
  /** This captain's own ready check, with a time the other captain said yes to. */
  | { kind: "lock-in"; timeMs: number; readyTotal: number; seatTotal: number };

export type CaptainTodoKind = CaptainTodo["kind"];

/**
 * Where each kind is answered: standin work on the Standins page (the one
 * place every standin control lives), a time change on the match's
 * Reschedule card.
 */
export const CAPTAIN_TODO_CARD: Record<CaptainTodoKind, "standins" | "reschedule"> = {
  uncovered: "standins",
  "standin-request": "standins",
  "answer-ready-check": "reschedule",
  "lock-in": "reschedule",
};

/**
 * A to-do's link: the game on the Standins page for standin work, else the
 * Reschedule card at `rescheduleHref` (an in-page `#anchor` where the card
 * is on the same page, the match page's otherwise).
 */
export function captainTodoHref(
  kind: CaptainTodoKind,
  matchId: string,
  rescheduleHref: string,
): string {
  return CAPTAIN_TODO_CARD[kind] === "standins"
    ? standinHubPath(matchId)
    : rescheduleHref;
}

export type CaptainTodoInput = {
  myTeamId: string;
  seasonStatus: string;
  draftStatus: string | null | undefined;
  match: {
    status: string;
    /** The players this match's standin bookings cover. */
    coveredUserIds: readonly string[];
    /** Pending standin requests, both teams'. */
    standinRequests: readonly {
      teamId: string;
      /** The seat the request would cover; null for an empty seat. */
      replacingUserId: string | null;
      requestedByName: string;
      standinName: string;
    }[];
  };
  /** The captain's own roster, in signing order. */
  roster: readonly { userId: string; name: string }[];
  /**
   * The board's need for this captain's side (`loadSideNeeds`): its empty
   * roster seats with no booking or request, and how many standins said
   * they can play. Null when the side needs nobody.
   */
  cover: { emptySeats: number; offers: number } | null;
  /** This schedule revision's OUT check-ins. */
  outUserIds: ReadonlySet<string>;
  /** The open ready check as this captain sees it, or null. */
  readyCheck: ReadyCheckView | null;
};

export function captainTodos(input: CaptainTodoInput): CaptainTodo[] {
  const { match, myTeamId } = input;
  const todos: CaptainTodo[] = [];
  const assignOpen = standinAssignmentOpen(
    input.seasonStatus,
    input.draftStatus,
    match.status,
  );
  // A player whose cover is waiting for the other captain's OK isn't
  // uncovered: the Standins card shows that request instead.
  if (assignOpen) {
    const covered = new Set([
      ...match.coveredUserIds,
      ...match.standinRequests.flatMap((r) =>
        r.replacingUserId ? [r.replacingUserId] : [],
      ),
    ]);
    const names = coverChoices(input.roster, input.outUserIds, covered)
      .choices.filter((c) => c.out)
      .map((c) => c.member.name);
    // An empty seat is a need too: the Standins page lists the game for it,
    // so its captain must hear it here.
    const emptySeats = input.cover?.emptySeats ?? 0;
    if (names.length > 0 || emptySeats > 0) {
      todos.push({
        kind: "uncovered",
        names,
        emptySeats,
        offers: input.cover?.offers ?? 0,
      });
    }
  }
  // The other team's requests: this captain's OK books them. Agree shows only
  // where a booking would be accepted, as on the Standins card.
  const toAnswer =
    assignOpen && match.status !== MATCH_STATUS.COMPLETED
      ? match.standinRequests.filter((r) => r.teamId !== myTeamId)
      : [];
  if (toAnswer.length > 0) {
    todos.push({
      kind: "standin-request",
      requesterName: toAnswer[0].requestedByName,
      standinName: toAnswer[0].standinName,
      count: toAnswer.length,
    });
  }
  const open =
    input.readyCheck &&
    readyCheckLive(input.readyCheck) &&
    matchLogisticsOpen(input.seasonStatus, input.draftStatus, match.status)
      ? input.readyCheck
      : null;
  // The other captain's ready check, and this captain hasn't said yes to any
  // of its live times yet.
  if (
    open &&
    !open.viewer.isProposer &&
    !open.options.some((o) => !o.passed && o.myAnswer === "ready")
  ) {
    todos.push({
      kind: "answer-ready-check",
      proposerName: open.proposer.name,
      times: open.options.filter((o) => !o.passed).map((o) => o.timeMs),
    });
  }
  // This captain's own ready check, where the other captain has said yes to
  // a time that isn't locked in yet: one tap moves the match.
  const lockable = open?.viewer.isProposer
    ? (open.options.find(lockOffered) ?? null)
    : null;
  if (lockable) {
    todos.push({
      kind: "lock-in",
      timeMs: lockable.timeMs,
      readyTotal: lockable.readyTotal,
      seatTotal: lockable.seatTotal,
    });
  }
  return todos;
}

/** "1 thing needs you" / "3 things need you". */
export function captainTodoCountLine(count: number): string {
  return count === 1 ? "1 thing needs you" : `${count} things need you`;
}
