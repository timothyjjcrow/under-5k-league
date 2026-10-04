// Match-time display formats, shared by server fallbacks and the LocalTime
// client component so dev (same TZ) renders identically on both sides.

export type TimeVariant = "full" | "short" | "date";

/**
 * "Sat, Jul 12, 6:00 PM" (full), "Jul 12, 6:00 PM" (short, phone width), or
 * "Sat, Jul 12" (date — week headers, no time of day).
 */
export function formatMatchTime(d: Date, variant: TimeVariant): string {
  if (variant === "date") {
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleString(undefined, {
    ...(variant === "full" ? { weekday: "short" as const } : {}),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A kickoff split for a compact time chip: "Sat", "Oct 10", "8:00 PM", in the
 * running environment's locale and zone (a client chip passes the server's
 * parts as its hydration snapshot, like LocalTime).
 */
export function matchTimeParts(d: Date): {
  day: string;
  date: string;
  time: string;
} {
  return {
    day: d.toLocaleDateString(undefined, { weekday: "short" }),
    date: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}
