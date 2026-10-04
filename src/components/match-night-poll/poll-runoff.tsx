"use client";

import { useEffect, useState } from "react";
import { buttonClasses, textLink } from "@/components/ui";
import {
  eliminatedInRound,
  roundStory,
  runoffPlacement,
  type PollSlotView,
  type RunoffResult,
} from "@/lib/match-night-poll";
import { cn } from "@/lib/utils";

const STEP_MS = 1700;

/**
 * The instant-runoff count as a race. One bar per slot, in finishing order
 * so rows never jump; each bar is that slot's share of the ballots still in
 * play, against a dashed line at half. Step through the rounds, or replay
 * them, and watch a dropped slot's ballots flow to the next choices until one
 * slot crosses the line. Every round has a one-sentence caption
 * (roundStory), so the chart never needs reading to follow the count.
 */
export function PollRunoff({
  slots,
  result,
  open,
  noneOfThese,
  myFirst,
}: {
  slots: PollSlotView[];
  result: RunoffResult;
  /** Voting still open: the leader "leads" instead of "wins". */
  open: boolean;
  /** Ballots that rank nothing. */
  noneOfThese: number;
  /** The viewer's first choice, marked on its row. */
  myFirst: string | null;
}) {
  const last = result.rounds.length - 1;
  const [round, setRound] = useState(last);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(() => {
      setRound((r) => Math.min(r + 1, last));
      if (round + 1 >= last) setPlaying(false);
    }, STEP_MS);
    return () => clearTimeout(id);
  }, [playing, round, last]);

  const byKey = new Map(slots.map((slot) => [slot.key, slot]));
  const short = (key: string) => {
    const slot = byKey.get(key);
    return slot ? `${slot.days} ${slot.time}` : key;
  };

  if (last < 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-muted">
        {result.ballots > 0
          ? `${result.ballots === 1 ? "The one vote so far says" : `All ${result.ballots} votes so far say`} none of these slots work.`
          : "No votes yet."}
      </p>
    );
  }

  const current = result.rounds[round];
  const previous = round > 0 ? result.rounds[round - 1] : null;
  const tally = new Map(current.tallies.map((t) => [t.key, t.votes]));
  const before = new Map(previous?.tallies.map((t) => [t.key, t.votes]) ?? []);
  const counted = result.ballots - current.exhausted;
  const placement = runoffPlacement(
    slots.map((slot) => slot.key),
    result,
  );
  const final = result.rounds[last];
  const exhaustedAtEnd = final.exhausted - noneOfThese;

  return (
    <div className="space-y-4">
      {last > 0 ? (
        <div
          role="group"
          aria-label="Rounds of the count"
          className="flex flex-wrap items-center gap-1.5"
        >
          {result.rounds.map((_, index) => (
            <button
              key={index}
              type="button"
              aria-pressed={index === round}
              onClick={() => {
                setPlaying(false);
                setRound(index);
              }}
              className={cn(
                buttonClasses("secondary", "sm"),
                index === round &&
                  "border-accent/60 bg-accent/15 text-accent hover:bg-accent/20",
              )}
            >
              {index === last ? (open ? "Now" : "Final") : `Round ${index + 1}`}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setRound(0);
              setPlaying(true);
            }}
            disabled={playing}
            className={buttonClasses("ghost", "sm", "ml-auto")}
          >
            <span aria-hidden>▶</span>
            {playing ? "Counting…" : "Replay the count"}
          </button>
        </div>
      ) : null}

      <div className="relative">
        {/* The majority line, labelled once above the bars. */}
        <div
          aria-hidden
          className="relative mb-1 h-4 text-[11px] font-medium uppercase tracking-wider text-muted"
        >
          <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">
            Majority ▾
          </span>
        </div>
        <ol aria-label="Votes per slot" className="space-y-3.5">
          {placement.map((key) => {
            const slot = byKey.get(key);
            if (!slot) return null;
            const standing = tally.has(key);
            const votes = tally.get(key) ?? 0;
            const share = counted > 0 ? votes / counted : 0;
            const outIn = eliminatedInRound(result, key);
            const goingOut = current.eliminated.includes(key);
            const winner = round === last && key === result.winner;
            const gained = previous && standing ? votes - (before.get(key) ?? 0) : 0;
            const reach = result.reach[key] ?? 0;
            return (
              <li key={key} className="min-w-0">
                <div className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
                  <span
                    className={cn(
                      "min-w-0 truncate font-medium",
                      standing ? "text-fg" : "text-muted",
                    )}
                  >
                    {winner ? (
                      <span aria-hidden className="mr-1">
                        {open ? "📈" : "🏆"}
                      </span>
                    ) : null}
                    {slot.days} ·{" "}
                    <span className="whitespace-nowrap">{slot.time}</span>
                    {winner ? (
                      <span className="sr-only">
                        {open ? " (leading)" : " (winner)"}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
                    {gained > 0 ? (
                      <span
                        key={`${key}-${round}`}
                        className="sold-flash rounded-full bg-success/15 px-1.5 text-xs font-semibold text-success"
                      >
                        +{gained}
                        <span className="sr-only"> this round</span>
                      </span>
                    ) : null}
                    {standing ? (
                      <span className={winner ? "font-semibold text-accent" : "text-fg"}>
                        {votes} vote{votes === 1 ? "" : "s"}
                      </span>
                    ) : (
                      <span className="text-xs text-muted">
                        out in round {(outIn ?? 0) + 1}
                      </span>
                    )}
                  </span>
                </div>
                <div className="relative mt-1.5 h-3 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width,background-color] duration-700 ease-out motion-reduce:transition-none",
                      winner
                        ? open
                          ? "bg-accent/85"
                          : "bg-accent shadow-[0_0_12px] shadow-accent/60"
                        : goingOut
                          ? "bg-danger/70"
                          : "bg-info/60",
                    )}
                    style={{ width: `${Math.round(share * 1000) / 10}%` }}
                  />
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-1/2 border-l-2 border-dashed border-fg/50"
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  {reach} of {result.ballots} can make it
                  {goingOut ? " · drops out this round" : ""}
                  {myFirst === key ? " · your first choice" : ""}
                </p>
              </li>
            );
          })}
        </ol>
      </div>

      <p
        aria-live="polite"
        className="rounded-lg border border-line-soft bg-surface-2/50 px-3 py-2.5 text-sm text-fg"
      >
        {last > 0 ? (
          <span className="font-semibold">
            {round === last ? (open ? "Now: " : "Final: ") : `Round ${round + 1}: `}
          </span>
        ) : null}
        {roundStory({ result, round, open, name: short })}
      </p>

      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted">
        <span>
          {result.ballots} vote{result.ballots === 1 ? "" : "s"}
          {noneOfThese > 0 ? ` · ${noneOfThese} said none of these work` : ""}
          {exhaustedAtEnd > 0
            ? ` · ${exhaustedAtEnd} ran out of choices by the ${open ? "latest" : "final"} round`
            : ""}
        </span>
        <details className="group">
          <summary className={textLink("cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
            How the count works
          </summary>
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
            Every ballot counts for its highest-ranked slot still in the
            running. If no slot has more than half of those ballots, the slot
            with the fewest is dropped and its ballots move to their next
            choice, until one slot has a majority. A ballot with no choices
            left stops counting. Ties for fewest go to an earlier round&apos;s
            count, then to how many voters ranked each slot at all, then to
            poll order.
          </p>
        </details>
      </div>
    </div>
  );
}
