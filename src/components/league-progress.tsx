import type { leagueProgress } from "@/lib/league-progress";

type Progress = ReturnType<typeof leagueProgress>;

/**
 * The regular season's one progress indicator on Home: "Week 5 of 6", how
 * many series are final, and a bar per week that fills as its results come
 * in. It used to sit beside a percentage ring saying the same thing, under a
 * "Regular season" label the hero's phase badge already shows.
 */
export function RegularSeasonProgress({ progress }: { progress: Progress }) {
  if (!progress.total) return null;
  const complete = progress.completed === progress.total;
  const heading =
    progress.focusWeek != null
      ? `Week ${progress.focusWeek} of ${progress.totalWeeks} weeks`
      : complete
        ? "Regular-season results are complete"
        : "Waiting for remaining results";
  const states = [
    { count: progress.live, label: "Live", text: "text-danger" },
    { count: progress.scheduled, label: "Scheduled", text: "text-fg" },
    { count: progress.untimed, label: "Time TBC", text: "text-violet-300" },
    { count: progress.awaiting.length, label: "Overdue", text: "text-accent" },
  ].filter((state) => state.count > 0);

  return (
    <div className="w-full min-w-0 text-left">
      <p
        className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-fg"
        aria-label={heading}
      >
        {progress.focusWeek != null ? (
          <>
            <span className="font-display text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
              Week {progress.focusWeek}{" "}
            </span>
            <span className="text-xs text-muted">
              of {progress.totalWeeks} weeks
            </span>
          </>
        ) : (
          <span className="font-display text-2xl font-semibold leading-tight sm:text-3xl">
            {complete ? "Results complete" : "Results pending"}
          </span>
        )}
      </p>
      {/* The count is the progress value: the week bars below draw it. */}
      <p
        role="progressbar"
        aria-label="Regular-season series complete"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.completed}
        aria-valuetext={`${progress.completed} of ${progress.total} series complete`}
        className="mt-1 text-xs text-muted"
      >
        <span className="font-semibold tabular-nums text-fg">
          {progress.completed}
        </span>
        <span className="mx-1 text-muted/70">/</span>
        <span className="tabular-nums">{progress.total}</span> series final
      </p>
      {progress.tiebreakerTotal > 0 ? (
        <p className="mt-2 text-xs text-accent">
          {progress.tiebreakerPending > 0
            ? `Tiebreaker week${progress.tiebreakerFocusWeek != null ? ` ${progress.tiebreakerFocusWeek}` : ""} in progress · See the full tiebreaker bracket for remaining games`
            : `${progress.tiebreakerCompleted} tiebreaker series complete`}
        </p>
      ) : null}
      {states.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {states.map((state) => (
            <li key={state.label} className="whitespace-nowrap">
              <span className={`font-semibold tabular-nums ${state.text}`}>
                {state.count}
              </span>{" "}
              <span className="text-muted">{state.label}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {progress.totalWeeks > 1 ? (
        <ol
          aria-label="Regular-season weeks"
          className="mt-3 flex"
          style={{ columnGap: `${Math.min(6, 60 / progress.totalWeeks)}px` }}
        >
          {progress.weeks.map(({ week, total, completed }) => {
            const current = week === progress.focusWeek;
            const share = total > 0 ? (100 * completed) / total : 0;
            return (
              <li
                key={week}
                aria-current={current ? "step" : undefined}
                className="min-w-0 flex-1"
                title={`Week ${week}: ${completed} of ${total} series final${current ? " · current" : ""}`}
              >
                <span className="sr-only">
                  Week {week}: {completed} of {total} series final
                  {current ? ", current week" : ""}
                </span>
                <div
                  aria-hidden="true"
                  className={`h-1.5 overflow-hidden rounded-full bg-line/75 ${current ? "ring-1 ring-cyan-300/70" : ""}`}
                >
                  <div
                    className="h-full rounded-full bg-cyan-300"
                    style={{ width: `${share}%` }}
                  />
                </div>
                {progress.totalWeeks <= 12 ? (
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 block text-center font-mono text-[10px] ${current ? "font-semibold text-cyan-300" : "text-muted/75"}`}
                  >
                    {String(week).padStart(2, "0")}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
