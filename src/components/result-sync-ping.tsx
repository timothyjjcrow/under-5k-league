"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AUTO_SYNC } from "@/lib/constants";

// Invisible sitewide trigger for the automatic result sync: POSTs /api/sync on
// mount, then keeps a slow heartbeat — fast (WATCH_POLL_SECONDS) while the
// server says matches are in their detection window or an inhouse game is
// live, near-free (IDLE_POLL_SECONDS) otherwise. When something landed,
// router.refresh() re-renders the page's server components, so whoever is
// parked on the dashboard/standings sees results appear on their own.
// Two refresh triggers, both needed: `updated` covers the one client whose
// own ping performed the import (its cursor baseline is already the new
// value), while the `cursor` advancing covers every OTHER parked viewer —
// the atomic server claims guarantee only one request ever "does" an import,
// so without the cursor the rest would poll updated:false forever and stay
// stale. Mounted once in the root layout; renders nothing.
export function ResultSyncPing() {
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Baseline from the FIRST response — the page's own server render is at
    // least that fresh, so only a later advance means "something new landed".
    let lastCursor: string | null = null;

    const schedule = (ms: number) => {
      if (!alive) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, ms);
    };

    const tick = async () => {
      // inFlight also covers a visibilitychange firing mid-request — the
      // active call reschedules when it finishes.
      if (!alive || inFlight) return;
      if (document.visibilityState === "hidden") {
        // Hidden tabs don't ping (browsers throttle them anyway); check back
        // lazily and let the visibility listener wake us properly.
        schedule(AUTO_SYNC.IDLE_POLL_SECONDS * 1000);
        return;
      }
      inFlight = true;
      let delay = AUTO_SYNC.IDLE_POLL_SECONDS * 1000;
      try {
        const res = await fetch("/api/sync", { method: "POST" });
        if (res.ok) {
          const data = (await res.json()) as {
            updated?: boolean;
            watch?: boolean;
            cursor?: string | null;
          };
          if (data.watch) delay = AUTO_SYNC.WATCH_POLL_SECONDS * 1000;
          const cursor = data.cursor ?? null;
          const cursorAdvanced =
            cursor !== null && lastCursor !== null && cursor !== lastCursor;
          if (cursor !== null) lastCursor = cursor;
          if (data.updated || cursorAdvanced) router.refresh();
        }
      } catch {
        // Best-effort: a failed ping just waits for the next heartbeat.
      } finally {
        inFlight = false;
      }
      schedule(delay);
    };

    // Tabbing back to the site on match night should sync immediately, not in
    // up-to-IDLE_POLL minutes.
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    tick();

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
    };
  }, [router]);

  return null;
}
