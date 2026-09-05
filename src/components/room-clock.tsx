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

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { elapsedSince, secondsUntil } from "@/lib/countdown";
import { POLL_HEALTH_OK, pollHealthAfter } from "@/lib/poll-health";
import { ROOM_POLL_FAIL_THRESHOLD } from "@/lib/constants";

const TICK_MS = 250;

/**
 * A boolean persisted in localStorage (the rooms' sound toggles).
 *
 * `useSyncExternalStore`, not `useState` + a mount effect: reading storage in
 * an effect and calling setState is a cascading render, and it also duplicates
 * the truth — the stored string and the state could disagree. Here localStorage
 * IS the state, the server snapshot is the default (so SSR and the first client
 * render agree), and a change in another TAB is picked up for free.
 */
export function usePersistedFlag(
  key: string,
  defaultOn = true,
): [boolean, (next: boolean) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const relay = (e: StorageEvent) => {
        if (e.key === key || e.key === null) {
          if (e.key === null) VOLATILE_FLAGS.clear();
          else VOLATILE_FLAGS.delete(key);
          onChange();
        }
      };
      window.addEventListener("storage", relay);
      LOCAL_LISTENERS.add(onChange);
      return () => {
        window.removeEventListener("storage", relay);
        LOCAL_LISTENERS.delete(onChange);
      };
    },
    [key],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => {
      const fallback = VOLATILE_FLAGS.get(key);
      if (fallback !== undefined) return fallback;
      try {
        const stored = localStorage.getItem(key);
        return stored === "on" ? true : stored === "off" ? false : defaultOn;
      } catch {
        return defaultOn;
      }
    },
    () => defaultOn, // SSR + first paint: no storage to read yet
  );
  const set = useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(key, next ? "on" : "off");
        VOLATILE_FLAGS.delete(key);
      } catch {
        // Storage-blocked and quota-full browsers still need a working mute
        // button. Keep this page's choice until storage can persist it again.
        VOLATILE_FLAGS.set(key, next);
      }
      // `storage` only fires in OTHER tabs, so nudge this one ourselves.
      for (const l of LOCAL_LISTENERS) l();
    },
    [key],
  );
  return [value, set];
}
const LOCAL_LISTENERS = new Set<() => void>();
const VOLATILE_FLAGS = new Map<string, boolean>();

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
export function usePollHealth(threshold = ROOM_POLL_FAIL_THRESHOLD) {
  // The RULE (consecutive failures, cleared by any success) is pure and lives
  // in @/lib/poll-health, where a unit test can state it — this vitest project
  // is `environment: node`, so nothing here can be rendered in a test. All the
  // hook adds is where the counter is kept: a ref, so a healthy room never
  // re-renders for health tracking, with the boolean promoted to state.
  const healthRef = useRef(POLL_HEALTH_OK);
  const [disconnected, setDisconnected] = useState(false);
  const step = useCallback(
    (outcome: "ok" | "fail") => {
      healthRef.current = pollHealthAfter(
        healthRef.current,
        outcome,
        threshold,
      );
      // Same-value setState bails out of re-rendering, so this is a no-op on
      // every poll that doesn't cross the line.
      setDisconnected(healthRef.current.disconnected);
    },
    [threshold],
  );
  const ok = useCallback(() => step("ok"), [step]);
  const fail = useCallback(() => step("fail"), [step]);
  return { disconnected, ok, fail };
}

/**
 * Tracks whether a room's main clock banner has scrolled under the sticky
 * site header, so the room can pin a compact clock bar in its place. The
 * header is h-20 (80px) — this rootMargin and the compact bars' `top-20`
 * must change TOGETHER (see the CLAUDE.md mobile rules).
 */
export function useBannerOffscreen(active: boolean) {
  // CALLBACK ref, not useRef: the banner element can mount LATER than the
  // component that calls this hook. The draft room mounts once in its
  // waiting-room state (no banner in that branch) and flips to live via its
  // own poll — with a plain ref the [active]-keyed effect had already run
  // against ref.current === null and never re-ran, so every tab that parked
  // on /draft before "Start draft" spent the whole auction without the
  // compact clock bar. Tracking the element in state re-runs the effect the
  // moment the banner actually exists.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => setEl(node), []);
  const [offscreen, setOffscreen] = useState(false);
  // Reset during render when the banner goes inactive (the draft ended, the
  // lobby closed) — same reason as site-header: an effect would commit one
  // frame with a stale sticky bar, and setState inside an effect cascades.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setOffscreen(false);
  }
  useEffect(() => {
    if (!active) return;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      ([entry]) => setOffscreen(!entry.isIntersecting),
      { rootMargin: "-80px 0px 0px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [active, el]);
  return { ref, offscreen };
}
