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

import { useEffect, useRef } from "react";

export function LocalDatetimeField({
  name,
  tsName,
  id,
  required,
  className,
  defaultValue,
  defaultTs,
}: {
  /** Name for the raw datetime-local string (server-side fallback). */
  name: string;
  /** Name for the hidden epoch-ms field the action should prefer. */
  tsName: string;
  id?: string;
  required?: boolean;
  className?: string;
  /** Prefill as a raw datetime-local string — only safe when the string was
   *  produced in the VIEWER's timezone. Prefer defaultTs. */
  defaultValue?: string;
  /** Prefill from an epoch — formatted into the input client-side, in the
   *  viewer's timezone. A server-formatted defaultValue string would be the
   *  server's wall clock: resubmitting an untouched form on the UTC prod
   *  host would silently shift the stored time by the viewer's UTC offset. */
  defaultTs?: number | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
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
    const applyPrefill = () => {
      if (defaultTs == null || input.value) return;
      const d = new Date(defaultTs);
      const pad = (n: number) => String(n).padStart(2, "0");
      input.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    applyPrefill();
    const sync = () => {
      const ms = new Date(input.value).getTime();
      hidden.value = Number.isNaN(ms) ? "" : String(ms);
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
  }, [defaultTs]);

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
      />
      <input ref={hiddenRef} type="hidden" name={tsName} defaultValue="" />
    </>
  );
}
