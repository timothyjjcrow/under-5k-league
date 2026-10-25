// The season's calendar from the day its schedule is made (`seasonPlan`):
// the regular weeks, the reserved tiebreaker week and each playoff round,
// every date on the viewer's clock. Server-safe; the dates hydrate through
// <LocalTime>.

import { LocalTime } from "./local-time";
import { formatLeagueMatchTime } from "@/lib/match-time";
import type { SeasonPlanStep } from "@/lib/season-format";
import { cn } from "@/lib/utils";

function PlanDate({ date }: { date: Date }) {
  return (
    <LocalTime
      ts={date.getTime()}
      variant="date"
      initial={formatLeagueMatchTime(date, "date")}
    />
  );
}

/** "Weeks 1–5", "Week 6". */
function weeksLabel(step: SeasonPlanStep): string {
  return step.fromWeek === step.toWeek
    ? `Week ${step.fromWeek}`
    : `Weeks ${step.fromWeek}–${step.toWeek}`;
}

export function SeasonPlanList({
  plan,
  className,
  label = "Season plan",
}: {
  plan: SeasonPlanStep[];
  className?: string;
  /** The list's accessible name, where a page shows a second plan. */
  label?: string;
}) {
  return (
    <ol
      aria-label={label}
      className={cn("grid grid-cols-1 gap-1 text-xs text-muted sm:grid-cols-2", className)}
    >
      {plan.map((step) => (
        <li
          key={`${step.kind}-${step.fromWeek}`}
          className="flex min-w-0 flex-wrap items-baseline gap-x-1.5"
        >
          <span className="font-medium text-fg">{step.label}</span>
          <span>· {weeksLabel(step)}</span>
          {step.from ? (
            <span>
              ·{" "}
              {step.to && step.to.getTime() !== step.from.getTime() ? (
                <>
                  <PlanDate date={step.from} />
                  {" – "}
                  <PlanDate date={step.to} />
                </>
              ) : (
                <PlanDate date={step.from} />
              )}
            </span>
          ) : null}
          {step.kind === "TIEBREAKER" ? <span>(only if a tie needs it)</span> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * The plan folded to one line, "Season plan · two groups of 6 · playoffs from
 * Sat, Dec 19", opening to every step. For /schedule and Home, where the
 * fixtures come first.
 */
export function SeasonPlanFold({
  plan,
  formatLine,
  description,
  className,
}: {
  plan: SeasonPlanStep[];
  /** `formatName(format)`, e.g. "Two groups of 6". */
  formatLine: string;
  /** `describeSeasonFormat(format)`, shown when open. */
  description: string;
  className?: string;
}) {
  const playoffs = plan.find((step) => step.kind === "PLAYOFF");
  return (
    <details
      className={cn(
        "group rounded-xl border border-line-soft bg-surface px-4 py-1 sm:px-5",
        className,
      )}
    >
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-1.5 py-2 text-sm [&::-webkit-details-marker]:hidden">
        <span className="font-medium text-fg">Season plan</span>
        <span className="min-w-0 text-muted">
          · {formatLine}
          {playoffs?.from ? (
            <>
              {" "}· playoffs from <PlanDate date={playoffs.from} />
            </>
          ) : null}
        </span>
        <span aria-hidden className="ml-auto text-xs text-info group-open:hidden">
          Show
        </span>
      </summary>
      <p className="text-xs text-muted">{description}</p>
      <SeasonPlanList plan={plan} className="mt-2 pb-2" />
    </details>
  );
}
