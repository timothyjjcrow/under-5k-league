// Match-time display formats, shared by server fallbacks and the LocalTime
// client component so dev (same TZ) renders identically on both sides.

export type TimeVariant = "full" | "short";

/** "Sat, Jul 12, 6:00 PM" (full) or "Jul 12, 6:00 PM" (short, phone width). */
export function formatMatchTime(d: Date, variant: TimeVariant): string {
  return d.toLocaleString(undefined, {
    ...(variant === "full" ? { weekday: "short" as const } : {}),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
