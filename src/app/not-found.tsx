import type { Metadata } from "next";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import Link from "next/link";
import { DiscordButton, buttonClasses } from "@/components/ui";

// Every notFound() in the app renders this file, so its title replaces the
// page's own: the tab read just "GGD2L" for an old Discord link to a
// fixture that no longer exists.
export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg py-16">
      <div className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-b from-surface-2/70 to-surface/40">
        <div
          aria-hidden
          className="hero-grid pointer-events-none absolute inset-0 opacity-50"
        />
        <div
          aria-hidden
          className="animate-hero-glow pointer-events-none absolute left-1/2 top-0 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/25 blur-3xl"
        />
        <div className="relative flex flex-col items-center gap-4 px-6 py-12 text-center">
          {/* The header's emblem: already downloaded, so a 404 costs no
              second logo. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={LEAGUE_CONFIG.branding.navLogo}
            style={{ mixBlendMode: LEAGUE_CONFIG.branding.blendMode }}
            alt={LEAGUE_CONFIG.name}
            width={LEAGUE_CONFIG.branding.navWidth}
            height={LEAGUE_CONFIG.branding.navHeight}
            className="animate-hero-float h-20 w-auto"
          />
          <div>
            <div
              aria-hidden
              className="font-display text-6xl font-bold tracking-tight"
            >
              404
            </div>
            <h1 className="mt-2 font-display text-2xl font-bold">
              Page not found
            </h1>
            <p className="mt-2 text-muted">
              This page is lost in the fog of war. The link may be out of
              date.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Link href="/" className={buttonClasses("primary")}>
              Back to home
            </Link>
            <Link href="/schedule" className={buttonClasses("secondary")}>
              Schedule
            </Link>
            <DiscordButton label="Ask on Discord" />
          </div>
        </div>
      </div>
    </div>
  );
}
