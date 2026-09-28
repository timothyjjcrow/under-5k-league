"use client";

import { useId, useState } from "react";

/**
 * Hidden-until-asked tail of a list. The children stay in the page (just
 * hidden), and the toggle sits under them so the list keeps its order.
 */
export function ShowMore({
  showLabel,
  hideLabel,
  children,
}: {
  /** "Show all 9 series". */
  showLabel: string;
  hideLabel: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <div id={id} hidden={!open}>
        {children}
      </div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="min-h-11 w-full border-t border-line-soft bg-surface-2/20 px-5 py-2 text-center text-xs font-medium text-muted transition-colors hover:bg-surface-2/60 hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
      >
        {open ? `${hideLabel} ↑` : `${showLabel} ↓`}
      </button>
    </>
  );
}
