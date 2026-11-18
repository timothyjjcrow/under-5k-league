import type { ReactNode } from "react";
import Link from "@/components/app-link";
import { LocalTime } from "@/components/local-time";
import { textLink } from "@/components/ui";
import type { CaptainTodo } from "@/lib/captain-todos";
import { formatLeagueMatchTime } from "@/lib/match-time";

const ACTION: Record<CaptainTodo["kind"], string> = {
  uncovered: "Find a standin",
  "standin-request": "Answer the standin request",
  "answer-ready-check": "Answer the ready check",
  "lock-in": "Lock it in",
};

/** The link's words: "Pick a standin" once someone said they can play. */
function actionLabel(todo: CaptainTodo): string {
  return todo.kind === "uncovered" && todo.offers > 0
    ? "Pick a standin"
    : ACTION[todo.kind];
}

function When({ ts }: { ts: number }) {
  return (
    <strong>
      <LocalTime
        ts={ts}
        variant="full"
        initial={formatLeagueMatchTime(new Date(ts), "full")}
      />
    </strong>
  );
}

/**
 * One line of a captain's to-do list (`captainTodos`), linking to the card
 * that answers it. The match page links within the page (`#anchor`, "↓");
 * Home and the Captains page link elsewhere and name the match in
 * `context`.
 */
export function CaptainTodoItem({
  todo,
  href,
  context,
}: {
  todo: CaptainTodo;
  /** `#anchor` on the match page, `/matches/<id>#anchor` elsewhere. */
  href: string;
  /** Which match this is about, shown first (off the match page). */
  context?: ReactNode;
}) {
  const inPage = href.startsWith("#");
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="min-w-[12rem] flex-1 [overflow-wrap:anywhere]">
        {context ? (
          <span className="mr-1.5 font-semibold text-fg">{context}</span>
        ) : null}
        <TodoText todo={todo} />
      </span>
      {inPage ? (
        <a href={href} className={textLink("shrink-0 font-medium")}>
          {actionLabel(todo)} <span aria-hidden>↓</span>
        </a>
      ) : (
        <Link href={href} className={textLink("shrink-0 font-medium")}>
          {actionLabel(todo)} <span aria-hidden>→</span>
        </Link>
      )}
    </li>
  );
}

function TodoText({ todo }: { todo: CaptainTodo }) {
  switch (todo.kind) {
    case "uncovered":
      return (
        <>
          <span aria-hidden>✗ </span>
          {todo.names.length > 0 ? (
            <>
              <strong>{todo.names.join(", ")}</strong>{" "}
              {todo.names.length === 1
                ? "can't make it and has no cover yet."
                : "can't make it and have no cover yet."}
            </>
          ) : null}
          {todo.emptySeats > 0 ? (
            <>
              {todo.names.length > 0 ? " " : ""}
              {emptySeatLine(todo.emptySeats)}
            </>
          ) : null}
          {todo.offers > 0 ? (
            <>
              {" "}
              <strong>{offersLine(todo.offers)}</strong>
            </>
          ) : null}
        </>
      );
    case "standin-request":
      return (
        <>
          <span aria-hidden>⏳ </span>
          <strong>{todo.requesterName}</strong> wants{" "}
          {todo.count === 1 ? (
            <>
              <strong>{todo.standinName}</strong> to stand in and needs your
              OK.
            </>
          ) : (
            `${todo.count} standins and needs your OK.`
          )}
        </>
      );
    case "answer-ready-check":
      return (
        <>
          <span aria-hidden>⏳ </span>
          <strong>{todo.proposerName}</strong> wants to move this match
          {todo.times.length === 1 ? (
            <>
              {" "}to <When ts={todo.times[0]} />.
            </>
          ) : (
            ` and offered ${todo.times.length} times.`
          )}
        </>
      );
    case "lock-in":
      return (
        <>
          <span aria-hidden>✓ </span>
          The other captain said yes to <When ts={todo.timeMs} />{" "}
          ({todo.readyTotal}/{todo.seatTotal} ready).
        </>
      );
  }
}

/** "1 empty roster seat has nobody lined up." */
function emptySeatLine(seats: number): string {
  return seats === 1
    ? "1 empty roster seat has nobody lined up."
    : `${seats} empty roster seats have nobody lined up.`;
}

/** "1 standin said they can play." */
function offersLine(offers: number): string {
  return offers === 1
    ? "1 standin said they can play."
    : `${offers} standins said they can play.`;
}
