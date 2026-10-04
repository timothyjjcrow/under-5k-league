"use client";

import { useState } from "react";
import { buttonClasses } from "@/components/ui";
import { POLL_MAX_SLOTS } from "@/lib/match-night-poll";

const DAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

export type SlotRow = { day: string; time: string };

/**
 * The poll's slots as rows of weekday + time on the league's clock, posted
 * as parallel `slotDay` / `slotTime` fields (parseSlotRows reads them, skips
 * blank rows and refuses half-filled ones by number). Rows can be added up to
 * the poll's limit and removed down to one.
 */
export function PollSlotRows({
  initial,
  zone,
}: {
  initial: SlotRow[];
  /** The league's zone in words, "Pacific time". */
  zone: string;
}) {
  const [rows, setRows] = useState(() =>
    initial.map((row, id) => ({ ...row, id })),
  );
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs text-muted">
        Slots to vote between, on the league&apos;s clock ({zone}). Blank rows
        are skipped.
      </legend>
      <ol className="space-y-2">
        {rows.map((row, index) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2">
            <span className="w-6 text-right text-xs tabular-nums text-muted">
              {index + 1}.
            </span>
            <select
              name="slotDay"
              defaultValue={row.day}
              aria-label={`Slot ${index + 1} day`}
              className="h-9 rounded-md border border-line bg-surface-2/50 px-2 text-sm text-fg"
            >
              <option value="">Day…</option>
              {DAYS.map((day) => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </select>
            <input
              type="time"
              name="slotTime"
              defaultValue={row.time}
              step={900}
              aria-label={`Slot ${index + 1} time`}
              className="h-9 rounded-md border border-line bg-surface-2/50 px-2 text-sm text-fg"
            />
            {rows.length > 1 ? (
              <button
                type="button"
                onClick={() =>
                  setRows((current) => current.filter((r) => r.id !== row.id))
                }
                aria-label={`Remove slot ${index + 1}`}
                className={buttonClasses("ghost", "sm", "w-10 px-0 sm:w-8")}
              >
                <span aria-hidden>✕</span>
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      {rows.length < POLL_MAX_SLOTS ? (
        <button
          type="button"
          onClick={() =>
            setRows((current) => [
              ...current,
              {
                day: "",
                time: "",
                id: Math.max(-1, ...current.map((r) => r.id)) + 1,
              },
            ])
          }
          className={buttonClasses("ghost", "sm")}
        >
          + Add a slot
        </button>
      ) : null}
    </fieldset>
  );
}
