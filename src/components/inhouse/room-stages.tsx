"use client";

import { cn } from "@/lib/utils";
import type { InhouseState } from "@/lib/inhouse-service";

const ROOM_STAGES = [
  { status: null, label: "Queue" },
  { status: "READY_CHECK", label: "Accept" },
  { status: "CAPTAIN_VOTE", label: "Captains" },
  { status: "DRAFTING", label: "Draft" },
  { status: "READY", label: "Set up" },
  { status: "IN_PROGRESS", label: "Play" },
] as const;

/** The strip's name for a lobby phase ("Draft"), for one-line summaries. */
export function roomStageLabel(status: string): string {
  return ROOM_STAGES.find((stage) => stage.status === status)?.label ?? status;
}

/**
 * A shared orientation strip, with no new state machine or extra polling. It
 * shares one row with the room's connection dot and Sound button (the room
 * header), so each stage is at least its label's width: a row too narrow
 * wraps the strip onto a line of its own instead of crushing a label.
 */
export function RoomStages({
  lobby,
  className,
}: {
  lobby: InhouseState["lobby"];
  className?: string;
}) {
  const current = ROOM_STAGES.findIndex(
    (stage) => stage.status === (lobby?.status ?? null),
  );
  return (
    <ol
      aria-label="Inhouse progress"
      className={cn(
        "grid grid-cols-[repeat(6,minmax(max-content,1fr))] gap-1 sm:gap-2",
        className,
      )}
    >
      {ROOM_STAGES.map((stage, i) => (
        <li
          key={stage.label}
          aria-current={i === current ? "step" : undefined}
          className={cn(
            "min-w-0 border-t-2 pt-2.5 text-center text-[10px] font-medium sm:text-xs",
            i === current
              ? "border-accent text-accent"
              : i < current
                ? "border-success/60 text-muted"
                : "border-line text-muted",
          )}
        >
          <span className="mr-1 hidden tabular-nums lg:inline" aria-hidden>
            {i < current ? "✓" : String(i + 1).padStart(2, "0")}
          </span>
          {stage.label}
        </li>
      ))}
    </ol>
  );
}
