"use client";

import Link from "next/link";
import { buttonClasses } from "@/components/ui";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-lg py-16">
      <div className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-b from-surface-2/70 to-surface/40">
        <div
          aria-hidden
          className="hero-grid pointer-events-none absolute inset-0 opacity-40"
        />
        <div
          aria-hidden
          className="animate-hero-glow pointer-events-none absolute left-1/2 top-0 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full bg-danger/25 blur-3xl"
        />
        <div className="relative flex flex-col items-center gap-4 px-6 py-12 text-center">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-danger to-danger/60 text-3xl font-bold text-white shadow-lg shadow-danger/30 ring-1 ring-white/15">
            !
          </div>
          <div>
            <div className="font-display text-2xl font-bold">
              Something went wrong
            </div>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">
              {error.message || "An unexpected error occurred."}
            </p>
            {error.digest ? (
              <p className="mt-1.5 font-mono text-[11px] text-muted/70">
                ref: {error.digest}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <button onClick={reset} className={buttonClasses("primary")}>
              Try again
            </button>
            <Link href="/" className={buttonClasses("secondary")}>
              Back to home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
