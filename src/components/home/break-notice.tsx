// Home's line in the week before a break (a league night with no games,
// season-breaks.ts): which night is off and when the league is back, on the
// viewer's clock. Renders nothing the rest of the time.

import Link from "@/components/app-link";
import { LocalTime } from "@/components/local-time";
import { textLink } from "@/components/ui";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { upcomingBreak } from "@/lib/season-breaks";

export function BreakNotice({
  firstMatchNight,
  breaks,
  kickoffs,
  lastRound,
  tiebreakerRound,
  nowMs,
}: {
  firstMatchNight: Date | null;
  breaks: readonly string[];
  /** Kickoffs of the season's scheduled fixtures. */
  kickoffs: readonly Date[];
  /** The season plan's last round, for rounds not built yet. */
  lastRound: number;
  /** The reserved tiebreaker week, never where the league is "back". */
  tiebreakerRound: number;
  nowMs: number;
}) {
  const next = upcomingBreak({
    firstMatchNight,
    breaks,
    kickoffs,
    lastRound,
    tiebreakerRound,
    nowMs,
  });
  if (!next) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-info/30 bg-info/10 px-4 py-3 text-sm"
    >
      <p className="font-medium text-fg">
        League break: no games on{" "}
        <LocalTime
          ts={next.night.getTime()}
          variant="date"
          initial={formatLeagueMatchTime(next.night, "date")}
        />
        .
      </p>
      <p className="mt-0.5 text-xs text-muted">
        The league is back{" "}
        <LocalTime
          ts={next.resumesAt.getTime()}
          variant="full"
          initial={formatLeagueMatchTime(next.resumesAt, "full")}
        />
        .{" "}
        <Link href="/schedule" className={textLink()}>
          Season plan
        </Link>
      </p>
    </div>
  );
}
