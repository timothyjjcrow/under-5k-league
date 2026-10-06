"use client";

import { useState } from "react";
import { pushToast } from "@/components/toaster";
import { buttonClasses } from "@/components/ui";
import { inviteUrl } from "@/lib/invite-credit";

// Copy-the-signup-link button.
//
// The dashboard asks for more players in two places ("5 more for another team"
// in the hero, "5 more would make it 7 full teams" in the card) and, until
// this, offered nobody a way to act on it. The people who can actually answer
// that ask are the players already signed up, and they had nothing to paste.
//
// The URL comes from `window.location.origin` rather than a server-rendered
// prop on purpose: it is then always the host the player is really looking at,
// so a preview deploy, a custom domain and localhost each copy themselves
// instead of whatever SITE_URL happened to be set to at build time.
//
// Bare URL, no pitch text — it unfurls into the site's own link preview in
// Discord, which is a better advert than anything written here, and a message
// someone can add their own words to gets sent more often than a canned one.
//
// A signed-up player passes `refId` (their user id) and the link carries it
// as `?ref=`, the small invite credit (src/lib/invite-credit.ts): a
// brand-new player who signs up through it is announced as invited by them.
export function InviteLink({
  className,
  label = "Copy invite link",
  refId,
}: {
  className?: string;
  label?: string;
  /** The copying player's user id, when they're signed up this season. */
  refId?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={buttonClasses("primary", "md", className)}
      onClick={async () => {
        const url = inviteUrl(window.location.origin, refId);
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          pushToast("success", `Copied ${url}`);
          // Revert the label so the button reads as reusable — a permanently
          // "Copied!" button looks spent, and recruiting is repeat work.
          setTimeout(() => setCopied(false), 2500);
        } catch {
          // Clipboard is permission-gated and refuses outright over plain HTTP.
          // Claiming success there would have someone paste the last thing they
          // actually copied into their team's channel.
          pushToast("error", `Couldn't copy — the link is ${url}`);
        }
      }}
    >
      <span aria-hidden>{copied ? "✓" : "🔗"}</span>
      {copied ? "Copied!" : label}
    </button>
  );
}
