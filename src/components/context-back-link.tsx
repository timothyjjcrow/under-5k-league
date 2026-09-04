"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import {
  isLeagueDetail,
  isLeagueList,
  navigationContextKey,
  parseNavigationContext,
  SAVE_LIST_CONTEXT_EVENT,
  type NavigationContext,
} from "@/lib/navigation-context";

let pendingReturn: NavigationContext | null = null;
const subscribe = () => () => {};
const serverSnapshot = () => null;

function storedContext(pathname: string) {
  try {
    return sessionStorage.getItem(navigationContextKey(pathname));
  } catch {
    return null;
  }
}

/** Keeps the original, useful fallback on direct visits and without JavaScript. */
export function ContextBackLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const pathname = usePathname();
  const raw = useSyncExternalStore(
    subscribe,
    () => storedContext(pathname),
    serverSnapshot,
  );
  const context = parseNavigationContext(raw, href);
  return (
    <Link
      href={context?.href ?? href}
      className={className}
      scroll={context ? false : undefined}
      onNavigate={() => {
        pendingReturn = context;
      }}
      data-context-back
    >
      {children}
    </Link>
  );
}

/** One small listener remembers list context for all existing entity links. */
export function NavigationContextTracker() {
  const pathname = usePathname();
  useEffect(() => {
    function remember(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        !link ||
        link.hasAttribute("data-context-back") ||
        link.target ||
        link.download
      )
        return;
      const destination = new URL(link.href, location.href);
      if (
        destination.origin !== location.origin ||
        !isLeagueDetail(destination.pathname) ||
        destination.pathname === location.pathname
      )
        return;
      try {
        const key = navigationContextKey(destination.pathname);
        sessionStorage.removeItem(key);
        if (!isLeagueList(location.pathname) || !link.closest("#main")) return;
        // Flush a directory's debounced URL before a quick result click.
        window.dispatchEvent(new Event(SAVE_LIST_CONTEXT_EVENT));
        const anchors = Array.from(
          document.querySelectorAll<HTMLAnchorElement>("#main a[href]"),
        ).filter((anchor) => anchor.href === link.href);
        sessionStorage.setItem(
          key,
          JSON.stringify({
            href: location.pathname + location.search + location.hash,
            scrollY: window.scrollY,
            anchorHref:
              destination.pathname + destination.search + destination.hash,
            anchorIndex: Math.max(0, anchors.indexOf(link)),
            anchorTop: link.getBoundingClientRect().top,
          } satisfies NavigationContext),
        );
      } catch {
        // Private browsing/storage limits must never prevent normal navigation.
      }
    }
    document.addEventListener("click", remember, true);
    return () => document.removeEventListener("click", remember, true);
  }, []);

  useEffect(() => {
    const context = pendingReturn;
    if (
      !context ||
      pathname !== new URL(context.href, location.origin).pathname
    )
      return;
    pendingReturn = null;
    let finished = false;
    let frame = 0;
    const restore = () => {
      if (finished) return;
      const anchors = Array.from(
        document.querySelectorAll<HTMLAnchorElement>("#main a[href]"),
      ).filter(
        (anchor) =>
          anchor.href === new URL(context.anchorHref, location.origin).href,
      );
      const anchor = anchors[context.anchorIndex];
      if (!anchor || anchor.getClientRects().length === 0) return;
      // Two frames let the streamed list and its URL-driven filters lay out.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (finished) return;
          window.scrollTo({
            top:
              window.scrollY +
              anchor.getBoundingClientRect().top -
              context.anchorTop,
            behavior: "instant",
          });
          anchor.focus({ preventScroll: true });
          stop();
        });
      });
    };
    const observer = new MutationObserver(restore);
    const stop = () => {
      finished = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", stop);
      window.removeEventListener("keydown", stop);
      window.removeEventListener("wheel", stop);
    };
    observer.observe(document.getElementById("main") ?? document.body, {
      childList: true,
      subtree: true,
    });
    window.addEventListener("pointerdown", stop, { once: true });
    window.addEventListener("keydown", stop, { once: true });
    window.addEventListener("wheel", stop, { once: true, passive: true });
    const timeout = window.setTimeout(() => {
      if (!finished)
        window.scrollTo({ top: context.scrollY, behavior: "instant" });
      stop();
    }, 4000);
    restore();
    return () => {
      clearTimeout(timeout);
      stop();
    };
  }, [pathname]);
  return null;
}
