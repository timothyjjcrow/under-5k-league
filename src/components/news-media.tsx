"use client";

import { useEffect, useRef, useState } from "react";
import type { MediaKind } from "@/lib/linkify";

/**
 * Inline GIF/image/video embed for news bodies. Capped height + max-w-full keep
 * any media inside its card and on its own line so it never disrupts the text
 * flow. Hotlinked third-party CDNs (Giphy/Tenor/Klipy) can rotate or remove an
 * asset, so on load failure we degrade to a plain link rather than a blank box
 * or a broken-image icon. Videos are how those services actually serve "GIFs"
 * now — rendered muted/looping/autoplaying to match GIF behavior.
 */
export function NewsMedia({
  src,
  kind,
  label = "Media attached to this announcement",
  className = "my-2 block max-h-72 max-w-full rounded-lg border border-line",
}: {
  src: string;
  kind: MediaKind;
  label?: string;
  /** Sizing/spacing override — the dashboard preview caps it shorter. */
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  // Start paused in server HTML. After hydration, autoplay only when the user
  // has not requested reduced motion; animated GIFs become opt-in links for
  // reduced-motion readers because browsers cannot programmatically pause GIFs.
  const [reduceMotion, setReduceMotion] = useState(true);
  const imgRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Media ships in the SSR'd HTML and can fail loading BEFORE React hydrates and
  // attaches onError, so that event is missed. Re-check on mount for a failure
  // that already happened: an <img> that's "complete" with zero natural size, or
  // a <video> whose .error is set. (Later failures are still caught by onError.)
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) {
      setFailed(true);
      return;
    }
    if (videoRef.current?.error) setFailed(true);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (reduceMotion) video.pause();
    else void video.play().catch(() => undefined);
  }, [reduceMotion]);

  if (failed) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="break-all text-info hover:underline"
      >
        {src}
      </a>
    );
  }

  if (kind === "video") {
    return (
      <video
        ref={videoRef}
        src={src}
        className={className}
        autoPlay={!reduceMotion}
        muted
        loop
        playsInline
        controls
        aria-label={label}
        onError={() => setFailed(true)}
      />
    );
  }

  if (/\.gif(?:[?#]|$)/i.test(src)) {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={src}
          alt={label}
          loading="lazy"
          className={`${className} motion-reduce:hidden`}
          onError={() => setFailed(true)}
        />
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="my-2 hidden min-h-11 items-center rounded-lg border border-line px-3 py-2 text-sm text-info hover:underline motion-reduce:inline-flex"
        >
          {label} — open animation
        </a>
      </>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      src={src}
      alt={label}
      loading="lazy"
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
