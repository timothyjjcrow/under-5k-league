import { leagueProgress } from "@/lib/league-progress";

export function RegularSeasonProgress({
  progress,
}: {
  progress: ReturnType<typeof leagueProgress>;
}) {
  if (!progress.total) return null;
  const heading =
    progress.focusWeek != null
      ? `Week ${progress.focusWeek} of ${progress.totalWeeks} weeks`
      : progress.completed === progress.total
        ? "Regular-season results are complete"
        : "Waiting for remaining results";
  return (
    <div
      className="w-full space-y-3 text-left"
      aria-label="Regular season progress"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <p className="font-semibold text-fg">{heading}</p>
        <p className="text-muted">
          <span className="font-semibold tabular-nums text-fg">
            {progress.completed} of {progress.total}
          </span>{" "}
          series complete
        </p>
      </div>
      <div
        role="progressbar"
        aria-label="Regular-season series complete"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.completed}
        className="h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className="h-full rounded-full bg-info"
          style={{ width: `${(progress.completed / progress.total) * 100}%` }}
        />
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {progress.live > 0 ? (
          <li className="font-medium text-danger">{progress.live} live now</li>
        ) : null}
        {progress.scheduled > 0 ? (
          <li>{progress.scheduled} scheduled · not final</li>
        ) : null}
        {progress.untimed > 0 ? (
          <li>{progress.untimed} awaiting a kickoff time</li>
        ) : null}
        {progress.awaiting.length > 0 ? (
          <li className="text-accent">
            {progress.awaiting.length} overdue result
            {progress.awaiting.length === 1 ? "" : "s"}
          </li>
        ) : null}
        {progress.completed === progress.total ? (
          <li>All published regular-season series have a recorded result.</li>
        ) : null}
      </ul>
    </div>
  );
}
