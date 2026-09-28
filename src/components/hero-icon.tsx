"use client";

import { useEffect, useRef, useState } from "react";
import { type Hero, heroIcon } from "@/lib/heroes";
import { cn } from "@/lib/utils";

/** Up to two capitals from a hero's name: "Anti-Mage" → "AM", "Axe" → "A". */
export function heroInitials(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

const TILE = "shrink-0 rounded-md border border-line/70 bg-surface-2";

/** What a hero icon shows when its image can't load: a tile of initials. */
export function HeroIconFallback({
  hero,
  size,
  className,
  title,
}: {
  hero: Hero;
  size: number;
  className?: string;
  title?: string;
}) {
  return (
    <span
      role="img"
      aria-label={hero.name}
      title={title ?? hero.name}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.4)),
      }}
      className={cn(
        TILE,
        "inline-flex items-center justify-center font-semibold leading-none text-muted",
        className,
      )}
    >
      <span aria-hidden="true">{heroInitials(hero.name)}</span>
    </span>
  );
}

/**
 * A hero's portrait from Valve's CDN. If the CDN is down or blocked, a tile
 * of the hero's initials takes its place instead of a broken-image glyph with
 * a few clipped letters of alt text. The server HTML is the plain <img>, so a
 * page renders exactly as before whenever the image loads.
 */
export function HeroIcon({
  hero,
  size = 26,
  className,
  title,
}: {
  hero: Hero;
  size?: number;
  className?: string;
  /** Hover text override. Needed because the browser shows the INNERMOST
   *  title under the cursor, and this img fills any wrapper — a title on a
   *  wrapping span is unreachable. Defaults to the hero name, so the
   *  existing call sites render byte-identically. */
  title?: string;
}) {
  const src = heroIcon(hero);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const ref = useRef<HTMLImageElement>(null);

  // An image can fail before React attaches onError. A finished image with
  // no size may be broken, or (in some browsers) a lazy image not fetched
  // yet; decode() rejects for the first and waits for the second.
  useEffect(() => {
    const img = ref.current;
    if (!img || !img.complete || img.naturalWidth > 0) return;
    img.decode().catch(() => setFailedSrc(src));
  }, [src]);

  if (failedSrc === src) {
    return (
      <HeroIconFallback
        hero={hero}
        size={size}
        className={className}
        title={title}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={src}
      alt={hero.name}
      title={title ?? hero.name}
      width={size}
      height={size}
      loading="lazy"
      style={{ width: size, height: size }}
      onError={() => setFailedSrc(src)}
      className={cn(TILE, "object-cover", className)}
    />
  );
}
