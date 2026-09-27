"use client";

import { useEffect, useState, type ReactNode } from "react";
import { SubmitButton } from "@/components/action-form";

/**
 * Pick'em's server remains authoritative, but a page can stay open across the
 * kickoff boundary. This leaf disables itself at that exact client-clock
 * deadline so the visible control does not keep promising an action the server
 * will reject. Match status/phase changes still rely on the server guard.
 */
export function PickemSubmitButton({
  children,
  selected,
  locksAt,
  name,
  value,
}: {
  children: ReactNode;
  selected: boolean;
  /** Epoch milliseconds; null means time TBD and status controls the lock. */
  locksAt: number | null;
  name: string;
  value: string;
}) {
  const [passedAt, setPassedAt] = useState<number | null>(null);
  const deadlinePassed = locksAt != null && passedAt === locksAt;

  useEffect(() => {
    if (locksAt == null) return;
    const remaining = locksAt - Date.now();
    const id = window.setTimeout(
      () => setPassedAt(locksAt),
      Math.max(0, Math.min(remaining, 2_147_483_647)),
    );
    return () => window.clearTimeout(id);
  }, [locksAt]);

  return (
    <SubmitButton
      variant={selected ? "accent" : "secondary"}
      size="sm"
      // A long team name wraps and the button grows with it (min-h keeps the
      // usual size); h-full lets side-by-side buttons match heights.
      className="h-full min-h-10 w-full py-1.5 sm:h-full sm:min-h-8"
      disabled={deadlinePassed}
      aria-pressed={selected}
      name={name}
      value={value}
    >
      {children}
      {deadlinePassed ? (
        <>
          <span aria-hidden className="ml-auto">
            🔒
          </span>
          <span className="sr-only">(predictions locked)</span>
        </>
      ) : null}
    </SubmitButton>
  );
}
