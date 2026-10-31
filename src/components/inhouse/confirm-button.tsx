"use client";

import { useEffect, useRef, useState } from "react";
import { buttonClasses } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * A control that asks before it acts, in place: the first tap swaps it for
 * the question and two answers, the second does it. The room's own confirm
 * (it replaced `window.confirm`, which froze the page, its clocks and its
 * polls while open, and on a phone covered the room). Escape or the cancel
 * answer puts the control back, and focus follows: onto the answer named by
 * `focus` while asking, back onto the control after.
 */
export function ConfirmButton({
  label,
  className,
  disabled = false,
  prompt,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  focus = "cancel",
  danger = false,
  promptClassName,
}: {
  /** The control's words; also the question's group name. */
  label: React.ReactNode;
  /** The control's classes (it is one button until pressed). */
  className?: string;
  disabled?: boolean;
  prompt: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** Which answer takes focus: the safe one for anything with no undo. */
  focus?: "confirm" | "cancel";
  danger?: boolean;
  /** Extra classes for the question's box (its alignment in a card). */
  promptClassName?: string;
}) {
  const [asking, setAsking] = useState(false);
  const controlRef = useRef<HTMLButtonElement>(null);
  const answerRef = useRef<HTMLButtonElement>(null);
  const askedRef = useRef(false);
  useEffect(() => {
    if (asking) answerRef.current?.focus();
    else if (askedRef.current) controlRef.current?.focus();
    askedRef.current = asking;
  }, [asking]);

  if (!asking) {
    return (
      <button
        ref={controlRef}
        type="button"
        disabled={disabled}
        onClick={() => setAsking(true)}
        className={className}
      >
        {label}
      </button>
    );
  }
  return (
    <div
      role="group"
      aria-label={typeof label === "string" ? label : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape") setAsking(false);
      }}
      className={cn(
        "min-w-0 rounded-xl border border-line bg-surface-2/70 p-3 text-left",
        promptClassName,
      )}
    >
      <p className="text-sm text-fg">{prompt}</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button
          ref={focus === "confirm" ? answerRef : undefined}
          type="button"
          disabled={disabled}
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
          className={buttonClasses(danger ? "danger" : "accent", "sm")}
        >
          {confirmLabel}
        </button>
        <button
          ref={focus === "cancel" ? answerRef : undefined}
          type="button"
          onClick={() => setAsking(false)}
          className={buttonClasses("secondary", "sm")}
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
