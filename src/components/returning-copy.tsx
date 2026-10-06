"use client";

// One click on /admin → the returning-player reminder is on the clipboard,
// built at click time with window.location.origin (the InviteLink rule).
// Same shape as ChaseCopy: the admin's paste is the send, so the site never
// mass-mentions anyone by itself.

import { useState } from "react";
// returning-players, never the service: that one imports prisma, and this is
// a client bundle.
import {
  returningReminderMessage,
  type ReturningPlayers,
} from "@/lib/returning-players";
import { pushToast } from "@/components/toaster";
import { buttonClasses } from "@/components/ui";

export function ReturningCopy({
  players,
  seasonName,
  signedUp,
}: {
  players: ReturningPlayers;
  seasonName: string;
  signedUp: number;
}) {
  const [copied, setCopied] = useState(false);
  // Clipboard access can be denied; the fallback renders the text.
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className={buttonClasses("secondary", "sm")}
        onClick={async () => {
          const text = returningReminderMessage(players, {
            seasonName,
            signedUp,
            signupUrl: `${window.location.origin}/me`,
          });
          if (!text) return;
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setFallbackText(null);
            pushToast("success", "Reminder copied — paste it into Discord.");
          } catch {
            setFallbackText(text);
            pushToast("error", "Clipboard blocked — select and copy the text below.");
          }
        }}
      >
        {copied ? "Copied ✓" : "Copy returning-player reminder"}
      </button>
      {fallbackText !== null ? (
        <textarea
          readOnly
          value={fallbackText}
          rows={6}
          className="mt-1 w-full rounded-lg border border-line bg-surface-2/50 px-3 py-2 font-mono text-xs"
          aria-label="Returning-player reminder — select and copy"
          onFocus={(e) => e.currentTarget.select()}
        />
      ) : null}
    </>
  );
}
