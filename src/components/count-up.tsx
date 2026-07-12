"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Counts a number up from 0 to `value` with an ease-out, triggered once when it
 * scrolls into view (IntersectionObserver). Honors prefers-reduced-motion by
 * showing the final value immediately. The digit styling is inherited from the
 * parent (e.g. tabular-nums), so the width doesn't jitter while animating.
 *
 * The server (and any client whose JS hasn't run) renders the REAL value —
 * initializing at 0 meant curl/no-JS/pre-hydration views showed "0 players
 * signed up" for every stat. The run down to 0 happens only when the
 * animation itself starts.
 */
export function CountUp({
  value,
  durationMs = 800,
  decimals = 0,
  className,
}: {
  value: number;
  durationMs?: number;
  decimals?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const ref = useRef<HTMLSpanElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduce || value === 0 || done.current) {
      setDisplay(value);
      return;
    }
    const animate = () => {
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
        setDisplay(value * eased);
        if (t < 1) requestAnimationFrame(tick);
        else setDisplay(value);
      };
      requestAnimationFrame(tick);
    };
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !done.current) {
            done.current = true;
            obs.disconnect();
            animate();
          }
        }
      },
      { threshold: 0.3 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [value, durationMs]);

  const shown =
    decimals > 0 ? display.toFixed(decimals) : Math.round(display).toString();
  return (
    <span ref={ref} className={className} suppressHydrationWarning>
      {shown}
    </span>
  );
}
