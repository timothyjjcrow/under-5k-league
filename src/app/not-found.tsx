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
          <div className="animate-hero-float grid h-16 place-items-center rounded-2xl bg-gradient-to-br from-brand to-brand/60 px-5 text-2xl font-black uppercase tracking-tight text-brand-fg shadow-lg shadow-brand/40 ring-1 ring-white/15">
            GGD2L
          </div>
          <div>
            <div className="font-display text-6xl font-bold tracking-tight">
              404
            </div>
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
