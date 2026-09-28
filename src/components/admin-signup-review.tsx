"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// The "Needs review" view of the admin signup list. The soft MMR limit is a
// review threshold, not a block (over-limit players join the pool), and the
// review it asks for used to have no tool: the flags were scattered through
// a long list. This toggle narrows the list to the signups worth a look
// before the draft (over the soft limit, MMR ≠ medal, blank, no Discord
// link), with each row's MMR edit and remove controls right there.
//
// The rows are rendered on the server (they carry forms and streamed
// Discord chips); this only decides which are shown. Hidden rows stay
// mounted with `hidden`, so toggling never throws away a half-typed MMR edit.

export type SignupReviewRow = {
  key: string;
  needsReview: boolean;
  node: ReactNode;
};

const segment = (active: boolean) =>
  cn(
    "min-h-11 min-w-0 truncate rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-9",
    active ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
  );

export function AdminSignupReview({
  label,
  rows,
  listClassName,
  rowClassName,
}: {
  /** The list's accessible name, matching the heading above it. */
  label: string;
  rows: SignupReviewRow[];
  listClassName?: string;
  rowClassName?: string;
}) {
  const [onlyReview, setOnlyReview] = useState(false);
  const reviewCount = rows.filter((r) => r.needsReview).length;
  // Nothing left to review (or a review emptied the list): show everyone,
  // never an empty list behind a pressed toggle.
  const filtering = onlyReview && reviewCount > 0;
  return (
    <>
      {reviewCount > 0 ? (
        <div className="mb-2">
          <div
            role="group"
            aria-label="Which signups to show"
            className="inline-grid grid-cols-2 gap-1 rounded-lg bg-surface-2/60 p-1"
          >
            <button
              type="button"
              aria-pressed={!filtering}
              onClick={() => setOnlyReview(false)}
              className={segment(!filtering)}
            >
              All ({rows.length})
            </button>
            <button
              type="button"
              aria-pressed={filtering}
              onClick={() => setOnlyReview(true)}
              className={segment(filtering)}
            >
              Needs review ({reviewCount})
            </button>
          </div>
          {filtering ? (
            <p className="mt-1 text-xs text-muted">
              Over the soft MMR limit, MMR ≠ medal, a blank signup, or no
              Discord link. None of these stop anyone joining; they are worth
              a look before the draft.
            </p>
          ) : null}
        </div>
      ) : null}
      <ul aria-label={label} className={listClassName}>
        {rows.map((r) => (
          <li
            key={r.key}
            hidden={filtering && !r.needsReview}
            className={rowClassName}
          >
            {r.node}
          </li>
        ))}
      </ul>
    </>
  );
}
