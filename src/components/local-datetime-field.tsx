"use client";

// A datetime-local input that also submits the chosen instant as epoch ms.
// The naive "2026-07-15T20:00" string a datetime-local posts is parsed in the
// SERVER's timezone by `new Date(raw)` — on the UTC prod host that shifts
// every captain's chosen time by their whole UTC offset. The browser is the
// only place that knows which instant the user meant, so it converts here.
//
// The hidden field is kept in sync with native event listeners + a submit
// hook rather than React state, so it also catches autofill and any change
// path that bypasses synthetic events.
//
// `timeZone` opts a field into reading and prefilling on a NAMED zone's clock
// instead of the viewer's. Every admin scheduling box passes the league's:
// on the viewer's clock, a Europe admin sitting in Los Angeles who typed 20:00
// scheduled the whole season for 05:00 Berlin time, and every screen they
// checked afterwards also rendered in their own zone and read "20:00". The
// field names the zone beside the box and, when the viewer's clock differs,
// shows what the entry is on theirs.

import { useEffect, useId, useRef } from "react";
import {
  epochToZonedDatetimeLocal,
  yourTimeHint,
  zonedDatetimeLocalToEpoch,
  zoneLabel,
} from "@/lib/zoned-time";

export function LocalDatetimeField({
  name,
  tsName,
  id,
  required,
  className,
  defaultValue,
  defaultTs,
  minTs,
  maxTs,
  describedBy,
  timeZone,
}: {
  /** Name for the raw datetime-local string (server-side fallback). */
  name: string;
  /** Name for the hidden epoch-ms field the action should prefer. */
  tsName: string;
  id?: string;
  required?: boolean;
  className?: string;
  /** Prefill as a raw datetime-local string — only safe when the string was
   *  produced in the zone the field reads (the viewer's, or `timeZone`).
   *  Prefer defaultTs. */
  defaultValue?: string;
  /** Prefill from an epoch — formatted into the input client-side, in the
   *  zone the field reads (the viewer's, or `timeZone`). A server-formatted defaultValue string would be the
   *  server's wall clock: resubmitting an untouched form on the UTC prod
   *  host would silently shift the stored time by the viewer's UTC offset. */
  defaultTs?: number | null;
  /** Earliest / latest instant the browser lets the viewer submit, as epochs.
   *  Formatted client-side in the zone the field reads, like defaultTs. The
   *  server still checks; these only stop an obviously refused time early. */
  minTs?: number | null;
  maxTs?: number | null;
  /** Id of a hint that explains the allowed range, for screen readers. */
  describedBy?: string;
  /** Opt-in: an IANA zone (the league's) whose clock the field reads and
   *  prefills on, labelled beside the box. Omitted = the viewer's own clock,
   *  exactly as before. */
  timeZone?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const hintRef = useRef<HTMLSpanElement>(null);
  const zoneId = useId();
  const hintId = useId();
  // What the field held at the last submit. Distinguishes "the form reset
  // itself after a successful save" (restore the prefill) from "the user
  // deliberately emptied the field to clear the time" (leave it empty).
  const submittedEmptyRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    const hidden = hiddenRef.current;
    if (!input || !hidden) return;
    // The prefill is applied IMPERATIVELY (not as a defaultValue attribute)
    // because only the browser can render the instant in the viewer's zone.
    // Minute precision: a seconds-precise `min` would become the step base
    // and mark every whole-minute entry as invalid.
    const toInputValue = (ms: number) => {
      if (timeZone) return epochToZonedDatetimeLocal(ms, timeZone);
      const d = new Date(ms);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const applyPrefill = () => {
      if (defaultTs == null || input.value) return;
      input.value = toInputValue(defaultTs);
    };
    if (minTs != null) input.min = toInputValue(minTs);
    else input.removeAttribute("min");
    if (maxTs != null) input.max = toInputValue(maxTs);
    else input.removeAttribute("max");
    applyPrefill();
    const hint = hintRef.current;
    // The viewer's own zone, only needed for the "your time" line.
    const viewerZone = timeZone
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : undefined;
    const sync = () => {
      const ms = timeZone
        ? (zonedDatetimeLocalToEpoch(input.value, timeZone) ?? NaN)
        : new Date(input.value).getTime();
      hidden.value = Number.isNaN(ms) ? "" : String(ms);
      if (hint && timeZone) {
        const text =
          viewerZone && !Number.isNaN(ms)
            ? yourTimeHint(ms, timeZone, viewerZone, undefined)
            : null;
        hint.textContent = text ?? "";
        hint.hidden = !text;
      }
    };
    sync(); // pick up any prefill
    // <ActionForm> calls form.reset() after a successful save. Because the
    // prefill above lives in the VALUE and not in a defaultValue attribute,
    // reset() blanks the field — and `localDate` reads a blank raw input as an
    // explicit "clear", so the very next submit of the same form would write
    // null over a perfectly good time (double-clicking Save was enough).
    // Re-apply the prefill once the reset has actually landed.
    const onReset = () => {
      // An intentional clear must stay cleared — only restore a value the user
      // actually submitted.
      if (submittedEmptyRef.current) return;
      queueMicrotask(() => {
        applyPrefill();
        sync();
      });
    };
    const onSubmit = () => {
      submittedEmptyRef.current = !input.value;
      sync();
    };
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
    const form = input.form;
    form?.addEventListener("submit", onSubmit); // belt and braces
    form?.addEventListener("reset", onReset);
    return () => {
      input.removeEventListener("input", sync);
      input.removeEventListener("change", sync);
      form?.removeEventListener("submit", onSubmit);
      form?.removeEventListener("reset", onReset);
    };
  }, [defaultTs, minTs, maxTs, timeZone]);

  if (!timeZone) {
    return (
      <>
        <input
          ref={inputRef}
          type="datetime-local"
          id={id}
          name={name}
          required={required}
          defaultValue={defaultValue}
          className={className}
          aria-describedby={describedBy}
        />
        <input ref={hiddenRef} type="hidden" name={tsName} defaultValue="" />
      </>
    );
  }
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1">
      <input
        ref={inputRef}
        type="datetime-local"
        id={id}
        name={name}
        required={required}
        defaultValue={defaultValue}
        className={className}
        aria-describedby={[zoneId, hintId, describedBy]
          .filter(Boolean)
          .join(" ")}
      />
      <input ref={hiddenRef} type="hidden" name={tsName} defaultValue="" />
      <span id={zoneId} className="text-xs text-muted">
        {zoneLabel(timeZone)}
      </span>
      {/* Filled in the browser: only it knows the viewer's zone. */}
      <span id={hintId} ref={hintRef} className="text-xs text-muted" />
    </span>
  );
}
