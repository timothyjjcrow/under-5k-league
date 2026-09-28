"use client";

import { useEffect, useRef, useState } from "react";
import { HARD_MMR_CEILING } from "@/lib/constants";
import { mmrPreviewLine } from "@/lib/account-page";
import { cn } from "@/lib/utils";

/**
 * The signup form's MMR box plus a "You'll be listed at …" line that follows
 * what the player types. The line is DISPLAY ONLY: saveRegistration still
 * judges the raw claim, clamps it to the medal and reports what it stored.
 * The input stays uncontrolled so the form's own reset and FormData work as
 * before; the line re-reads the box after a reset.
 */
export function MmrField({
  defaultValue,
  rankTier,
  storedMmr,
  frozen,
  describedBy,
}: {
  defaultValue: string;
  rankTier: number | null;
  storedMmr: number | null;
  frozen: boolean;
  /** Id of the lead line above the box. */
  describedBy?: string;
}) {
  const [typed, setTyped] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    // "reset" fires before the fields are reset, so read the box a tick later.
    const onReset = () => {
      setTimeout(() => {
        if (inputRef.current) setTyped(inputRef.current.value);
      }, 0);
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  const preview = mmrPreviewLine({ typed, rankTier, storedMmr, frozen });
  return (
    <>
      <input
        ref={inputRef}
        id="mmr"
        name="mmr"
        type="number"
        // min=1: a typed 0 fails native validation, while BLANK stays
        // allowed — 0 is the stored "unknown" sentinel, never typed.
        min={1}
        max={HARD_MMR_CEILING}
        defaultValue={defaultValue}
        placeholder="e.g. 3200"
        aria-describedby={
          [describedBy, preview ? "mmr-preview" : null]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onChange={(event) => setTyped(event.currentTarget.value)}
        className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
      />
      {preview ? (
        <p
          id="mmr-preview"
          className={cn(
            "mt-1 text-xs",
            preview.tone === "danger" ? "text-danger" : "font-medium text-fg",
          )}
        >
          {preview.text}
        </p>
      ) : null}
    </>
  );
}
