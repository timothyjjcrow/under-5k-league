"use client";

// One click on the admin funnel → the chase post is on the clipboard. The
// site structurally cannot notify the people this card names (unlinked = no
// mention target; not-in-server = mentions land nowhere), so the last mile is
// an admin pasting into Discord — this removes the transcription step.
//
// The message is BUILT AT CLICK TIME with window.location.origin (the
// InviteLink rule: previews and custom domains must copy themselves, never a
// server-rendered origin).

import { useState } from "react";
// discord-reach, NEVER discord-roles: that module imports prisma, and this is
// a client bundle — importing it here shipped Prisma's browser stub (model
// and column maps included) in a public static chunk. A source guard
// (client-boundary-guards.test.ts) pins this import now.
import {
  discordChaseMessage,
  type DiscordReachFunnel,
} from "@/lib/discord-reach";
import { DISCORD_INVITE_URL } from "@/lib/constants";
import { pushToast } from "@/components/toaster";
import { buttonClasses } from "@/components/ui";

export function ChaseCopy({ reach }: { reach: DiscordReachFunnel }) {
  const [copied, setCopied] = useState(false);
  // Clipboard access can be denied (permissions policy, odd browsers). The
  // fallback has to RENDER the text — a toast saying "copy manually" with the
  // message rendered nowhere hands the admin an instruction they cannot
  // follow.
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className={buttonClasses("secondary", "sm")}
        disabled={!DISCORD_INVITE_URL && Boolean(reach.guild?.missing)}
        title={!DISCORD_INVITE_URL && reach.guild?.missing ? "Configure this league's Discord invite before copying the join message." : undefined}
        onClick={async () => {
          const text = discordChaseMessage(reach, {
            inviteUrl: DISCORD_INVITE_URL,
            profileUrl: `${window.location.origin}/me`,
          });
          if (!text) return; // parent only renders us when there's someone to chase
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setFallbackText(null);
            pushToast("success", "Chase message copied — paste it into Discord.");
          } catch {
            setFallbackText(text);
            pushToast("error", "Clipboard blocked — select and copy the text below.");
          }
        }}
      >
        {copied ? "Copied ✓" : "Copy chase message"}
      </button>
      {fallbackText !== null ? (
        <textarea
          readOnly
          value={fallbackText}
          rows={6}
          className="mt-1 w-full rounded-lg border border-line bg-surface-2/50 px-3 py-2 font-mono text-xs"
          aria-label="Chase message — select and copy"
          onFocus={(e) => e.currentTarget.select()}
        />
      ) : null}
    </>
  );
}
