"use client";

import { buttonClasses, textLink } from "@/components/ui";
import { cn } from "@/lib/utils";
import { resultCardRequeued } from "@/lib/inhouse-result-card";
import type { InhouseState } from "@/lib/inhouse-service";
import { sideMeta } from "@/components/inhouse/shared";

type LastResult = NonNullable<InhouseState["lastResult"]>;

const signed = (n: number) => `${n >= 0 ? "+" : ""}${n}`;

/**
 * The viewer's own finished game, for the ten minutes after its result
 * lands: what it meant for them (Victory or Defeat, their Elo change), the
 * score and the MVP, then both sides with every player's Elo change, and how
 * many of the ten are already back in the queue beside "Run it back". It
 * was one line of text; the result is the payoff of the whole flow.
 */
export function ResultCard({
  result,
  viewerId,
  queuedUserIds,
  runItBack,
  pending,
  onDismiss,
}: {
  result: LastResult;
  viewerId: string | null;
  /** Everyone in the queue now (state.queue), for the "back in the queue" line. */
  queuedUserIds: readonly string[];
  /** The one-tap requeue, or null where a join would be refused. */
  runItBack: (() => void) | null;
  pending: boolean;
  onDismiss: () => void;
}) {
  // An old slot's reply during a release carries no `teams` or `mvp` (the
  // room is served by two builds for about 90 seconds): the card then shows
  // its headline alone, as the one-line banner did, and never throws.
  const teams = Array.isArray(result.teams) ? result.teams : [];
  const mvp = result.mvp ?? null;
  const requeued = resultCardRequeued(teams, queuedUserIds);
  return (
    <section
      role="status"
      aria-live="polite"
      aria-label="Your last game"
      className={cn(
        "rounded-[var(--radius)] border px-4 py-3 sm:px-5 sm:py-4",
        result.myTeamWon
          ? "border-success/50 bg-success/10"
          : "border-danger/40 bg-danger/10",
      )}
    >
      {/* The headline on its own line on a phone, the buttons under it; one
          row from sm. */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="text-2xl leading-7" aria-hidden>
            {result.myTeamWon ? "🏆" : "💀"}
          </span>
          <div className="min-w-0">
            <p className="font-display text-xl font-semibold leading-7">
              {result.myTeamWon ? "Victory" : "Defeat"} for you,{" "}
              <strong
                className={cn(
                  "tabular-nums",
                  result.eloDelta >= 0 ? "text-success" : "text-danger-soft",
                )}
              >
                {signed(result.eloDelta)} Elo
              </strong>
            </p>
            <p className="mt-0.5 text-sm text-muted">
              <strong className="text-fg">
                {result.winnerSide} win {result.radiantScore}–{result.direScore}
              </strong>
              {mvp ? (
                <>
                  {" · MVP "}
                  <span className="font-medium text-fg">{mvp.name}</span>
                  {mvp.hero ? ` (${mvp.hero})` : ""}
                </>
              ) : null}
              {" · "}
              <a
                href={`#result-${result.lobbyId}`}
                className={textLink("whitespace-nowrap")}
              >
                Box score ↓
              </a>
            </p>
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {runItBack ? (
            // The retention moment: everyone's still here, the game just
            // ended — one tap puts you back in line for the next one.
            <button
              type="button"
              disabled={pending}
              onClick={runItBack}
              className={buttonClasses("accent", "sm")}
            >
              Run it back →
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss result banner"
            className={buttonClasses("secondary", "sm")}
          >
            Dismiss
          </button>
        </span>
      </div>

      {/* Both sides, Radiant first, captain first: who gained and who lost. */}
      {teams.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {teams.map((team) => {
            const meta = sideMeta(team.isRadiant);
            return (
              <div
                key={meta.name}
                className={cn(
                  "min-w-0 rounded-lg border bg-surface/60",
                  team.won ? meta.ring : "border-line",
                )}
              >
                <p className="flex min-w-0 items-baseline justify-between gap-2 border-b border-line-soft px-2.5 py-1.5 text-xs">
                  <span
                    className={cn(
                      "font-semibold",
                      team.isRadiant ? "text-success" : "text-danger-soft",
                    )}
                  >
                    {meta.name}
                  </span>
                  <span
                    className={team.won ? "font-medium text-fg" : "text-muted"}
                  >
                    {team.won ? "Won" : "Lost"}
                  </span>
                </p>
                <ul aria-label={`${meta.name}, ${team.won ? "won" : "lost"}`}>
                  {team.players.map((p) => (
                    <li
                      key={p.userId}
                      className={cn(
                        "flex min-w-0 items-baseline justify-between gap-2 px-2.5 py-1 text-sm",
                        p.userId === viewerId && "bg-accent/10",
                      )}
                    >
                      <span className="min-w-0 truncate">
                        {p.name}
                        {p.userId === mvp?.userId ? (
                          <span className="ml-1.5 text-[11px] font-semibold text-accent">
                            MVP
                          </span>
                        ) : null}
                      </span>
                      {p.eloDelta !== null ? (
                        <span
                          className={cn(
                            "shrink-0 text-xs font-medium tabular-nums",
                            p.eloDelta >= 0
                              ? "text-success"
                              : "text-danger-soft",
                          )}
                        >
                          {signed(p.eloDelta)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
      {requeued.back > 0 ? (
        <p className="mt-2 text-xs text-muted tabular-nums">
          {requeued.back} of that game’s {requeued.total} are back in the queue.
        </p>
      ) : null}
    </section>
  );
}
