import { formatMatchTime } from "@/lib/match-time";

/**
 * A kickoff as Home prints it, or null. Delegates to formatMatchTime: these
 * strings are LocalTime hydration snapshots, so drifting from the client's
 * formatter causes flicker.
 */
export function fmtWhen(d: Date | null): string | null {
  return d ? formatMatchTime(d, "full") : null;
}
