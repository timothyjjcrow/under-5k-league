"use client";

import { pushToast } from "@/components/toaster";
import { cn } from "@/lib/utils";

// Copyable Discord-handle chip. The league coordinates on Discord, so every
// roster surface offers a player's handle one tap from the clipboard.
// `verified` = the handle came from the Discord OAuth link (proven account
// ownership), not typed by hand — captains can trust it's really them.
export function DiscordTag({
  name,
  verified = false,
  className,
}: {
  name: string;
  verified?: boolean;
  className?: string;
}) {
  if (!name) return null;
  return (
    <button
      type="button"
      title={verified ? "Copy Discord handle (verified)" : "Copy Discord handle"}
      aria-label={`Copy Discord handle ${name}${verified ? " (verified)" : ""}`}
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
      {verified ? (
        <span aria-hidden className="text-success">
          ✓
        </span>
      ) : null}
    </button>
  );
}
