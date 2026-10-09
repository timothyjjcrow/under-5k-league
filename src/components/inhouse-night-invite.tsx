"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, useState } from "react";
import { setInhouseNightRsvpAction } from "@/app/actions/inhouse-night-rsvp";
import { pushToast } from "@/components/toaster";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "@/components/ui";
import {
  INHOUSE_NIGHT_INVITE_PATH,
  type InhouseNightInviteAction,
} from "@/lib/inhouse-night";

// The inhouse night's invite link (INHOUSE_NIGHT_INVITE_PATH) on the page it
// opens: the one-time "I'm in" it asks for, and the button that copies it.

/**
 * Answers the invite once: says "I'm in" for a signed-in player not yet on
 * the list, or says they already are. The server decides which
 * (inhouseNightInviteAction); this only acts. It scrubs `imin` from the
 * address first, so a refresh or a shared copy of this tab never signs anyone
 * up again (the queue's `?join=1` works the same way), then refreshes the
 * page itself once the answer is in: called from an effect during hydration
 * rather than a form, the action's own revalidation never reached the page,
 * and the toggle stayed unpressed. A lost answer is unknown, never failed:
 * the card shows the truth on the next load.
 */
export function InhouseNightInviteRsvp({
  nightId,
  action,
}: {
  nightId: string;
  action: InhouseNightInviteAction;
}) {
  const answered = useRef(false);
  const router = useRouter();
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("imin")) {
      url.searchParams.delete("imin");
      window.history.replaceState(null, "", url);
    }
    if (answered.current) return;
    answered.current = true;
    if (action === "already-in") {
      pushToast("info", "You're already in for this inhouse night.");
      return;
    }
    if (action !== "rsvp") return;
    const form = new FormData();
    form.set("nightId", nightId);
    form.set("going", "1");
    startTransition(async () => {
      try {
        const result = await setInhouseNightRsvpAction(null, form);
        if (result?.error) pushToast("error", result.error);
        else if (result?.message) pushToast("success", result.message);
        router.refresh();
      } catch {
        pushToast(
          "error",
          "The connection dropped before we could confirm. The inhouse night card shows whether you're in.",
        );
      }
    });
  }, [action, nightId, router]);
  return null;
}

/**
 * Copies the night's invite link: it unfurls in Discord as the night, and
 * opening it says "I'm in" (or joins the queue once the night is on). The
 * address comes from `window.location.origin` at click time, so a preview,
 * a custom domain and localhost each copy themselves (InviteLink's rule).
 */
export function CopyInhouseNightInvite({
  variant = "secondary",
  size = "sm",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={buttonClasses(variant, size, className)}
      onClick={async () => {
        const url = `${window.location.origin}${INHOUSE_NIGHT_INVITE_PATH}`;
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          pushToast("success", `Copied ${url}: paste it in Discord and it shows the night.`);
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
  );
}
