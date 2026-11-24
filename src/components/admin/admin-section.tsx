import { SectionReady } from "@/components/section-nav";
import { cn } from "@/lib/utils";

/**
 * The admin page is 13 cards in one column — 6,948px on a desktop and 11,501px
 * on a phone, the longest page in the app by 36%. Two things fix that without
 * hiding a single control:
 *
 *  - every card is an anchor target, and `AdminJump` puts them one tap away;
 *  - the cards an admin touches ONCE (wire up Discord, set the league id, write
 *    news, break glass, open next season) render collapsed.
 *
 * `AdminSection` is the collapsed form. The title stays in the `<summary>`, so
 * it is still a visible heading when shut — which matters for both a scanning
 * admin and the e2e checks that assert those headings render.
 */
export function AdminSection({
  id,
  title,
  subtitle,
  children,
  defaultOpen = false,
  headingLevel = 3,
}: {
  /** Omit when a wrapping AdminAnchor already carries the section's id. */
  id?: string;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** 2 for a section that stands in for top-level cards (the season record). */
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <details
      id={id}
      data-section-jump
      open={defaultOpen}
      className="group scroll-mt-40 lg:scroll-mt-56 rounded-[var(--radius)] border border-line bg-surface/80 shadow-sm backdrop-blur"
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <SectionReady />
        {/* Set like CardHeader's title and subtitle (padding, sizes), so a
            folded section and an open card read as the same kind of heading
            and their titles share one left edge. */}
        <div className="min-w-0">
          <Heading className="text-[0.9375rem] font-semibold leading-snug text-fg [overflow-wrap:anywhere]">
            {title}
          </Heading>
          {subtitle ? (
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted [overflow-wrap:anywhere]">
              {subtitle}
            </p>
          ) : null}
        </div>
        <span
          aria-hidden
          className="shrink-0 text-muted transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="border-t border-line">{children}</div>
    </details>
  );
}

/** Anchor target + header offset for a card that keeps its own frame. */
export function AdminAnchor({
  id,
  className,
  children,
}: {
  id: string;
  /** Spacing for an anchor that wraps more than one card. */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className={cn("scroll-mt-40 lg:scroll-mt-56", className)}>
      {children}
    </div>
  );
}
