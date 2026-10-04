"use client";

import { useSyncExternalStore } from "react";
import { matchTimeParts } from "@/lib/match-time";

export type TimeParts = { day: string; date: string; time: string };

const emptySubscribe = () => () => {};
const SEP = "\u0000";

/**
 * A kickoff's day, date and time in the VIEWER's zone, hydration-safe the
 * way LocalTime is: the server's parts are the server snapshot, the browser
 * reformats after. A string snapshot, so React sees a stable value.
 */
export function useLocalTimeParts(ts: number, initial: TimeParts): TimeParts {
  const joined = useSyncExternalStore(
    emptySubscribe,
    () => {
      const p = matchTimeParts(new Date(ts));
      return [p.day, p.date, p.time].join(SEP);
    },
    () => [initial.day, initial.date, initial.time].join(SEP),
  );
  const [day, date, time] = joined.split(SEP);
  return { day, date, time };
}

/** "Sat · Oct 10" over "8:00 PM", for a chip or an option heading. */
export function TimeStack({
  ts,
  initial,
  size = "md",
}: {
  ts: number;
  initial: TimeParts;
  size?: "md" | "lg";
}) {
  const parts = useLocalTimeParts(ts, initial);
  return (
    <time dateTime={new Date(ts).toISOString()} className="block min-w-0">
      <span className="block text-xs font-medium uppercase tracking-wide text-muted">
        {parts.day} · {parts.date}
      </span>
      <span
        className={
          size === "lg"
            ? "block font-display text-xl font-semibold leading-tight text-fg"
            : "block text-sm font-semibold text-fg"
        }
      >
        {parts.time}
      </span>
    </time>
  );
}
