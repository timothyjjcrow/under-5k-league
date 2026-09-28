"use client";

import { LEAGUE_CONFIG } from "@/lib/league-config";

import { useEffect } from "react";

// Plain links, not next/link: the root layout just failed, so a full page
// load is the better retry. Inline styles, like the rest of this file.
const LINK_STYLE = {
  minHeight: "44px",
  display: "inline-flex",
  alignItems: "center",
  borderRadius: "8px",
  border: "1px solid #26324c",
  padding: "0 16px",
  boxSizing: "border-box",
  color: "#e8edf5",
  fontWeight: 600,
  textDecoration: "none",
} as const;

/**
 * Last-resort UI for failures in the root layout itself (session, season, or
 * navigation queries). `app/error.tsx` cannot catch its parent layout.
 *
 * This document owns its styles because Next replaces the root layout when it
 * renders `global-error`; global fonts and CSS are not guaranteed to survive.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV === "development") console.error(error);
    else console.error("[ui-error] root layout failed");
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "24px",
          boxSizing: "border-box",
          background: "#0b0f17",
          color: "#e8edf5",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        <title>Unable to load {LEAGUE_CONFIG.name}</title>
        <main
          style={{
            width: "100%",
            maxWidth: "480px",
            border: "1px solid #26324c",
            borderRadius: "12px",
            background: "#121a29",
            padding: "32px",
            boxSizing: "border-box",
            textAlign: "center",
          }}
        >
          <div aria-hidden style={{ fontSize: "40px" }}>
            ⚠️
          </div>
          <h1 style={{ margin: "12px 0 0", fontSize: "28px" }}>
            {LEAGUE_CONFIG.name} couldn&apos;t load
          </h1>
          <p style={{ margin: "12px 0 0", color: "#aab5c8", lineHeight: 1.5 }}>
            The league data may be temporarily unavailable. Try again; if the
            problem continues,{" "}
            {LEAGUE_CONFIG.discordInviteUrl
              ? "ask a league admin on Discord and send the reference below."
              : "send the reference below to a league admin."}
          </p>
          {error.digest ? (
            <p
              style={{
                margin: "10px 0 0",
                color: "#8b98af",
                fontFamily: "ui-monospace, monospace",
                fontSize: "12px",
              }}
            >
              ref: {error.digest}
            </p>
          ) : null}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: "8px",
              marginTop: "24px",
            }}
          >
            <button
              type="button"
              onClick={unstable_retry}
              style={{
                minHeight: "44px",
                border: 0,
                borderRadius: "8px",
                padding: "0 20px",
                background: "#dc3434",
                color: "white",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" style={LINK_STYLE}>
              Back to home
            </a>
            {/* Phase-independent: this document can't read the season. */}
            <a href="/how-it-works" style={LINK_STYLE}>
              How it works
            </a>
            {LEAGUE_CONFIG.discordInviteUrl ? (
              <a
                href={LEAGUE_CONFIG.discordInviteUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  ...LINK_STYLE,
                  border: 0,
                  background: "#5865F2",
                  color: "white",
                }}
              >
                Ask on Discord
              </a>
            ) : null}
          </div>
        </main>
      </body>
    </html>
  );
}
