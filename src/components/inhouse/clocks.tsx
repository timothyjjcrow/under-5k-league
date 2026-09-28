"use client";

import { cn } from "@/lib/utils";
import { useElapsedMs, useSecondsLeft } from "@/components/room-clock";

/** "12:34" / "1:02:45" — how long the game has been running. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// --- Countdown leaves -------------------------------------------------------
// Own the 250ms tick (useSecondsLeft/useElapsedMs) so only the clock text
// re-renders each second — not the whole room or the drafting pool.

// The vote & pick countdowns share one shape; urgency threshold + label vary.
export function SecondsClock({
  endsAtMs,
  offsetMs,
  urgentAt,
  label,
  prominent = false,
}: {
  endsAtMs: number | null;
  offsetMs: number;
  urgentAt: number;
  label: (seconds: number) => string;
  prominent?: boolean;
}) {
  const seconds = useSecondsLeft(endsAtMs, offsetMs);
  return (
    <div
      role="timer"
      aria-label={label(seconds)}
      className={cn(
        "shrink-0 font-mono font-bold tabular-nums",
        prominent
          ? "rounded-xl border border-current/20 bg-bg/40 px-4 py-3 text-3xl sm:text-4xl"
          : "text-xl",
        seconds <= urgentAt ? "text-danger" : "text-accent",
      )}
    >
      {seconds}s
    </div>
  );
}

// The running "12:34" game timer in the in-progress banner.
export function ElapsedClock({
  startedAtMs,
  offsetMs,
}: {
  startedAtMs: number | null;
  offsetMs: number;
}) {
  const elapsedMs = useElapsedMs(startedAtMs, offsetMs);
  if (elapsedMs == null) return null;
  return (
    <span
      role="timer"
      aria-label={`game running for ${fmtElapsed(elapsedMs)}`}
      className="font-mono text-base font-bold tabular-nums text-info"
    >
      {fmtElapsed(elapsedMs)}
    </span>
  );
}
