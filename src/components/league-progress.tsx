import type { leagueProgress } from "@/lib/league-progress";

type Progress = ReturnType<typeof leagueProgress>;

/** Aggregate counts, not an implied order of individual fixtures. */
function progressSegments(progress: Progress) {
  const groups = [
    { count: progress.completed, color: "text-cyan-300" },
    { count: progress.live, color: "text-danger" },
    { count: progress.awaiting.length, color: "text-accent" },
    { count: progress.untimed, color: "text-violet-300" },
    { count: progress.scheduled, color: "text-slate-500" },
  ];
  let offset = 0;
  // One notch per series keeps ordinary league schedules easy to read. For a
  // large archive, proportional arcs avoid hundreds of nearly invisible nodes.
  const individual = progress.total <= 60;
  return groups.flatMap(({ count, color }) => {
    if (!count) return [];
    const length = (100 * (individual ? 1 : count)) / progress.total;
    return Array.from({ length: individual ? count : 1 }, () => {
      const segment = { offset, length, color };
      offset += length;
      return segment;
    });
  });
}

export function RegularSeasonProgress({ progress }: { progress: Progress }) {
  if (!progress.total) return null;
  const complete = progress.completed === progress.total;
  const percent = Math.floor((progress.completed / progress.total) * 100);
  const segments = progressSegments(progress);
  const heading =
    progress.focusWeek != null
      ? `Week ${progress.focusWeek} of ${progress.totalWeeks} weeks`
      : complete
        ? "Regular-season results are complete"
        : "Waiting for remaining results";
  const states = [
    {
      count: progress.live,
      label: "Live",
      color: "bg-danger",
      text: "text-danger",
    },
    {
      count: progress.scheduled,
      label: "Scheduled",
      color: "bg-slate-500",
      text: "text-fg",
    },
    {
      count: progress.untimed,
      label: "Time TBC",
      color: "bg-violet-300",
      text: "text-violet-300",
    },
    {
      count: progress.awaiting.length,
      label: "Overdue",
      color: "bg-accent",
      text: "text-accent",
    },
  ].filter((state) => state.count > 0);

  return (
    <div
      className="w-full min-w-0 text-left"
      aria-label="Regular season progress"
    >
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-4 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-5">
        <div
          role="progressbar"
          aria-label="Regular-season series complete"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.completed}
          aria-valuetext={`${progress.completed} of ${progress.total} series complete`}
          className="relative aspect-square"
        >
          <svg
            viewBox="0 0 120 120"
            className="h-full w-full -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="60"
              cy="60"
              r="39"
              fill="none"
              className="stroke-line/60"
              strokeWidth="0.5"
            />
            {segments.map((segment, index) => {
              const gap = Math.min(1.15, segment.length * 0.22);
              return (
                <circle
                  key={index}
                  cx="60"
                  cy="60"
                  r="51"
                  fill="none"
                  pathLength="100"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${segment.length - gap} ${100 - segment.length + gap}`}
                  strokeDashoffset={-segment.offset - gap / 2}
                  className={segment.color}
                />
              );
            })}
          </svg>
          <div
            className="absolute inset-0 flex flex-col items-center justify-center"
            aria-hidden="true"
          >
            <span className="font-display text-3xl font-semibold leading-none tabular-nums tracking-tight text-fg sm:text-4xl">
              {percent}
              <span className="ml-0.5 text-base font-normal text-muted sm:text-lg">
                %
              </span>
            </span>
            <span className="mt-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-cyan-300 sm:text-[10px]">
              Complete
            </span>
          </div>
        </div>

        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
            Regular season
          </p>
          <p
            className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-fg"
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
          <p className="mt-1 text-xs text-muted">
            <span className="font-semibold tabular-nums text-fg">
              {progress.completed}
            </span>
            <span className="mx-1 text-muted/70">/</span>
            <span className="tabular-nums">{progress.total}</span> series final
          </p>
          {states.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-2 text-xs">
              {states.map((state) => (
                <li
                  key={state.label}
                  className="flex items-center gap-1.5 whitespace-nowrap"
                >
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${state.color}`}
                  />
                  <span className={`font-semibold tabular-nums ${state.text}`}>
                    {state.count}
                  </span>
                  <span className="text-muted">{state.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {progress.totalWeeks > 1 ? (
        <ol
          aria-label="Regular-season weeks"
          className="mt-4 flex border-t border-line-soft pt-3"
          style={{ columnGap: `${Math.min(6, 60 / progress.totalWeeks)}px` }}
        >
          {Array.from({ length: progress.totalWeeks }, (_, index) => {
            const week = index + 1;
            const current = week === progress.focusWeek;
            return (
              <li
                key={week}
                aria-current={current ? "step" : undefined}
                className="min-w-0 flex-1"
                title={`Week ${week}${current ? " · current" : ""}`}
              >
                <span className="sr-only">
                  Week {week}
                  {current ? ", current week" : ""}
                </span>
                <div
                  aria-hidden="true"
                  className={`h-1 rounded-full ${current ? "bg-cyan-300" : "bg-line/75"}`}
                />
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
