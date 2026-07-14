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

import { useEffect, useState } from "react";
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
