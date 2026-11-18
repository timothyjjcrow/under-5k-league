"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, useState } from "react";
import { offerToStandInAction } from "@/app/actions/standin-offers";
import { pushToast } from "@/components/toaster";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "@/components/ui";
import {
  standinOfferPath,
  type StandinArrivalAction,
} from "@/lib/standin-offer";
import {
  STANDIN_GAME_COOKIE,
  STANDIN_GAME_MAX_AGE_SECONDS,
  standinGameValue,
} from "@/lib/standin-game";

// A game's shared standin link (standinOfferPath) on the page it opens: the
// one-time "I can play" it asks for, and the button that copies it.

/**
 * Answers a shared link once: puts a signed-in standin who may offer on the
 * list, or says they already are, or why they can't be. The server decides
 * which (standinArrivalAction); this only acts. It scrubs `play` from the
 * address first, so a refresh or a copied tab never offers again (the
 * inhouse night's `?imin=1` works the same way), then refreshes the page:
 * called from an effect, the action's own revalidation never reaches it. A
 * lost answer is unknown, never failed: the game shows the truth on reload.
 *
 * Opening the link only ever adds a name to a list the captain picks from,
 * and one tap takes it off again, which is why this may act without a press.
 */
export function StandinOfferOnArrival({
  matchId,
  teamId,
  action,
  blockedReason,
}: {
  matchId: string;
  teamId: string;
  action: StandinArrivalAction;
  /** Why they can't offer, for `action: "blocked"`. */
  blockedReason?: string;
}) {
  const answered = useRef(false);
  const router = useRouter();
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("play")) {
      url.searchParams.delete("play");
      window.history.replaceState(null, "", url);
    }
    if (answered.current) return;
    answered.current = true;
    if (action === "already") {
      pushToast("info", "You're already on the list for this game.");
      return;
    }
    if (action === "blocked") {
      if (blockedReason) pushToast("info", blockedReason);
      return;
    }
    if (action !== "offer") return;
    const form = new FormData();
    form.set("matchId", matchId);
    form.set("teamId", teamId);
    startTransition(async () => {
      try {
        const result = await offerToStandInAction(null, form);
        if (result?.error) pushToast("error", result.error);
        else if (result?.message) pushToast("success", result.message);
        router.refresh();
      } catch {
        pushToast(
          "error",
          "The connection dropped before we could confirm. Reload to see whether you're on the list.",
        );
      }
    });
  }, [action, blockedReason, matchId, teamId, router]);
  return null;
}

/**
 * Copies a game's standin link: it opens the Standins page on this game, and
 * a signed-in standin who opens it is put on the list. The address comes
 * from `window.location.origin` at click time, so a preview, a custom domain
 * and localhost each copy themselves.
 */
export function CopyStandinLink({
  matchId,
  teamId,
  variant = "ghost",
  size = "sm",
  className,
}: {
  matchId: string;
  teamId: string;
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
        const url = `${window.location.origin}${standinOfferPath(matchId, teamId)}`;
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          pushToast(
            "success",
            "Copied. Paste it in Discord: a standin who opens it is added to this game's list.",
          );
          setTimeout(() => setCopied(false), 2500);
        } catch {
          // Clipboard access is permission-gated; never claim a copy that
          // didn't happen.
          pushToast("error", `Couldn't copy: the standin link is ${url}`);
        }
      }}
    >
      <span aria-hidden>{copied ? "✓" : "🔗"}</span>
      {copied ? "Copied!" : "Copy standin link"}
    </button>
  );
}


/**
 * "Register as a standin" on a game, for a signed-in visitor with no signup:
 * it goes to the signup on /me, and remembers this game on the way (a cookie
 * for STANDIN_GAME_MAX_AGE_SECONDS), so the signup's own submit also puts
 * them on this game's list. The cookie survives the Discord step, which
 * leaves the site and comes back. A plain link: if the cookie can't be set
 * they still reach the signup, and the game is one tap from there.
 */
export function RegisterForStandinGame({
  matchId,
  teamId,
  className,
}: {
  matchId: string;
  teamId: string;
  className?: string;
}) {
  return (
    <a
      href="/me#profile-signup"
      className={buttonClasses("accent", "md", className)}
      onClick={() => {
        const value = standinGameValue({ matchId, teamId });
        if (!value) return;
        try {
          document.cookie = `${STANDIN_GAME_COOKIE}=${value}; path=/; max-age=${STANDIN_GAME_MAX_AGE_SECONDS}; samesite=lax`;
        } catch {
          // Cookies blocked: the signup still works, without the shortcut.
        }
      }}
    >
      Register as a standin to play
    </a>
  );
}

/**
 * A link to one game (`/standins?match=`) opens on it: the captain's cover
 * card when they have one, else the game on the list, whichever of `ids`
 * is on the page first. The captain's section streams in, so it watches the
 * page for a few seconds rather than looking once; it scrolls at most once
 * and stops at the first scroll the reader makes themselves.
 */
export function ScrollToStandinGame({ ids }: { ids: string[] }) {
  const key = ids.join(" ");
  useEffect(() => {
    const wanted = key.split(" ");
    let done = false;
    const find = () =>
      wanted.map((id) => document.getElementById(id)).find(Boolean) ?? null;
    const go = () => {
      if (done) return;
      const el = find();
      if (!el) return;
      done = true;
      el.scrollIntoView({ block: "start" });
      stop();
    };
    const observer = new MutationObserver(go);
    const quit = () => {
      done = true;
      stop();
    };
    const timer = window.setTimeout(quit, 5000);
    function stop() {
      observer.disconnect();
      window.clearTimeout(timer);
      window.removeEventListener("wheel", quit);
      window.removeEventListener("touchmove", quit);
    }
    window.addEventListener("wheel", quit, { passive: true });
    window.addEventListener("touchmove", quit, { passive: true });
    observer.observe(document.body, { childList: true, subtree: true });
    go();
    return stop;
  }, [key]);
  return null;
}
