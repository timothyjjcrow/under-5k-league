"use client";

// Renders a match time in the *viewer's* timezone. The server passes its own
// formatted string as the initial text (identical in dev, UTC in production);
// after mount we reformat from the timestamp with the browser's locale and
// timezone, so players always see their local match night.

import { useSyncExternalStore } from "react";
import { formatMatchTime, type TimeVariant } from "@/lib/match-time";

const emptySubscribe = () => () => {};

/**
 * The string form of the trick, for places that need viewer-local time inside
 * attributes (title/aria-label) rather than as an element. Server snapshot =
 * the server-formatted string; client snapshot = the same instant in the
 * browser's timezone. Hydration-safe by construction.
 */
export function useLocalTimeText(
  ts: number,
  variant: TimeVariant,
  initial: string,
): string {
  return useSyncExternalStore(
    emptySubscribe,
    () => formatMatchTime(new Date(ts), variant),
    () => initial,
  );
}

export function LocalTime({
  ts,
  variant,
  initial,
  className,
}: {
  ts: number;
  variant: TimeVariant;
  /** Server-formatted fallback shown until the client clock takes over. */
  initial: string;
  className?: string;
}) {
  const text = useLocalTimeText(ts, variant, initial);
  return (
    <time dateTime={new Date(ts).toISOString()} className={className}>
      {text}
    </time>
  );
}
