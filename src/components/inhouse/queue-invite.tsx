"use client";

import { useState } from "react";
import { pushToast } from "@/components/toaster";
import { buttonClasses } from "@/components/ui";
import { INHOUSE_QUEUE_INVITE_PATH } from "@/lib/inhouse-queue-invite";

/**
 * The queue's invite, under the queue card (Tim, 2026-10-19): "Copy invite
 * link" copies the link that joins whoever opens it to the queue in one tap
 * (INHOUSE_QUEUE_INVITE_PATH), for anyone to paste in Discord or anywhere
 * else; it unfurls as the queue, showing how full it is. The address comes
 * from `window.location.origin` at click time, so a preview, a custom domain
 * and localhost each copy themselves, as the night's invite does.
 */
export function QueueInvite() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 px-1 text-center text-xs text-muted">
      <span>Bring friends: the link puts them in the queue in one tap.</span>
      <button
        type="button"
        className={buttonClasses("secondary", "sm")}
        onClick={async () => {
          const url = `${window.location.origin}${INHOUSE_QUEUE_INVITE_PATH}`;
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            pushToast(
              "success",
              `Copied ${url}: paste it in Discord and it shows the queue. Opening it joins.`,
            );
            setTimeout(() => setCopied(false), 2500);
          } catch {
            // Clipboard access is permission-gated; never claim a copy that
            // didn't happen.
            pushToast("error", `Couldn't copy: the invite link is ${url}`);
          }
        }}
      >
        <span aria-hidden>{copied ? "✓" : "🔗"}</span>
        {copied ? "Copied!" : "Copy invite link"}
      </button>
    </div>
  );
}
