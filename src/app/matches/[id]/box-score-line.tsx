"use client";

import { useId, useState, type ReactNode } from "react";
import type { Grade, gradeTone } from "@/lib/benchmarks";
import { cn } from "@/lib/utils";

type GradeTone = ReturnType<typeof gradeTone>;

/** A player's report card for one game, graded on the server. */
export type LineReport = {
  overall: Grade;
  tone: GradeTone;
  /** The average percentile, e.g. "55th percentile". */
  average: string;
  rows: {
    key: string;
    label: string;
    percent: string;
    grade: Grade;
    tone: GradeTone;
  }[];
};

const GRADE_CHIP: Record<GradeTone, string> = {
  success: "border-success/40 text-success",
  accent: "border-accent/40 text-accent",
  default: "border-line text-fg/80",
  muted: "border-line text-muted",
};

const GRADE_TEXT: Record<GradeTone, string> = {
  success: "text-success",
  accent: "text-accent",
  default: "text-fg/80",
  muted: "text-muted",
};

/**
 * One player's line in a box score. The server renders every piece; this
 * lays them out and owns the report card: ONE overall chip on the hero line
 * (seven per-metric chips were up to 80 per game), whose metrics open as a
 * row of their own under the whole line. A <details> kept the chip and its
 * metrics in one box, so the chip needed a line to itself.
 *
 * The line is a grid: hero, name and KDA, with the numbers under the name.
 * On a side wide enough (the side is an @container, @lg) the numbers move
 * between the name and the KDA, one line per player.
 */
export function BoxScoreLine({
  icon,
  name,
  heroName,
  kda,
  stats,
  report,
}: {
  icon: ReactNode;
  /** The player's name line (avatar, link, MVP chip). */
  name: ReactNode;
  heroName: string;
  /** Placed by its own classes: third column, fourth from @lg. */
  kda: ReactNode;
  /** gpm, lh and net worth, placed by its own classes; null when unknown. */
  stats: ReactNode;
  /** Absent for games imported before benchmarks were stored. */
  report: LineReport | null;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-2/50 @lg:grid-cols-[2rem_minmax(0,1fr)_auto_auto]">
      {icon}
      <div className="min-w-0">
        {name}
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[11px] text-muted [overflow-wrap:anywhere]">
            {heroName}
          </span>
          {report ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((was) => !was)}
              title={`vs the world on this hero: ${report.average}`}
              className={cn(
                "inline-flex min-h-6 items-center gap-1 rounded border px-1.5 text-xs font-semibold uppercase tracking-wide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                GRADE_CHIP[report.tone],
              )}
            >
              Report {report.overall}
              <span className="sr-only">
                , {report.average} vs the world on this hero
              </span>
              <span
                aria-hidden
                className={cn(
                  "text-[10px] transition-transform motion-reduce:transition-none",
                  open && "rotate-180",
                )}
              >
                ▾
              </span>
            </button>
          ) : null}
        </div>
      </div>
      {kda}
      {stats}
      {report ? (
        <div id={panelId} hidden={!open} className="col-span-full mt-1.5 pl-10">
          <ul className="max-w-xs space-y-0.5 text-xs">
            {report.rows.map((r) => (
              <li
                key={r.key}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="text-muted">{r.label}</span>
                <span className="shrink-0 tabular-nums">
                  {r.percent}{" "}
                  <b className={cn("font-semibold", GRADE_TEXT[r.tone])}>
                    {r.grade}
                  </b>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-muted">
            Percentiles against everyone playing this hero worldwide.
          </p>
        </div>
      ) : null}
    </li>
  );
}
