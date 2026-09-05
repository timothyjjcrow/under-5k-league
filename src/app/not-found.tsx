import { LEAGUE_CONFIG } from "@/lib/league-config";
import Link from "next/link";
import { buttonClasses } from "@/components/ui";

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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={LEAGUE_CONFIG.branding.logo}
            style={{ mixBlendMode: LEAGUE_CONFIG.branding.blendMode }}
            alt={LEAGUE_CONFIG.name}
            width={LEAGUE_CONFIG.branding.logoWidth}
            height={LEAGUE_CONFIG.branding.logoHeight}
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
              This page is lost in the fog of war.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Link href="/" className={buttonClasses("primary")}>
              Back to home
            </Link>
            <Link href="/players" className={buttonClasses("secondary")}>
              Browse players
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
