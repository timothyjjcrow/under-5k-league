"use client";

// Self-ticking clock hooks for the live draft & inhouse rooms.
//
// Both rooms poll the server ~every 1.2s and, before this existed, ran a single
// 250ms `forceTick` at the ROOM level purely to advance the countdown display.
// That re-rendered the entire room — including the player pool and its
// filter/sort pass — four times a second. These hooks move the sub-second
// ticking into tiny LEAF components so only the clock text re-renders; the room
// itself now re-renders only on real state changes (the poll).
//
// Time is server-authoritative: deadlines/start times arrive as server-epoch
// milliseconds and `offsetMs` (= serverNow − clientNow, captured on each poll)
// corrects for clock skew. The rooms only mount these once real state has
// loaded, so there is no SSR/hydration clock mismatch.

import { useCallback, useEffect, useRef, useState } from "react";
import { elapsedSince, secondsUntil } from "@/lib/countdown";

const TICK_MS = 250;

function useClientNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Whole seconds remaining until `endsAtMs` (server epoch), never negative. */
export function useSecondsLeft(
  endsAtMs: number | null | undefined,
  offsetMs: number,
): number {
  return secondsUntil(endsAtMs, offsetMs, useClientNow());
}

/** Milliseconds elapsed since `startedAtMs` (server epoch); null if not set. */
export function useElapsedMs(
  startedAtMs: number | null | undefined,
  offsetMs: number,
): number | null {
  return elapsedSince(startedAtMs, offsetMs, useClientNow());
}

/**
 * Connection health for the rooms' poll loops. Failure counters live in refs
 * and the single `disconnected` boolean flips only on threshold crossings, so
 * a healthy room never re-renders because of health tracking (see the
 * performance note at the top of this file). Wire `ok()` into the poll's
 * success path and `fail()` into non-ok responses AND the catch block —
 * before this existed both rooms swallowed every failure, and captains on
 * dead wifi watched a frozen auction that looked live while the server sold
 * their player.
 */
export function usePollHealth(threshold = 3) {
  const failsRef = useRef(0);
  const [disconnected, setDisconnected] = useState(false);
  const ok = useCallback(() => {
    failsRef.current = 0;
    setDisconnected(false); // same-value setState bails out of re-rendering
  }, []);
  const fail = useCallback(() => {
    failsRef.current += 1;
    if (failsRef.current >= threshold) setDisconnected(true);
  }, [threshold]);
  return { disconnected, ok, fail };
}

/**
 * Tracks whether a room's main clock banner has scrolled under the sticky
 * site header, so the room can pin a compact clock bar in its place. The
 * header is h-20 (80px) — this rootMargin and the compact bars' `top-20`
 * must change TOGETHER (see the CLAUDE.md mobile rules).
 */
export function useBannerOffscreen(active: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [offscreen, setOffscreen] = useState(false);
  useEffect(() => {
    if (!active) {
      setOffscreen(false);
      return;
    }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      ([entry]) => setOffscreen(!entry.isIntersecting),
      { rootMargin: "-80px 0px 0px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [active]);
  return { ref, offscreen };
}
