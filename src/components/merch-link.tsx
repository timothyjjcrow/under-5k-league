import { LEAGUE_CONFIG } from "@/lib/league-config";
import { cn } from "@/lib/utils";

/** The jersey mark every Merch control carries. */
export function MerchIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("h-4 w-4 shrink-0 text-accent/80", className)}
    >
      <path d="m16 3 6 4-3 5-3-2v11H8V10l-3 2-3-5 6-4a4 4 0 0 0 8 0Z" />
    </svg>
  );
}

/**
 * One link per league shop (`LEAGUE_CONFIG.merch.shops`), each opening in a
 * new tab. `menu` is the row style inside the header's Merch dropdown;
 * `button` is the bordered, full-width style of the phone menu, where each
 * link names Merch itself because nothing above it does.
 */
export function MerchShopLinks({
  variant,
  onNavigate,
}: {
  variant: "menu" | "button";
  onNavigate?: () => void;
}) {
  return (
    <>
      {LEAGUE_CONFIG.merch.shops.map((shop) => (
        <a
          key={shop.group}
          href={shop.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onNavigate}
          aria-label={`Merch — ${shop.label} (opens in a new tab)`}
          className={cn(
            "group flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
            variant === "menu"
              ? "text-muted hover:bg-surface-2 hover:text-fg focus-visible:ring-inset"
              : "w-full border border-line bg-surface/40 font-medium text-muted hover:border-accent/40 hover:bg-accent/5 hover:text-fg",
          )}
        >
          {variant === "button" ? <MerchIcon /> : null}
          <span className="min-w-0">
            {variant === "button" ? `Merch · ${shop.label}` : shop.label}
          </span>
          <span
            aria-hidden="true"
            className="ml-auto pl-1 text-xs text-muted/70 group-hover:text-fg"
          >
            ↗
          </span>
        </a>
      ))}
    </>
  );
}
