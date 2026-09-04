import type { ReactNode } from "react";

/** Native disclosure keeps the complete server-rendered analysis available. */
export function AnalysisDisclosure({
  title,
  description,
  children,
  id,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <details
      id={id}
      className="group scroll-mt-24 rounded-xl border border-line bg-surface/40 open:bg-surface/60"
    >
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-5 py-4 text-sm font-semibold transition-colors hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <span>
          {title}
          {description ? (
            <span className="mt-1 block text-xs font-normal leading-relaxed text-muted">
              {description}
            </span>
          ) : null}
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5 shrink-0 text-muted transition-transform group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="space-y-4 border-t border-line-soft p-3 sm:p-5">
        {children}
      </div>
    </details>
  );
}
