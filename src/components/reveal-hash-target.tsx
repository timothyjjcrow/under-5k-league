"use client";

import { useEffect } from "react";

/**
 * Opens every closed <details> around the element the URL's hash names, then
 * scrolls to it: on load and on a later hash change. Only for ids starting
 * with `prefix`, so it never competes with SectionNav, which reveals its own
 * section jumps.
 *
 * /admin's result rows sit inside week groups that start folded once a week
 * is played, so a link to one row would otherwise land on a shut disclosure
 * in browsers that don't open it themselves.
 */
export function RevealHashTarget({ prefix }: { prefix: string }) {
  useEffect(() => {
    const reveal = () => {
      const id = window.location.hash.slice(1);
      if (!id.startsWith(prefix)) return;
      const target = document.getElementById(id);
      if (!target) return;
      for (let el = target.parentElement; el; el = el.parentElement) {
        if (el instanceof HTMLDetailsElement) el.open = true;
      }
      target.scrollIntoView({ block: "start" });
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [prefix]);
  return null;
}
