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

/** A shared orientation strip, with no new state machine or extra polling. */
export function RoomStages({ lobby }: { lobby: InhouseState["lobby"] }) {
  const current = ROOM_STAGES.findIndex(
    (stage) => stage.status === (lobby?.status ?? null),
  );
  return (
    <ol
      aria-label="Inhouse progress"
      className="grid grid-cols-6 gap-1 sm:gap-2"
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
          <span className="mr-1 hidden tabular-nums sm:inline" aria-hidden>
            {i < current ? "✓" : String(i + 1).padStart(2, "0")}
          </span>
          {stage.label}
        </li>
      ))}
    </ol>
  );
}
