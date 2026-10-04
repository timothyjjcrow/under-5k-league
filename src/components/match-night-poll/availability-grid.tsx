"use client";

import { useEffect, useRef, useState } from "react";
import { castMatchNightBallot } from "@/app/actions/match-night-poll";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { buttonClasses } from "@/components/ui";
import {
  describeTimes,
  pollGrid,
  slotDayName,
  slotDayShort,
  slotHour,
  slotOnClock,
  type PollSlotView,
} from "@/lib/match-night-poll";
import { cn } from "@/lib/utils";
import { LEAGUE_LOCALE } from "@/lib/zoned-time";
import { DayShift, useClockName, usePollClock } from "./poll-clock";

/**
 * The availability ballot: a grid of days by start times. Tap a cell to mark
 * a time you could play, drag across cells to mark a range, or tap a day or a
 * time to fill (or clear) its whole column or row. Mark as many as you like;
 * the time the most players can make wins. Nothing is saved until "Save my
 * times", which posts the whole set at once (castMatchNightBallot).
 *
 * Times are shown on the viewer's clock (PollClockProvider) and stored on the
 * league's. A voter who has already voted sees their saved times with
 * "Change my times"; the server remounts this component after a save (keyed
 * by the ballot's time), which folds the editor back up.
 */
export function AvailabilityGrid({
  pollId,
  slots,
  saved,
}: {
  pollId: string;
  slots: PollSlotView[];
  /** The viewer's saved times, or null before they vote. */
  saved: string[] | null;
}) {
  const { zone } = usePollClock();
  const clockName = useClockName();
  const grid = pollGrid(slots);
  const known = new Set(slots.map((slot) => slot.key));
  const savedKeys = (saved ?? []).filter((key) => known.has(key));
  const [editing, setEditing] = useState(saved === null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(savedKeys));
  const [said, setSaid] = useState("");
  // A drag in progress: whether it marks or clears, and the cells it has
  // already passed over.
  const painting = useRef<{ mark: boolean; seen: Set<string> } | null>(null);

  useEffect(() => {
    const stop = () => {
      painting.current = null;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const shownTimes = (keys: Iterable<string>) =>
    describeTimes(
      slots
        .filter((slot) => new Set(keys).has(slot.key))
        .map((slot) => slotOnClock(slot, zone)),
      LEAGUE_LOCALE,
    );

  if (!editing && saved !== null) {
    const ranges = shownTimes(savedKeys);
    return (
      <div className="rounded-lg border border-success/30 bg-success/[0.06] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-fg">
            <span aria-hidden className="text-success">
              ✓{" "}
            </span>
            Your times are in
          </p>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={buttonClasses("secondary", "sm")}
          >
            Change my times
          </button>
        </div>
        {ranges.length > 0 ? (
          <ul aria-label="Your times" className="mt-3 flex flex-wrap gap-2">
            {ranges.map((range) => (
              <li
                key={range}
                className="rounded-full border border-line bg-surface-2/70 px-3 py-1 text-sm text-fg"
              >
                {range}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">
            You said none of these times work for you.
          </p>
        )}
        <p className="mt-3 text-xs text-muted">
          {savedKeys.length > 0
            ? `${savedKeys.length} time${savedKeys.length === 1 ? "" : "s"}, shown in ${clockName}. `
            : ""}
          You can change them until voting closes.
        </p>
      </div>
    );
  }

  const set = (keys: string[], mark: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (mark) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  const labelOf = (slot: PollSlotView) => {
    const shown = slotOnClock(slot, zone);
    return `${slotDayName(shown)} ${slotHour(shown.minute, LEAGUE_LOCALE)}`;
  };
  const toggleAll = (keys: string[], what: string) => {
    const mark = !keys.every((key) => picked.has(key));
    set(keys, mark);
    setSaid(mark ? `Marked all of ${what}.` : `Cleared ${what}.`);
  };
  const cellAt = (target: EventTarget | null) =>
    target instanceof Element
      ? (target.closest("[data-slot]") as HTMLElement | null)
      : null;

  const ranges = shownTimes(picked);
  const value = JSON.stringify(slots.map((s) => s.key).filter((k) => picked.has(k)));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Tap every time you could start a match, as many as you like. Drag to
        mark a range, or tap a day or a time to fill it. Times are in{" "}
        <span className="font-medium text-fg">{clockName}</span>.
      </p>

      <table
        className="w-full table-fixed border-separate border-spacing-1 select-none"
        aria-label="Times you could play"
        onPointerDown={(event) => {
          const cell = cellAt(event.target);
          const key = cell?.dataset.slot;
          if (!key) return;
          const mark = !picked.has(key);
          painting.current = { mark, seen: new Set([key]) };
          set([key], mark);
        }}
        onPointerMove={(event) => {
          const drag = painting.current;
          if (!drag) return;
          // Touch keeps sending events to the cell the finger went down on,
          // so find the cell under the finger by position.
          const key = cellAt(
            document.elementFromPoint(event.clientX, event.clientY),
          )?.dataset.slot;
          if (!key || drag.seen.has(key)) return;
          drag.seen.add(key);
          set([key], drag.mark);
        }}
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
            {grid.days.map((day) => {
              const keys = grid.minutes
                .map((minute) => grid.at(day, minute)?.key)
                .filter((key): key is string => !!key);
              const full = keys.every((key) => picked.has(key));
              return (
                <th key={day} scope="col" className="p-0">
                  <button
                    type="button"
                    onClick={() => toggleAll(keys, `${slotDayName({ day })} in the league's week`)}
                    aria-label={`${full ? "Clear" : "Mark"} every ${slotDayName({ day })} time`}
                    className="h-8 w-full rounded-md text-xs font-semibold uppercase tracking-wide text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none"
                  >
                    {slotDayShort({ day })}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {grid.minutes.map((minute) => {
            const row = grid.days
              .map((day) => grid.at(day, minute))
              .filter((slot): slot is PollSlotView => !!slot);
            const sample = row[0];
            const shown = sample ? slotOnClock(sample, zone) : null;
            const keys = row.map((slot) => slot.key);
            const full = keys.every((key) => picked.has(key));
            const time = shown ? slotHour(shown.minute, LEAGUE_LOCALE) : "";
            return (
              <tr key={minute}>
                <th scope="row" className="p-0">
                  <button
                    type="button"
                    onClick={() => toggleAll(keys, `${time} every day`)}
                    aria-label={`${full ? "Clear" : "Mark"} ${time} every day`}
                    className="flex h-9 w-full items-center justify-end whitespace-nowrap rounded-md pr-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none sm:h-10 sm:text-sm"
                  >
                    {time}
                    {shown ? <DayShift shift={shown.shift} /> : null}
                  </button>
                </th>
                {grid.days.map((day) => {
                  const slot = grid.at(day, minute);
                  if (!slot) return <td key={day} />;
                  const on = picked.has(slot.key);
                  return (
                    <td key={day} className="p-0">
                      <button
                        type="button"
                        data-slot={slot.key}
                        aria-pressed={on}
                        aria-label={labelOf(slot)}
                        onClick={(event) => {
                          // Pointer taps are handled on pointerdown (so a
                          // drag can start); this is the keyboard path.
                          if (event.detail !== 0) return;
                          set([slot.key], !on);
                        }}
                        className={cn(
                          "grid h-9 w-full touch-none place-items-center rounded-md border text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg motion-reduce:transition-none sm:h-10",
                          on
                            ? "border-success/70 bg-success text-black"
                            : "border-line bg-surface-2/60 text-transparent hover:border-success/50 hover:bg-success/15",
                        )}
                      >
                        <span aria-hidden>✓</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="text-sm text-fg" aria-live="polite">
        {picked.size === 0 ? (
          <span className="text-muted">No times marked yet.</span>
        ) : (
          <>
            <span className="font-semibold">
              {picked.size} time{picked.size === 1 ? "" : "s"}:
            </span>{" "}
            {ranges.length > 6
              ? `${ranges.slice(0, 6).join(", ")} and ${ranges.length - 6} more`
              : ranges.join(", ")}
          </>
        )}
      </p>

      <ActionForm
        action={castMatchNightBallot}
        hidden={{ pollId }}
        className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-4"
      >
        <input type="hidden" name="availability" value={value} />
        <SubmitButton disabled={picked.size === 0}>
          {saved === null ? "Save my times" : "Save my new times"}
        </SubmitButton>
        {picked.size === 0 ? (
          <SubmitButton variant="ghost" size="sm" name="none" value="1">
            None of these work for me
          </SubmitButton>
        ) : (
          <button
            type="button"
            onClick={() => {
              setPicked(new Set());
              setSaid("Cleared every time.");
            }}
            className={buttonClasses("ghost", "sm")}
          >
            Clear
          </button>
        )}
        {saved !== null ? (
          <button
            type="button"
            onClick={() => {
              setPicked(new Set(savedKeys));
              setEditing(false);
            }}
            className={buttonClasses("ghost", "sm")}
          >
            Cancel
          </button>
        ) : null}
      </ActionForm>
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
    </div>
  );
}
