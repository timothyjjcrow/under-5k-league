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
}: {
  /** Name for the raw datetime-local string (server-side fallback). */
  name: string;
  /** Name for the hidden epoch-ms field the action should prefer. */
  tsName: string;
  id?: string;
  required?: boolean;
  className?: string;
  defaultValue?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    const hidden = hiddenRef.current;
    if (!input || !hidden) return;
    const sync = () => {
      const ms = new Date(input.value).getTime();
      hidden.value = Number.isNaN(ms) ? "" : String(ms);
    };
    sync(); // pick up any defaultValue
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
    const form = input.form;
    form?.addEventListener("submit", sync); // belt and braces
    return () => {
      input.removeEventListener("input", sync);
      input.removeEventListener("change", sync);
      form?.removeEventListener("submit", sync);
    };
  }, []);

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
