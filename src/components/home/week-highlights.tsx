// Home's upset of the week, and the "Upset" chip on its Recent results rows.
// Props only: SeasonView judges the matches it already loaded (upsets.ts)
// and hands the verdicts down, so neither adds a query to the hottest page.

import Link from "next/link";
import { LinkArrow, textLink } from "@/components/ui";
import { upsetDetail, type SeriesUpset } from "@/lib/upsets";

/**
 * The chip on a Recent results row (nothing when the series was no upset):
 * amber, a highlight, never link blue. Hidden from screen readers, because
 * the row's spoken sentence already opens with "Upset"
 * (`recentResultSpoken`).
 */
export function UpsetChip({ upset }: { upset: SeriesUpset | undefined }) {
  if (!upset) return null;
  return (
    <span
      aria-hidden="true"
      title={`Upset: ${upsetDetail(upset)}`}
      className="whitespace-nowrap rounded bg-accent/10 px-1.5 py-px font-medium text-accent"
    >
      Upset
    </span>
  );
}

/**
 * A Recent results row as a screen reader says it. Whatever comes first, it
 * ends "won the series · Match details" or "Series drawn · Match details".
 */
export function recentResultSpoken(
  winnerName: string | null,
  upset: boolean,
): string {
  const result = winnerName ? `${winnerName} won the series` : "Series drawn";
  return `${upset ? "Upset: " : ""}${result} · Match details`;
}

/**
 * The latest week's biggest upset (`biggestUpset`) as one open line beside
 * the weekly honors: "Week 5 upset · The Couriers beat Roshan's Revenge 2–0,
 * from 6 points behind going into the week". SeasonView renders it only when
 * that week had one.
 */
export function WeekHighlights({
  label,
  match,
  upset,
  teamName,
}: {
  /** The round as the schedule names it: "Week 5", "Semifinal". */
  label: string;
  match: { id: string; homeTeamId: string; homeScore: number; awayScore: number };
  upset: SeriesUpset;
  teamName: Map<string, string>;
}) {
  const [won, lost] =
    upset.winnerId === match.homeTeamId
      ? [match.homeScore, match.awayScore]
      : [match.awayScore, match.homeScore];
  return (
    <section
      aria-labelledby="home-week-upset"
      className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-2 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm"
    >
      <h2 id="home-week-upset" className="text-sm font-semibold">
        {label} upset
      </h2>
      <p className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-medium">
          {teamName.get(upset.winnerId) ?? "?"}
        </span>
        {" beat "}
        <span className="font-medium">
          {teamName.get(upset.loserId) ?? "?"}
        </span>
        {` ${won}–${lost}`}
        <span className="text-muted">{`, ${upsetDetail(upset)}`}</span>
      </p>
      <Link href={`/matches/${match.id}`} className={textLink("text-sm")}>
        Match details <LinkArrow />
      </Link>
    </section>
  );
}
