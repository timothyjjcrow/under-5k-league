"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Saved answers stay available without dominating every profile visit. */
export function SavedSignupForm({
  saved,
  summary,
  children,
}: {
  saved: boolean;
  /** What was submitted, in one line ("Full player · 3200 MMR · Mid"), so
   *  the collapsed row answers "what did I put?" without opening the form. */
  summary?: string;
  children: ReactNode;
}) {
  // Preserve the open editor after a first successful signup or revalidation.
  // Returning to the page later starts with the saved answers collapsed.
  const [open, setOpen] = useState(!saved);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const details = detailsRef.current;
    if (!details) return;
    // If someone closes the editor while an action is in flight, reveal its
    // inline error when it arrives. ActionForm keeps the original answers.
    const observer = new MutationObserver(() => {
      const error = details.querySelector<HTMLElement>('form [tabindex="-1"]');
      if (error && !details.open) {
        details.open = true;
        setOpen(true);
        error.focus();
      }
    });
    observer.observe(details, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <details
      id="signup-details"
      ref={detailsRef}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onInvalidCapture={(event) => {
        // Native validation may target an optional field inside closed details.
        let parent: HTMLElement | null = event.target as HTMLElement;
        while (parent) {
          if (parent instanceof HTMLDetailsElement) parent.open = true;
          parent = parent.parentElement;
        }
        setOpen(true);
      }}
      className={
        saved
          ? "group rounded-lg border border-line bg-surface-2/20"
          : undefined
      }
    >
      <summary
        className={
          saved
            ? "flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden"
            : "hidden"
        }
      >
        <span className="min-w-0">
          <span className="block">Edit signup</span>
          {summary ? (
            <span className="block text-xs font-normal text-muted">
              {summary}
            </span>
          ) : null}
        </span>
        <span
          aria-hidden
          className="shrink-0 text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none"
        >
          ⌄
        </span>
      </summary>
      <div className={saved ? "border-t border-line p-4" : undefined}>
        {children}
      </div>
    </details>
  );
}
