import { LEAGUE_CONFIG } from "@/lib/league-config";
import { cn } from "@/lib/utils";

export function MerchLink({ className }: { className?: string }) {
  return (
    <a
      href={LEAGUE_CONFIG.merchUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Merch — GGD2L shop (opens in a new tab)"
      className={cn(
        "group inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-line bg-surface/40 px-3 text-sm font-medium text-muted transition-colors hover:border-accent/40 hover:bg-accent/5 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 lg:min-h-10",
        className,
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4 shrink-0 text-accent/80"
      >
        <path d="m16 3 6 4-3 5-3-2v11H8V10l-3 2-3-5 6-4a4 4 0 0 0 8 0Z" />
      </svg>
      <span>Merch</span>
      <span
        aria-hidden="true"
        className="ml-auto pl-1 text-xs text-muted/70 group-hover:text-fg"
      >
        ↗
      </span>
    </a>
  );
}
