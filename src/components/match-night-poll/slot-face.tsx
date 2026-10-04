"use client";

import { useSyncExternalStore } from "react";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { yourSlotTime, type PollSlotView } from "@/lib/match-night-poll";
import { zoneLabel } from "@/lib/zone-label";
import { cn } from "@/lib/utils";

const emptySubscribe = () => () => {};

function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return LEAGUE_CONFIG.timeZone;
  }
}

/**
 * A slot on the viewer's own clock ("Mon 3:00 AM your time"), or null when
 * it reads the same as the league's. Null on the server and through
 * hydration (the server can't know the viewer's zone), then the browser's
 * answer: the useLocalTimeText trick, so it never mismatches.
 */
export function useYourSlotTime(nextAt: number): string | null {
  return useSyncExternalStore(
    emptySubscribe,
    () => yourSlotTime(nextAt, LEAGUE_CONFIG.timeZone, viewerZone()),
    () => null,
  );
}

/**
 * A poll slot as voters read it: a day tile ("SUN"), the time on the
 * league's clock, and the viewer's own clock underneath when it differs.
 * Purely visual; the control around it carries the accessible name.
 */
export function SlotFace({
  slot,
  tone = "default",
  compact = false,
  className,
}: {
  slot: PollSlotView;
  tone?: "default" | "ranked" | "muted";
  /** Drop the day tile below `sm`, for rows that also carry controls. */
  compact?: boolean;
  className?: string;
}) {
  const yours = useYourSlotTime(slot.nextAt);
  return (
    <span className={cn("flex min-w-0 items-center gap-3", className)}>
      <span
        aria-hidden
        className={cn(
          "h-11 w-11 shrink-0 place-items-center rounded-lg border text-xs font-bold uppercase tracking-wider",
          compact ? "hidden sm:grid" : "grid",
          tone === "ranked"
            ? "border-accent/40 bg-accent/15 text-accent"
            : tone === "muted"
              ? "border-line-soft bg-surface-2/50 text-muted"
              : "border-line bg-surface-2 text-fg",
        )}
      >
        {slot.dayShort}
      </span>
      <span className="min-w-0 text-left leading-tight">
        <span
          className={cn(
            "block font-semibold [overflow-wrap:break-word]",
            tone === "muted" ? "text-muted" : "text-fg",
          )}
        >
          {slot.days} ·{" "}
          <span className="whitespace-nowrap">{slot.time}</span>
        </span>
        <span className="mt-0.5 block text-xs text-muted [overflow-wrap:break-word]">
          {zoneLabel(LEAGUE_CONFIG.timeZone)}
          {yours ? ` · ${yours}` : ""}
        </span>
      </span>
    </span>
  );
}
