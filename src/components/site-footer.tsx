import { LEAGUE_CONFIG } from "@/lib/league-config";
import Link from "next/link";
import { Badge, DiscordButton } from "@/components/ui";
import { seasonPhaseLabel, seasonPhaseTone } from "@/lib/season-copy";
import { footerNav, type NavContent } from "@/lib/site-nav";

const FOOTER_LINK_CLASS =
  "rounded py-1 text-sm leading-6 text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

export function SiteFooter({
  seasonName,
  phase,
  draftStatus = null,
  content,
}: {
  seasonName: string | null;
  phase: string | null;
  /** The active season's auction status; only read during DRAFT. */
  draftStatus?: string | null;
  /** What the league has on record; decides which pages are offered. */
  content: NavContent;
}) {
  const year = new Date().getFullYear();
  // Only the essentials. The footer used to repeat every page from the header
  // and Explore, a fourth copy of the same links under every page (about
  // 775px tall on a phone). Its links come from src/lib/site-nav.ts, so they
  // keep the names every other menu uses.
  const links = footerNav({ ...content, phase, draftStatus });
  // Calendar help goes to Schedule's "Add to calendar" menu, which offers a
  // subscription that picks up reschedules. It used to download the .ics
  // file here, the one-time copy that menu steers people away from.
  const showCalendar = phase === "REGULAR_SEASON" || phase === "PLAYOFFS";

  return (
    // Two compact bands: the brand, the Discord invite and the few links; then
    // the small print. It used to stack a 64px emblem, the links and a ruled
    // second band into about 290px on a phone, under every page.
    <footer className="mt-4 border-t border-line-soft bg-bg">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              aria-label={`${LEAGUE_CONFIG.name} — home`}
              className="flex shrink-0 items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {/* Use the same regional emblem as the header. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={LEAGUE_CONFIG.branding.navLogo}
                style={{ mixBlendMode: LEAGUE_CONFIG.branding.blendMode }}
                alt={LEAGUE_CONFIG.name}
                width={LEAGUE_CONFIG.branding.navWidth}
                height={LEAGUE_CONFIG.branding.navHeight}
                className="h-11 w-auto"
              />
            </Link>
            <DiscordButton size="sm" />
          </div>

          <nav aria-label="Footer" className="min-w-0">
            {/* Flex items, so each padded 32px hit box keeps its own row
                height when the list wraps. */}
            <ul className="flex flex-wrap items-center gap-x-5 gap-y-1">
              {links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={`${FOOTER_LINK_CLASS} block`}>
                    {l.label}
                  </Link>
                </li>
              ))}
              {showCalendar ? (
                <li>
                  <Link
                    href="/schedule"
                    className={`${FOOTER_LINK_CLASS} flex items-center gap-2 whitespace-nowrap`}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-3.5 w-3.5 shrink-0"
                    >
                      <path d="M7 3v3M17 3v3M4.5 9.5h15" />
                      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
                    </svg>
                    Add to calendar
                  </Link>
                </li>
              ) : null}
            </ul>
          </nav>
        </div>

        <div className="mt-5 flex flex-col gap-3 border-t border-line-soft pt-4 text-xs text-muted lg:flex-row lg:items-center lg:justify-between lg:gap-6">
          {/* Who runs the league and who to ask about a profile, per region.
              One line on purpose: there is no policy page. */}
          <p className="leading-relaxed lg:max-w-2xl">
            {LEAGUE_CONFIG.footerNote}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 lg:shrink-0 lg:justify-end">
            {seasonName ? (
              <span className="inline-flex max-w-full flex-wrap items-center gap-2">
                <span>{seasonName}</span>
                {phase ? (
                  <Badge tone={seasonPhaseTone(phase)}>
                    {seasonPhaseLabel(phase, draftStatus)}
                  </Badge>
                ) : null}
              </span>
            ) : null}
            {seasonName ? (
              <span aria-hidden="true" className="text-line">
                •
              </span>
            ) : null}
            <span>© {year} {LEAGUE_CONFIG.name}</span>
            <span aria-hidden="true" className="text-line">
              •
            </span>
            <a
              href={LEAGUE_CONFIG.merchUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Merch — GGD2L shop (opens in a new tab)"
              className="-my-1 inline-flex items-center gap-1 rounded py-1 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              Merch <span aria-hidden="true">↗</span>
            </a>
            <span aria-hidden="true" className="text-line">
              •
            </span>
            <a
              href="https://buymeacoffee.com/vgedota"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Support the league on Buy Me a Coffee (opens in a new tab)"
              className="-my-1 inline-flex items-center gap-1 rounded py-1 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              Support the league <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
