"use client";

import { useState } from "react";

/** A changed URL gets a fresh load attempt; only the URL that failed hides. */
export function shouldRenderTeamLogo(
  src: string,
  failedSrc: string | null,
): boolean {
  return src !== failedSrc;
}

/**
 * The only client-stateful part of TeamCrest. Returning null after an image
 * error reveals the deterministic monogram rendered underneath by the parent.
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
  if (!shouldRenderTeamLogo(src, failedSrc)) return null;

  return (
    // Admin-configured logos can use arbitrary remote hosts, so the image
    // optimizer cannot safely predeclare every allowed remote pattern.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(src)}
      className={`absolute inset-0 block bg-surface-2 ${
        fit === "cover" ? "object-cover" : "object-contain"
      }`}
      // Tailwind's image reset sets height:auto. Inline dimensions guarantee
      // the loaded image fills the parent's fixed square despite that reset.
      style={{ width: "100%", height: "100%" }}
    />
  );
}
