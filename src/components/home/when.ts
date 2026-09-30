import { formatLeagueMatchTime } from "@/lib/match-time";

/**
 * A kickoff as Home prints it, or null. Delegates to formatLeagueMatchTime:
 * these strings are LocalTime hydration snapshots, the league's clock with its
 * zone named until the viewer's own clock takes over.
 */
export function fmtWhen(d: Date | null): string | null {
  return d ? formatLeagueMatchTime(d, "full") : null;
}
