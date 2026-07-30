"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AUTO_SYNC, INHOUSE_SCAN_ACTION_TIMEOUT_MS } from "@/lib/constants";
import { syncPingStep } from "@/lib/result-sync";

// Invisible sitewide trigger for the automatic result sync: POSTs /api/sync on
// mount, then keeps a slow heartbeat — fast (WATCH_POLL_SECONDS) while the
// server says matches are in their detection window or an inhouse game is
// live, near-free (IDLE_POLL_SECONDS) otherwise. When something landed,
// router.refresh() re-renders the page's server components, so whoever is
// parked on the dashboard/standings sees results appear on their own.
// The refresh/delay/baseline rule is pure `syncPingStep` (result-sync.ts) —
// the two-triggers rationale (why `updated` alone strands parked tabs) lives
// on it. This component keeps only the timer, the inFlight latch, the
// visibility listener, and the fetch. Mounted once in the root layout;
// renders nothing.
export function ResultSyncPing() {
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // resultChangedAt baseline across responses; syncPingStep owns the rule
    // (first response baselines without a refresh, null keeps the baseline).
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
        const res = await fetch("/api/sync", {
          method: "POST",
          // The hung-request freeze class CLAUDE.md pins for the rooms — a
          // request that connects and never answers latches inFlight forever;
          // scan-sized, since /api/sync can run an OpenDota roster scan.
          signal: AbortSignal.timeout(INHOUSE_SCAN_ACTION_TIMEOUT_MS),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            updated?: boolean;
            watch?: boolean;
            cursor?: string | null;
          };
          const step = syncPingStep(data, lastCursor);
          delay = step.delayMs;
          lastCursor = step.cursor;
          if (step.refresh) router.refresh();
        }
      } catch {
        // Best-effort: a failed ping (the abort's TimeoutError included) just
        // waits for the next heartbeat.
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
