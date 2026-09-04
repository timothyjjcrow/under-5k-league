import type { ReactNode } from "react";

/** Native disclosure keeps the complete server-rendered analysis available. */
export function AnalysisDisclosure({
  title,
  description,
  children,
  id,
}: {
  title: string;
  description: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <details
      id={id}
      className="group scroll-mt-24 rounded-xl border border-line bg-surface/40 open:bg-surface/60"
    >
      <summary className="cursor-pointer rounded-xl px-5 py-4 text-base font-semibold marker:text-muted focus-visible:outline-2 focus-visible:outline-accent">
        {title}
        <span className="mt-1 block text-sm font-normal leading-relaxed text-muted">
          {description}
        </span>
      </summary>
      <div className="space-y-4 border-t border-line-soft p-3 sm:p-5">
        {children}
      </div>
    </details>
  );
}
