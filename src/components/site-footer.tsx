import { LEAGUE_CONFIG } from "@/lib/league-config";
import Link from "next/link";
import { Badge, DiscordButton } from "@/components/ui";
import { seasonPhaseLabel, seasonPhaseTone } from "@/lib/season-copy";
import { exploreNav, seasonNav, type NavSection } from "@/lib/site-nav";

const FOOTER_LINK_CLASS =
  "rounded py-1 text-sm leading-6 text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

export function SiteFooter({
  seasonName,
  phase,
  draftStatus = null,
  hasHistory = false,
}: {
  seasonName: string | null;
  phase: string | null;
  /** The active season's auction status; only read during DRAFT. */
  draftStatus?: string | null;
  hasHistory?: boolean;
}) {
  const year = new Date().getFullYear();
  // The same pages, names and groups as the header and its Explore menu
  // (src/lib/site-nav.ts): the header's primary row, then Explore's groups.
  // The footer has no "My Team": it is the same for every viewer.
  const navState = { phase, draftStatus, hasHistory };
  const sections: NavSection[] = [
    { group: "season", label: LEAGUE_CONFIG.name, links: seasonNav(navState) },
    ...exploreNav(navState),
  ];
  // The .ics feed is a file download, so it renders as a plain <a> below.
  const showCalendar = phase === "REGULAR_SEASON" || phase === "PLAYOFFS";

  return (
    <footer className="mt-8 border-t border-line-soft bg-bg">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        {/* Keep the emblem prominent, but let the navigation share one clean
            baseline instead of vertically centering unequal link stacks. */}
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.45fr)] lg:gap-16">
          <Link
            href="/"
            aria-label={`${LEAGUE_CONFIG.name} — home`}
            className="flex items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 lg:justify-start"
          >
            {/* Use the same regional emblem as the header. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={LEAGUE_CONFIG.branding.navLogo}
              style={{ mixBlendMode: LEAGUE_CONFIG.branding.blendMode }}
              alt={LEAGUE_CONFIG.name}
              width={LEAGUE_CONFIG.branding.navWidth}
              height={LEAGUE_CONFIG.branding.navHeight}
              className="h-32 w-auto sm:h-40 lg:h-44"
            />
          </Link>

          <nav
            aria-label="Footer"
            className="grid w-full grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-4"
          >
            {sections.map((section) => (
              <div key={section.group} className="min-w-0">
                <p
                  id={`footer-nav-${section.group}`}
                  className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted"
                >
                  {section.label}
                </p>
                <ul
                  aria-labelledby={`footer-nav-${section.group}`}
                  className="mt-3 flex flex-col items-start gap-y-1"
                >
                  {section.links.map((l) => (
                    <li key={l.href}>
                      <Link href={l.href} className={FOOTER_LINK_CLASS}>
                        {l.label}
                      </Link>
                    </li>
                  ))}
                  {section.group === "season" && showCalendar ? (
                    <li>
                      <a
                        href="/api/calendar"
                        className={`${FOOTER_LINK_CLASS} inline-flex items-center gap-2 whitespace-nowrap`}
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
                        Calendar (.ics)
                      </a>
                    </li>
                  ) : null}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
          <div className="flex justify-center sm:justify-start">
            <DiscordButton size="sm" />
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs text-muted sm:justify-end">
            {seasonName ? (
              <span className="inline-flex max-w-full flex-wrap items-center justify-center gap-2">
                <span>{seasonName}</span>
                {phase ? (
                  <Badge tone={seasonPhaseTone(phase)}>
                    {seasonPhaseLabel(phase, draftStatus)}
                  </Badge>
                ) : null}
              </span>
            ) : null}
            {seasonName ? (
              <span aria-hidden="true" className="hidden text-line sm:inline">
                •
              </span>
            ) : null}
            <span>© {year} {LEAGUE_CONFIG.name}</span>
            <span aria-hidden="true" className="hidden text-line sm:inline">
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
            <span aria-hidden="true" className="hidden text-line sm:inline">
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
