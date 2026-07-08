"use client";

import { useEffect, useRef } from "react";

const FADE_SECONDS = 0.5; // fade in over the first / out over the last half-second
const PEAK_OPACITY = 0.45; // matches the previous static hero-video opacity

/**
 * Background hero loop that fades in and out over the first and last half-second
 * of every cycle, so the (non-seamless) loop point is hidden behind opacity ~0
 * rather than showing a hard jump. Opacity is driven off the video's real
 * currentTime — not a CSS timer — so it can never drift out of sync with the
 * seam. Under prefers-reduced-motion the CSS hides the element entirely.
 */
export function HeroVideo({ src = "/hero-loop.mp4" }: { src?: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    const update = () => {
      const d = v.duration;
      const t = v.currentTime;
      let o = PEAK_OPACITY;
      if (t < FADE_SECONDS) {
        o = PEAK_OPACITY * (t / FADE_SECONDS); // fade in
      } else if (d && d - t < FADE_SECONDS) {
        o = PEAK_OPACITY * ((d - t) / FADE_SECONDS); // fade out
      }
      v.style.opacity = String(Math.max(0, Math.min(PEAK_OPACITY, o)));
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <video
      ref={ref}
      aria-hidden
      className="hero-video pointer-events-none absolute inset-0 h-full w-full object-cover"
      style={{ opacity: 0 }}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
    >
      <source src={src} type="video/mp4" />
    </video>
  );
}
