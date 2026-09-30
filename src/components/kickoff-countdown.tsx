"use client";

// The segmented kickoff clock on an upcoming match: "KICKOFF IN 2d 05h 12m
// 33s", ticking. Before this, only the two teams' players saw a countdown
// (the check-in banner's chip); a visitor opening the grand final saw a date.
//
// The clock depends on the viewer's own clock, so the server renders empty
// segments and the browser fills them (no hydration mismatch). One shared
// one-second ticker serves every clock on the page.

import { useSyncExternalStore } from "react";
import { kickoffClock, kickoffClockSpoken } from "@/lib/countdown";
import { cn } from "@/lib/utils";

let nowSecond: number | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const readSecond = () => Math.floor(Date.now() / 1000);

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!ticker) {
    nowSecond = readSecond();
    ticker = setInterval(() => {
      nowSecond = readSecond();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

function getSnapshot(): number {
  if (nowSecond === null) nowSecond = readSecond();
  return nowSecond;
}

function getServerSnapshot(): number | null {
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function KickoffCountdown({
  targetMs,
  label = "Kickoff in",
  nowText = "It's kickoff time",
  tone = "default",
  className,
}: {
  targetMs: number;
  /** Said above the clock and first in its accessible name. */
  label?: string;
  /** Shown from kickoff through the live window, when the clock hides. */
  nowText?: string;
  /** A grand final wears the champion's gold. */
  tone?: "default" | "final";
  className?: string;
}) {
  const second = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const clock = second === null ? null : kickoffClock(targetMs, second * 1000);
  if (clock?.state === "over") return null;

  const gold = tone === "final";
  if (clock?.state === "now") {
    return (
      <p
        role="timer"
        className={cn(
          "rounded-full border px-3 py-1 text-sm font-semibold",
          gold
            ? "border-accent/50 bg-accent/10 text-accent"
            : "border-success/40 bg-success/10 text-success",
          className,
        )}
      >
        {nowText}
      </p>
    );
  }

  // Before the browser has read its clock: the same boxes, empty, so the
  // card doesn't jump when the digits arrive.
  const segments: [string, string][] = clock
    ? [
        ...(clock.days > 0 ? ([[String(clock.days), "days"]] as [string, string][]) : []),
        [pad(clock.hours), "hrs"],
        [pad(clock.minutes), "min"],
        [pad(clock.seconds), "sec"],
      ]
    : [
        ["–", "days"],
        ["–", "hrs"],
        ["–", "min"],
        ["–", "sec"],
      ];

  return (
    <div
      role="timer"
      aria-label={clock ? `${label} ${kickoffClockSpoken(clock)}` : undefined}
      aria-hidden={clock ? undefined : true}
      className={cn("flex flex-col items-center gap-1.5", className)}
    >
      <span
        aria-hidden
        className={cn(
          "text-[10px] font-semibold uppercase tracking-[0.2em]",
          gold ? "text-accent" : "text-muted",
        )}
      >
        {label}
      </span>
      <span aria-hidden className="flex items-stretch gap-1.5">
        {segments.map(([value, unit]) => (
          <span
            key={unit}
            className={cn(
              "flex min-w-11 flex-col items-center rounded-lg border px-2 py-1",
              gold ? "border-accent/40 bg-accent/5" : "border-line bg-bg/40",
            )}
          >
            <span
              className={cn(
                "font-display text-xl font-semibold leading-none tabular-nums sm:text-2xl",
                gold ? "text-accent" : "text-fg",
              )}
            >
              {value}
            </span>
            <span className="mt-1 text-[10px] uppercase tracking-wider text-muted">
              {unit}
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}
