"use client";

import { useRef, useState } from "react";
import { proposeReschedule } from "@/app/actions/reschedule";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { LocalTime } from "@/components/local-time";
import { pushToast } from "@/components/toaster";
import { buttonClasses } from "@/components/ui";
import {
  MAX_RESCHEDULE_OPTIONS,
  RESCHEDULE_NOTE_MAX,
  customTimePrefill,
} from "@/lib/reschedule-ready-check";
import { matchTimeParts } from "@/lib/match-time";
import { cn } from "@/lib/utils";
import { TimeStack, type TimeParts } from "./time-chip";

export type ProposeTimesProps = {
  matchId: string;
  /** Quick picks that fit the calendar (suggestRescheduleTimes), each with
   *  the server's parts as its hydration snapshot. */
  suggestions: { ts: number; parts: TimeParts }[];
  /** Earliest / latest instants the custom picker allows. */
  minTs: number;
  maxTs: number | null;
  /** The playoff deadline, for the rule line; null when there is none. */
  deadline: { ts: number; label: string } | null;
  clashHours: number;
  /** Prefill for the custom picker (the current kickoff). */
  kickoffMs: number | null;
};

/**
 * Pick up to three times and send them as a ready check. Quick picks are one
 * tap; any other time goes through the picker on the viewer's own clock.
 * Sending replaces any open proposal (the service supersedes it).
 */
export function ProposeTimes({
  matchId,
  suggestions,
  minTs,
  maxTs,
  deadline,
  clashHours,
  kickoffMs,
  submitLabel = "Send ready check",
  onCancel,
}: ProposeTimesProps & {
  submitLabel?: string;
  /** Shown as "Never mind" beside submit, for an inline counter-proposal. */
  onCancel?: () => void;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const customRef = useRef<HTMLDivElement>(null);
  const full = picked.length >= MAX_RESCHEDULE_OPTIONS;
  const hintId = `propose-hint-${matchId}`;
  const customId = `propose-custom-${matchId}`;
  const partsOf = new Map(suggestions.map((s) => [s.ts, s.parts]));

  const toggle = (ts: number) =>
    setPicked((current) =>
      current.includes(ts)
        ? current.filter((t) => t !== ts)
        : current.length >= MAX_RESCHEDULE_OPTIONS
          ? current
          : [...current, ts].sort((a, b) => a - b),
    );

  const addCustom = () => {
    const raw = customRef.current?.querySelector<HTMLInputElement>(
      'input[name="customTs"]',
    )?.value;
    const ts = raw ? Number(raw) : NaN;
    if (!Number.isFinite(ts) || ts <= 0) {
      pushToast("error", "Pick a date and time first.");
      return;
    }
    if (ts < Date.now()) {
      pushToast("error", "That time is in the past.");
      return;
    }
    if (maxTs != null && ts > maxTs) {
      pushToast("error", "That's after the playoffs start — pick an earlier time.");
      return;
    }
    if (kickoffMs === ts) {
      pushToast("error", "That's already this match's kickoff.");
      return;
    }
    if (picked.includes(ts)) return;
    if (full) {
      pushToast("error", `Offer at most ${MAX_RESCHEDULE_OPTIONS} times.`);
      return;
    }
    setPicked((current) => [...current, ts].sort((a, b) => a - b));
  };

  return (
    <ActionForm
      action={proposeReschedule}
      hidden={{ matchId }}
      className="space-y-4"
    >
      {picked.map((ts) => (
        <input key={ts} type="hidden" name="optionTs" value={String(ts)} />
      ))}

      {suggestions.length > 0 ? (
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted">
            Quick picks <span className="font-normal normal-case">· your time</span>
          </legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {suggestions.map(({ ts, parts }) => {
              const on = picked.includes(ts);
              return (
                <button
                  key={ts}
                  type="button"
                  aria-pressed={on}
                  disabled={!on && full}
                  onClick={() => toggle(ts)}
                  className={cn(
                    "relative min-w-0 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40",
                    on
                      ? "border-accent bg-accent/15"
                      : "border-line bg-surface-2/50 hover:border-muted/60",
                  )}
                >
                  <TimeStack ts={ts} initial={parts} />
                  {on ? (
                    <span
                      aria-hidden
                      className="ready-pop absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-xs font-bold text-black"
                    >
                      ✓
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div ref={customRef} className="min-w-0 space-y-1.5">
        <label
          htmlFor={customId}
          className="block text-xs font-semibold uppercase tracking-wide text-muted"
        >
          {suggestions.length ? "Or any time" : "Pick a time"}{" "}
          <span className="font-normal normal-case">· your time</span>
        </label>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <LocalDatetimeField
            id={customId}
            name="customTime"
            tsName="customTs"
            defaultTs={customTimePrefill(kickoffMs, minTs, maxTs)}
            minTs={minTs}
            maxTs={maxTs}
            describedBy={hintId}
            className="h-10 min-w-0 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-sm text-fg"
          />
          <button
            type="button"
            onClick={addCustom}
            disabled={full}
            className={buttonClasses("secondary", "sm")}
          >
            + Add time
          </button>
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          Your options{" "}
          <span className="tabular-nums">
            ({picked.length}/{MAX_RESCHEDULE_OPTIONS})
          </span>
        </p>
        {picked.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-muted">
            Tap up to {MAX_RESCHEDULE_OPTIONS} times. More options, better odds
            everyone can make one.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {picked.map((ts) => (
              <li
                key={ts}
                className="ready-pop inline-flex min-w-0 items-center gap-2 rounded-full border border-accent/50 bg-accent/10 py-1 pl-3 pr-1 text-sm"
              >
                <LocalTime
                  ts={ts}
                  variant="full"
                  initial={partsLine(partsOf.get(ts), ts)}
                />
                <button
                  type="button"
                  onClick={() => toggle(ts)}
                  aria-label="Remove this time"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span aria-hidden>×</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-w-0 space-y-1.5">
        <label
          htmlFor={`propose-note-${matchId}`}
          className="block text-xs font-semibold uppercase tracking-wide text-muted"
        >
          Note <span className="font-normal normal-case">· optional</span>
        </label>
        <input
          id={`propose-note-${matchId}`}
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={RESCHEDULE_NOTE_MAX}
          placeholder="Why the move? e.g. two of us have exams Sunday"
          className="h-10 w-full min-w-0 rounded-md border border-line bg-surface-2/50 px-3 text-sm text-fg placeholder:text-muted/70"
        />
        <p className="text-right text-xs tabular-nums text-muted">
          {note.length}/{RESCHEDULE_NOTE_MAX}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant="accent" disabled={picked.length === 0}>
          {submitLabel}
          {picked.length > 1 ? ` (${picked.length} times)` : ""}
        </SubmitButton>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className={buttonClasses("ghost", "md")}
          >
            Never mind
          </button>
        ) : null}
      </div>
      <p id={hintId} className="text-xs text-muted">
        Everyone on both teams gets a ✓/✗ ready check. The match moves the
        moment both captains and a full lineup on each side are in.{" "}
        {deadline ? (
          <>
            Times must be before{" "}
            <LocalTime ts={deadline.ts} variant="full" initial={deadline.label} />{" "}
            (the playoffs) and not within {clashHours} hours of another match
            or scrim for either team.
          </>
        ) : (
          `Times can't be within ${clashHours} hours of another match or scrim for either team.`
        )}
      </p>
    </ActionForm>
  );
}

/** A picked time's server-side "full" fallback, built from its chip parts. */
function partsLine(parts: TimeParts | undefined, ts: number): string {
  const p = parts ?? matchTimeParts(new Date(ts));
  return `${p.day}, ${p.date}, ${p.time}`;
}
