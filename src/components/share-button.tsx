"use client";

import { useState } from "react";
import { pushToast } from "@/components/toaster";
import { textLink } from "@/components/ui";
import { shareCancelled, shareMethod, shareUrl } from "@/lib/share-link";
import { cn } from "@/lib/utils";

// The Share control on match, team and player pages, beside the page's back
// link. A phone opens its share sheet; a mouse copies the link. Either way the
// link unfurls in Discord into the page's own preview picture (the
// opengraph-image beside each page), so no text is added to it.
//
// The address comes from window.location.origin, like InviteLink: a preview
// deploy, a custom domain and localhost each share themselves.
export function ShareButton({
  path,
  title,
  className,
}: {
  /** The page's path ("/matches/abc"). */
  path: string;
  /** The share sheet's title: the page's link preview title. */
  title: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      pushToast("success", "Link copied. Paste it in Discord to show its preview.");
      // Back to "Share" so the control reads as reusable.
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access is permission-gated and refused over plain HTTP.
      pushToast("error", `Couldn't copy — the link is ${url}`);
    }
  }

  return (
    <button
      type="button"
      className={cn(textLink("inline-flex items-center gap-1.5 text-sm"), className)}
      onClick={async () => {
        const url = shareUrl(window.location.origin, path);
        const method = shareMethod({
          canShare: typeof navigator.share === "function",
          coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
        });
        if (method === "sheet") {
          try {
            await navigator.share({ title, url });
            return;
          } catch (error) {
            if (shareCancelled(error)) return;
            // The sheet refused (a permission policy, an unsupported target):
            // copying still gets the link out.
          }
        }
        await copy(url);
      }}
    >
      {copied ? (
        <span aria-hidden="true">✓</span>
      ) : (
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-4"
        >
          <path d="M10 12.5V3.5M6.5 7 10 3.5 13.5 7" />
          <path d="M5.5 10.5H5a1.5 1.5 0 0 0-1.5 1.5v3.5A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5h-.5" />
        </svg>
      )}
      {copied ? "Copied" : "Share"}
    </button>
  );
}
