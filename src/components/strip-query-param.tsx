"use client";

import { useEffect } from "react";

// One-shot feedback params (?discord=linked …) must not outlive their first
// render: a later server-action re-render or a refresh would re-show a stale
// note that contradicts the card next to it. Next syncs native
// history.replaceState with the app router (no RSC refetch), so scrubbing the
// param after mount means the note shows exactly once and never comes back.
export function StripQueryParam({ param }: { param: string }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has(param)) {
      url.searchParams.delete(param);
      window.history.replaceState(null, "", url);
    }
  }, [param]);
  return null;
}
