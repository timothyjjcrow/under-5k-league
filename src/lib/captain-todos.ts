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

export type CaptainTodo =
  /** Players on the roster who said they can't make it and have no cover. */
  | { kind: "uncovered"; names: string[] }
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

/** The card on the match page that answers each kind. */
export const CAPTAIN_TODO_CARD: Record<CaptainTodoKind, "standins" | "reschedule"> = {
  uncovered: "standins",
  "standin-request": "standins",
  "answer-ready-check": "reschedule",
  "lock-in": "reschedule",
};

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
    if (names.length > 0) todos.push({ kind: "uncovered", names });
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
