"use client";

import { useCallback, useState } from "react";

/** A changed URL gets a fresh load attempt; only the URL that failed hides. */
export function shouldRenderTeamLogo(
  src: string,
  failedSrc: string | null,
): boolean {
  return src !== failedSrc;
}

/**
 * Whether the logo paints its backing yet. The backing hides the monogram
 * behind a transparent logo, so it waits for the logo itself: painted from
 * the first frame, it covered the initials with an empty box for as long as
 * a lazy logo took to arrive (three Europe and US crests read as blank boxes
 * in the bracket and results on first scroll).
 */
export function teamLogoBackingShown(
  src: string,
  loadedSrc: string | null,
): boolean {
  return src === loadedSrc;
}

/**
 * The only client-stateful part of TeamCrest. Returning null after an image
 * error reveals the deterministic monogram rendered underneath by the parent,
 * and the monogram also shows through until the logo has loaded.
 */
export function TeamLogoImage({
  src,
  size,
  fit,
}: {
  src: string;
  size: number;
  fit: "contain" | "cover";
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  // A cached logo can finish (or fail) before React attaches onLoad and
  // onError, and then neither ever fires. Read the settled image once it
  // mounts instead.
  const readSettled = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img?.complete) return;
      if (img.naturalWidth > 0) setLoadedSrc(src);
      else setFailedSrc(src);
    },
    [src],
  );
  if (!shouldRenderTeamLogo(src, failedSrc)) return null;

  return (
    // Admins can set a logo on any HTTPS host (captains only Imgur or the
    // site's own artwork: isCaptainLogoHost), so the image optimizer cannot
    // safely predeclare every allowed remote pattern.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={readSettled}
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={() => setLoadedSrc(src)}
      onError={() => setFailedSrc(src)}
      className={`absolute inset-0 block ${
        teamLogoBackingShown(src, loadedSrc) ? "bg-surface-2" : ""
      } ${fit === "cover" ? "object-cover" : "object-contain"}`}
      // Tailwind's image reset sets height:auto. Inline dimensions guarantee
      // the loaded image fills the parent's fixed square despite that reset.
      style={{ width: "100%", height: "100%" }}
    />
  );
}
