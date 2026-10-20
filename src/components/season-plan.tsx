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
}: {
  plan: SeasonPlanStep[];
  className?: string;
}) {
  return (
    <ol
      aria-label="Season plan"
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
