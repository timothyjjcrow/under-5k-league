import { LinkArrow, textLink } from "@/components/ui";
import type { TeamJersey } from "@/lib/team-jerseys";

/**
 * A team's player jerseys: one link per player to their own product, then the
 * whole shop of the team's group. Every link leaves the site in a new tab.
 */
export function TeamJerseyLinks({ jersey }: { jersey: TeamJersey }) {
  return (
    <article className="min-w-0 overflow-hidden rounded-[var(--radius)] border border-line bg-surface shadow-sm shadow-black/10">
      {/* Auto-fit: five links fill one row on a desktop and stack on a phone,
          with no empty track when a set has fewer. */}
      <ul className="grid gap-1.5 p-2 [grid-template-columns:repeat(auto-fit,minmax(min(12rem,100%),1fr))]">
        {jersey.products.map((product) => (
          <li key={product.position} className="min-w-0">
            <a
              href={product.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Shop ${product.player} jersey, position ${product.position}, on Fourthwall (opens in a new tab)`}
              className="flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-fg transition-colors hover:bg-surface-2 hover:text-info focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded bg-surface-2 text-[11px] font-semibold tabular-nums text-muted"
                aria-hidden="true"
              >
                {product.position}
              </span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {product.player}
              </span>
              <span className="shrink-0 text-muted" aria-hidden="true">
                ↗
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p className="border-t border-line-soft px-4 py-3 text-sm">
        <a
          href={jersey.shopUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`All Group ${jersey.group} jerseys on Fourthwall (opens in a new tab)`}
          className={textLink()}
        >
          All Group {jersey.group} jerseys <LinkArrow out />
        </a>
      </p>
    </article>
  );
}
