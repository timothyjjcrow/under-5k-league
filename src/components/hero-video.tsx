"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const FADE_SECONDS = 0.5; // fade in over the first / out over the last half-second
const DEFAULT_PEAK = 0.45; // matches the previous static hero-video opacity

/**
 * Background hero loop. To avoid wasting data, the video is only downloaded and
 * played when it will actually be enjoyed — it's skipped for
 * prefers-reduced-motion, small/mobile screens, Data Saver, and slow (2g)
 * connections. In those cases nothing is fetched and the static gradient hero
 * shows instead. On the rest, opacity ramps 0 -> 0.45 over the first half-second
 * and 0.45 -> 0 over the last, driven off the video's real currentTime, so the
 * (non-seamless) loop point is hidden behind opacity ~0 rather than a hard jump.
 */
export function HeroVideo({
  src = "/hero-loop.mp4",
  peakOpacity = DEFAULT_PEAK,
  className,
}: {
  src?: string;
  peakOpacity?: number;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;

    const mm = window.matchMedia;
    const reduce = mm?.("(prefers-reduced-motion: reduce)").matches;
    const smallScreen = mm?.("(max-width: 640px)").matches;
    const conn = (
      navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      }
    ).connection;
    const saveData = !!conn?.saveData;
    const slow = !!conn && /(^|-)2g$/.test(conn.effectiveType ?? "");
    // Don't fetch a single byte of the video when it won't (or shouldn't) show.
    if (reduce || smallScreen || saveData || slow) return;

    v.src = src;
    v.play().catch(() => {});

    let raf = 0;
    const update = () => {
      const d = v.duration;
      const t = v.currentTime;
      let o = peakOpacity;
      if (t < FADE_SECONDS) {
        o = peakOpacity * (t / FADE_SECONDS); // fade in
      } else if (d && d - t < FADE_SECONDS) {
        o = peakOpacity * ((d - t) / FADE_SECONDS); // fade out
      }
      v.style.opacity = String(Math.max(0, Math.min(peakOpacity, o)));
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [src, peakOpacity]);

  return (
    <video
      ref={ref}
      aria-hidden
      className={cn(
        "hero-video pointer-events-none absolute inset-0 h-full w-full object-cover",
        className,
      )}
      style={{ opacity: 0 }}
      muted
      loop
      playsInline
      preload="none"
    />
  );
}
