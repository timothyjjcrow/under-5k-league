"use client";

// Ticking "in 2d 5h" chip for a scheduled match. Renders nothing until
// mounted (the label depends on the client clock, so SSR would mismatch)
// and — unless given a `passedLabel` — nothing once the night is over.

import { useEffect, useState } from "react";
import { countdownLabel, hasPassed } from "@/lib/countdown";

export function Countdown({
  targetMs,
  eventLabel = "Match",
  futureVerb = "starts",
  passedLabel,
  passesAtTarget = false,
}: {
  targetMs: number;
  /** Spoken event name — "Draft starts in 2d", not every timer is a match. */
  eventLabel?: string;
  /** Spoken future-tense verb — deadlines "lock" instead of "start". */
  futureVerb?: string;
  /**
   * What to show once the date has been and gone. Omit and the chip vanishes,
   * which is right beside a fixture list that has moved on — the row itself is
   * gone too.
   *
   * It is WRONG next to a date the page still prints. A draft night that slips
   * left the dashboard rendering "🗓️ Draft night: Sun, Jul 26" with no chip at
   * all — a past date presented as a plan, under a "Ready to draft" badge, on
   * the page a prospective player judges the league by. Whoever still shows the
   * date owns saying it has passed, and the tense lives in this chip so the two
   * can never drift apart.
   *
   * Deciding this on the SERVER instead would be a different bug: the boundary
   * is 3h wide and a page left open crosses it without a re-render, so the chip
   * would contradict the countdown that just vanished beside it.
   */
  passedLabel?: string;
  /** Deadlines pass at the target; events otherwise keep the live window. */
  passesAtTarget?: boolean;
}) {
  const [label, setLabel] = useState<string | null>(null);
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    const compute = () => {
      const now = Date.now();
      const deadlinePassed = passesAtTarget && now >= targetMs;
      setLabel(deadlinePassed ? null : countdownLabel(targetMs, now));
      setPassed(deadlinePassed || hasPassed(targetMs, now));
    };
    compute();
    const id = setInterval(compute, 30_000);
    return () => clearInterval(id);
  }, [passesAtTarget, targetMs]);

  if (!label) {
    // Pre-mount is also `!label`, and it is NOT the passed state — rendering
    // the passed chip there would flash "start overdue" on every load of
    // an upcoming fixture. `passed` is false until the first compute, so the
    // chip stays absent until the clock has actually been read.
    if (!passed || !passedLabel) return null;
    // `accent` (amber), not `danger`: a draft night that slipped is worth
    // noticing, but nothing has gone wrong — the league is still taking
    // signups. The palette has no `warning`; accent is its attention colour,
    // and is already what the hero's ask uses.
    return (
      <span
        role="timer"
        aria-label={`${eventLabel}: ${passedLabel}`}
        className="ml-1.5 inline-block whitespace-nowrap rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 align-middle text-xs font-medium text-accent"
      >
        <span aria-hidden>⚠️</span> {passedLabel}
      </span>
    );
  }

  const live = label === "happening now";
  return (
    <span
      role="timer"
      aria-label={
        live
          ? `${eventLabel} is happening now`
          : `${eventLabel} ${futureVerb} ${label}`
      }
      className={
        live
          ? "ml-1.5 inline-block whitespace-nowrap rounded-full border border-success/40 bg-success/15 px-2 py-0.5 align-middle text-xs font-medium text-success"
          : "ml-1.5 inline-block whitespace-nowrap rounded-full border border-info/40 bg-info/15 px-2 py-0.5 align-middle text-xs font-medium text-info"
      }
    >
      <span aria-hidden>{live ? "🔴" : "⏳"}</span> {label}
    </span>
  );
}
