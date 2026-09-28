import { cn } from "@/lib/utils";

/**
 * "Week 1: bye." The line a team resting this week leads with, wherever its
 * next match is shown (the dashboard's check-in panel, the team page and
 * /schedule), so its players aren't left wondering why that match is a week
 * away while everyone else checks in. The week comes from `teamByeWeek`.
 */
export function ByeWeekNote({
  week,
  who,
  next,
  className,
}: {
  week: number;
  /** Who is resting: "Your team" or the team's name. */
  who: string;
  /** Where the team plays next, e.g. "Week 2 vs Team 5". */
  next?: string | null;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-3 rounded-[var(--radius)] border border-line bg-surface-2/40 px-4 py-3 text-sm",
        className,
      )}
    >
      <span className="shrink-0 rounded bg-surface-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
        Bye
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-medium">Week {week}: bye.</span>{" "}
        <span className="text-muted">
          {who} has the week off.
          {next ? ` Next up: ${next}.` : ""}
        </span>
      </span>
    </p>
  );
}
