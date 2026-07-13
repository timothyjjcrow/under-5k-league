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
