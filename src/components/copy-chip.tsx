"use client";

import { pushToast } from "@/components/toaster";
import { cn } from "@/lib/utils";

/**
 * A monospace value with a click-to-copy button: a lobby's name, its
 * password, the league ticket. Shared by the inhouse setup card's by-hand
 * steps and the lobby bot's panel, so a value reads and copies the same in
 * both. A long value wraps inside the chip instead of widening the card.
 */
export function CopyChip({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          pushToast("success", `Copied ${label}: ${value}`);
        } catch {
          pushToast("error", "Couldn't copy — select it and copy manually");
        }
      }}
      title={`Copy ${label}`}
      className={cn(
        "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-left font-mono text-sm font-semibold text-fg transition-colors hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-9",
        className,
      )}
    >
      <span className="min-w-0 break-all">{value}</span>
      <span aria-hidden className="shrink-0 text-xs text-muted">
        📋
      </span>
    </button>
  );
}
