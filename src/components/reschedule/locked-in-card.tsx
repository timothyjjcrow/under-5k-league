import { LocalTime } from "@/components/local-time";
import { formatMatchTime } from "@/lib/match-time";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import { cn } from "@/lib/utils";
import type { RecentLock } from "@/lib/reschedule-ready-check-service";

/**
 * "Moved by ready check": what the match page shows for a day after a ready
 * check moves the match, so a player arriving later learns why the kickoff
 * changed and that their answer is now their check-in. Server-rendered; a
 * lock only seconds old plays a CSS burst, which is the celebration the
 * person who completed it sees once the page re-renders.
 */
export function LockedInCard({
  lock,
  id = MATCH_ANCHOR.reschedule,
}: {
  lock: RecentLock;
  /** Null when a sibling card already carries the reschedule anchor. */
  id?: string | null;
}) {
  return (
    <div
      id={id ?? undefined}
      role="status"
      className={cn(
        "relative min-w-0 scroll-mt-24 overflow-hidden rounded-[var(--radius)] border border-success/50 bg-gradient-to-br from-success/15 via-surface to-surface px-4 text-sm sm:px-5",
        lock.burst ? "py-6 text-center" : "py-3",
      )}
    >
      {lock.burst ? <Burst /> : null}
      {lock.burst ? (
        <p className="ready-pop text-4xl" aria-hidden>
          🎉
        </p>
      ) : null}
      <p
        className={cn(
          "text-fg [overflow-wrap:anywhere]",
          lock.burst && "mt-2 font-display text-2xl font-semibold",
        )}
      >
        {lock.burst ? (
          "Locked in!"
        ) : (
          <>
            <span aria-hidden>🗓️ </span>
            <strong>Moved by ready check</strong>
          </>
        )}
      </p>
      <p className={cn("text-muted", lock.burst ? "mt-1" : "mt-0.5")}>
        Now{" "}
        <strong className="text-fg">
          <LocalTime
            ts={lock.timeMs}
            variant="full"
            initial={formatMatchTime(new Date(lock.timeMs), "full")}
          />
        </strong>
        {lock.seats > 0 ? (
          <>
            {" "}
            · {lock.ready}/{lock.seats} players were in
          </>
        ) : null}
        . Everyone&apos;s answer is now their check-in.
      </p>
    </div>
  );
}

const SPARKS = Array.from({ length: 16 }, (_, i) => {
  const angle = (i / 16) * Math.PI * 2;
  const distance = 80 + (i % 3) * 26;
  return {
    x: `${Math.round(Math.cos(angle) * distance)}px`,
    y: `${Math.round(Math.sin(angle) * distance)}px`,
    color: ["bg-accent", "bg-success", "bg-info"][i % 3],
  };
});

function Burst() {
  return (
    <div aria-hidden className="pointer-events-none absolute left-1/2 top-12">
      {SPARKS.map((spark, i) => (
        <span
          key={i}
          className={cn("ready-burst absolute h-2 w-2 rounded-full", spark.color)}
          style={
            {
              "--burst-x": spark.x,
              "--burst-y": spark.y,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
