"use client";

import { useState } from "react";
import { pushToast } from "@/components/toaster";
import { buttonClasses } from "@/components/ui";

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
export function InviteLink({
  className,
  label = "Copy invite link",
}: {
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={buttonClasses("primary", "md", className)}
      onClick={async () => {
        const url = window.location.origin;
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
