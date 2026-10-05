"use client";

import {
  pollGrid,
  slotDayName,
  slotDayShort,
  slotHour,
  slotOnClock,
  type AvailabilityResult,
  type PollSlotView,
} from "@/lib/match-night-poll";
import { cn } from "@/lib/utils";
import { LEAGUE_LOCALE } from "@/lib/zoned-time";
import { DayShift, useClockName, usePollClock, useSlotOnClock } from "./poll-clock";

/**
 * Who can play when: the same grid as the ballot, each cell showing how many
 * players can make that start time, shaded by it. The best times are listed
 * under it. Times follow the shown clock (PollClockProvider). The viewer's
 * own times carry a ring; nothing says who marked what.
 */
export function AvailabilityHeatmap({
  slots,
  result,
  open,
  noneOfThese,
  mine,
}: {
  slots: PollSlotView[];
  result: AvailabilityResult;
  /** Voting still open: the best time "leads" instead of "wins". */
  open: boolean;
  noneOfThese: number;
  /** The viewer's marked times, ringed on the grid. */
  mine: string[] | null;
}) {
  const { zone } = usePollClock();
  const clockName = useClockName();
  const onClock = useSlotOnClock();
  const grid = pollGrid(slots);
  const max = Math.max(0, ...Object.values(result.counts));
  const voters = result.ballots;
  const mineSet = new Set(mine ?? []);
  const byKey = new Map(slots.map((slot) => [slot.key, slot]));
  const best = result.order
    .filter((key) => result.counts[key] > 0)
    .slice(0, 3);

  if (voters === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-muted">
        No votes yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {best.length > 0 ? (
        <ol aria-label="Best times" className="grid grid-cols-1 gap-1.5 sm:grid-cols-3 sm:gap-2">
          {best.map((key, index) => {
            const slot = byKey.get(key)!;
            const shown = onClock(slot);
            const count = result.counts[key];
            const leader = index === 0;
            return (
              <li
                key={key}
                // One line per time on a phone, a small card from sm up.
                className={cn(
                  "flex min-w-0 flex-wrap items-baseline gap-x-2 rounded-lg border px-3 py-2 sm:block sm:py-2.5",
                  leader
                    ? "border-accent/50 bg-accent/10"
                    : "border-line bg-surface-2/50",
                )}
              >
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                  {leader ? (open ? "Leading" : "Winner") : `#${index + 1}`}
                </p>
                <p className="font-semibold text-fg sm:mt-0.5">
                  {shown.text}
                  <DayShift shift={shown.shift} />
                </p>
                <p className="ml-auto text-xs text-muted sm:ml-0">
                  {count} of {voters} can play
                  {mineSet.has(key) ? " · you can" : ""}
                </p>
              </li>
            );
          })}
        </ol>
      ) : null}

      <table
        className="w-full table-fixed border-separate border-spacing-1"
        aria-label={`How many players can play each time, in ${clockName}`}
      >
        <colgroup>
          <col className="w-14 sm:w-20" />
          {grid.days.map((day) => (
            <col key={day} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Start time</span>
            </th>
            {grid.days.map((day) => (
              <th
                key={day}
                scope="col"
                className="pb-1 text-xs font-semibold uppercase tracking-wide text-muted"
              >
                <span aria-hidden>{slotDayShort({ day })}</span>
                <span className="sr-only">{slotDayName({ day })}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.minutes.map((minute) => {
            const sample = grid.days
              .map((day) => grid.at(day, minute))
              .find((slot): slot is PollSlotView => !!slot);
            const shown = sample ? slotOnClock(sample, zone) : null;
            return (
              <tr key={minute}>
                <th
                  scope="row"
                  className="whitespace-nowrap pr-1.5 text-right text-xs font-medium text-muted sm:text-sm"
                >
                  {shown ? slotHour(shown.minute, LEAGUE_LOCALE) : ""}
                  {shown ? <DayShift shift={shown.shift} /> : null}
                </th>
                {grid.days.map((day) => {
                  const slot = grid.at(day, minute);
                  if (!slot) return <td key={day} />;
                  const count = result.counts[slot.key] ?? 0;
                  const share = max > 0 ? count / max : 0;
                  const winner = slot.key === result.winner;
                  return (
                    <td key={day} className="p-0">
                      <div
                        title={`${onClock(slot).text}: ${count} of ${voters} can play`}
                        className={cn(
                          "grid h-9 place-items-center rounded-md border text-xs font-semibold tabular-nums sm:h-10 sm:text-sm",
                          winner ? "border-accent" : "border-line-soft",
                          mineSet.has(slot.key) && "ring-2 ring-info/70 ring-inset",
                          share > 0.55 ? "text-black" : "text-fg",
                        )}
                        style={{
                          backgroundColor:
                            count > 0
                              ? `color-mix(in srgb, var(--color-success) ${Math.round(15 + share * 75)}%, transparent)`
                              : undefined,
                        }}
                      >
                        {count > 0 ? count : ""}
                        <span className="sr-only">
                          {count === 0 ? "nobody" : ` of ${voters}`}
                          {winner ? (open ? ", leading" : ", winner") : ""}
                        </span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted">
        <span>
          {voters} vote{voters === 1 ? "" : "s"}
          {noneOfThese > 0 ? ` · ${noneOfThese} said none of these work` : ""}
          {mine && mine.length > 0 ? " · your times are ringed" : ""}
        </span>
        <span>
          The time the most players can make wins. A tie goes to the one with
          more players free an hour either side.
        </span>
      </div>
    </div>
  );
}
