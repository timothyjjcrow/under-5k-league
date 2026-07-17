"use client";

import { pushToast } from "@/components/toaster";
import { cn } from "@/lib/utils";

// Copyable Discord-handle chip. The league coordinates on Discord, so every
// roster surface offers a player's handle one tap from the clipboard.
export function DiscordTag({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  if (!name) return null;
  return (
    <button
      type="button"
      title="Copy Discord handle"
      aria-label={`Copy Discord handle ${name}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(name);
          pushToast("success", `Copied ${name}`);
        } catch {
          pushToast("error", "Couldn't copy — select it manually");
        }
      }}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-[11px] text-info transition-colors hover:bg-info/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        className,
      )}
    >
      <span aria-hidden>🗨</span>
      <span className="truncate">{name}</span>
    </button>
  );
}
