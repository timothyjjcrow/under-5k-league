"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A native <details> that opens itself when someone jumps to it: on load when
 * the URL's hash names its id, on a later hash change, and on a click of a
 * link to `#id` (clicking the same link twice doesn't change the hash). With
 * `openFromWidth` it also opens on mount when the viewport is at least that
 * wide, so a card can start folded on phones and open on a wide screen.
 * `openFor` names another id whose jumps open it too: the card around it,
 * when the links land on the card and not on the fold inside.
 *
 * The server always renders it closed, so a phone gets the folded form with no
 * layout shift. Without JavaScript it is an ordinary disclosure.
 */
export function AutoOpenDetails({
  id,
  openFor,
  openFromWidth,
  className,
  children,
}: {
  /** The element id. A jump to `#id` opens it. */
  id: string;
  /** Another element's id (the card around this fold): a jump there opens it too. */
  openFor?: string;
  /** A CSS length, e.g. "64rem": open on mount at this viewport width and up. */
  openFromWidth?: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const details = ref.current;
    if (!details) return;
    if (
      openFromWidth &&
      window.matchMedia(`(min-width: ${openFromWidth})`).matches
    ) {
      details.open = true;
    }
    const targets = openFor ? [`#${id}`, `#${openFor}`] : [`#${id}`];
    const openIfTargeted = () => {
      if (targets.includes(window.location.hash)) details.open = true;
    };
    const openOnLinkClick = (event: MouseEvent) => {
      const link =
        event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (targets.includes(link?.getAttribute("href") ?? "")) details.open = true;
    };
    openIfTargeted();
    window.addEventListener("hashchange", openIfTargeted);
    document.addEventListener("click", openOnLinkClick);
    return () => {
      window.removeEventListener("hashchange", openIfTargeted);
      document.removeEventListener("click", openOnLinkClick);
    };
  }, [id, openFor, openFromWidth]);
  return (
    <details ref={ref} id={id} className={className}>
      {children}
    </details>
  );
}
