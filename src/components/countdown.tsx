"use client";

// Ticking "in 2d 5h" chip for a scheduled match. Renders nothing until
// mounted (the label depends on the client clock, so SSR would mismatch)
// and nothing once the night is over.

import { useEffect, useState } from "react";
import { countdownLabel } from "@/lib/countdown";

export function Countdown({
  targetMs,
  eventLabel = "Match",
}: {
  targetMs: number;
  /** Spoken event name — "Draft starts in 2d", not every timer is a match. */
  eventLabel?: string;
}) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const compute = () => setLabel(countdownLabel(targetMs, Date.now()));
    compute();
    const id = setInterval(compute, 30_000);
    return () => clearInterval(id);
  }, [targetMs]);
  if (!label) return null;
  const live = label === "happening now";
  return (
    <span
      role="timer"
      aria-label={
        live ? `${eventLabel} is happening now` : `${eventLabel} starts ${label}`
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
