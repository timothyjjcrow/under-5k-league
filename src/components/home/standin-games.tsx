import type { ReactNode } from "react";
import Link from "@/components/app-link";
import { LocalTime } from "@/components/local-time";
import { LinkArrow, buttonClasses } from "@/components/ui";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { standinNeedLabel } from "@/lib/standin-offer";
import { loadStandinBoardSummary } from "@/lib/standin-offer-service";

/**
 * The first thing a visitor with no team and no signup sees while a season
 * is running (Tim, 2026-11-15): the games that need a standin, and the one
 * button to them. It leads the hero's actions, above sign-in and the inhouse
 * queue, because a game short a player tonight is the fastest way into the
 * league. With no game needing anyone it renders `whenNone` (nothing by
 * default), so the hero then reads exactly as it did.
 *
 * The count is the cached summary (half a minute, per process): this renders
 * for every signed-out view of Home.
 */
export async function StandinGamesCallout({
  season,
  whenNone = null,
}: {
  season: { id: string; status: string; teamSize: number };
  /**
   * What takes its place when no game needs anyone: the plain "Register as
   * a standin" button, where the callout's own button would otherwise sit
   * beside it and compete.
   */
  whenNone?: ReactNode;
}) {
  // Async server component: Date.now is request-time state, not render replay.
  // eslint-disable-next-line react-hooks/purity
  const { count, first } = await loadStandinBoardSummary(season, Date.now());
  if (count === 0 || !first) return whenNone;
  return (
    <div
      data-testid="standin-games-callout"
      className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius)] border border-accent/50 bg-accent/10 px-4 py-3"
    >
      <p className="min-w-[12rem] flex-1 text-sm [overflow-wrap:anywhere]">
        <strong className="block text-base">
          {count === 1
            ? "A game needs a standin"
            : `${count} games need a standin`}
        </strong>
        <span className="text-muted">
          {first.teamName} {standinNeedLabel(first.seats)} vs{" "}
          {first.opponentName}
          {first.scheduledAt ? (
            <>
              {" · "}
              <LocalTime
                ts={first.scheduledAt.getTime()}
                variant="short"
                initial={formatLeagueMatchTime(first.scheduledAt, "short")}
              />
            </>
          ) : null}
          . Play this week without waiting for next season.
        </span>
      </p>
      <Link href="/standins" className={buttonClasses("accent", "lg")}>
        Play as a standin <LinkArrow />
      </Link>
    </div>
  );
}
