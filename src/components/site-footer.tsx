import { LEAGUE_CONFIG } from "@/lib/league-config";
import Link from "next/link";
import { Badge, DiscordButton } from "@/components/ui";
import { scheduleDestinationLabel } from "@/lib/season-copy";

const PHASE_LABEL: Record<string, string> = {
  SIGNUPS: "Signups open",
  DRAFT: "Draft in progress",
  REGULAR_SEASON: "Regular season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Season complete",
};

const PHASE_TONE: Record<
  string,
  "brand" | "accent" | "success" | "info" | "neutral"
> = {
  SIGNUPS: "info",
  DRAFT: "accent",
  REGULAR_SEASON: "success",
  PLAYOFFS: "accent",
  COMPLETE: "brand",
};

const FOOTER_LINK_CLASS =
  "rounded py-1 text-sm leading-6 text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

export function SiteFooter({
  seasonName,
  phase,
  hasHistory = false,
}: {
  seasonName: string | null;
  phase: string | null;
  hasHistory?: boolean;
}) {
  const year = new Date().getFullYear();
  const teamsExist =
    phase === "DRAFT" ||
    phase === "REGULAR_SEASON" ||
    phase === "PLAYOFFS" ||
    phase === "COMPLETE";
  const midSeason =
    phase === "REGULAR_SEASON" || phase === "PLAYOFFS" || phase === "COMPLETE";

  // "League" — the surfaces tied to the current season. The PHASE GATING
  // mirrors site-header.tsx; labels and extra links (calendar, Features)
  // deliberately differ per surface — don't "fix" them into agreement.
  const leagueLinks: { href: string; label: string }[] = [
    { href: "/", label: "Home" },
    { href: "/players", label: "Players" },
    { href: "/inhouse", label: "Inhouse" },
    { href: "/scrims", label: "Scrims" },
  ];
  if (teamsExist) {
    leagueLinks.push({ href: "/teams", label: "Teams" });
  }
  if (phase === "DRAFT") {
    leagueLinks.push({ href: "/draft", label: "Draft" });
    leagueLinks.push({ href: "/schedule", label: "Schedule" });
    leagueLinks.push({ href: "/fantasy", label: "Fantasy" });
    leagueLinks.push({ href: "/pickem", label: "Pick'em" });
  }
  if (midSeason) {
    leagueLinks.push({
      href: "/schedule",
      label: scheduleDestinationLabel(phase),
    });
    leagueLinks.push({ href: "/leaders", label: "Leaders" });
    leagueLinks.push({ href: "/meta", label: "Hero meta" });
    leagueLinks.push({ href: "/fantasy", label: "Fantasy" });
    leagueLinks.push({ href: "/pickem", label: "Pick'em" });
  }
  if (phase === "COMPLETE")
    leagueLinks.push({ href: "/recap", label: "Season recap" });
  // The .ics feed is a file download, so it renders as a plain <a> below.
  const showCalendar = phase === "REGULAR_SEASON" || phase === "PLAYOFFS";

  // "Club" — evergreen, season-independent surfaces.
  const clubLinks: { href: string; label: string }[] = [
    { href: "/news", label: "News" },
  ];
  if (hasHistory) clubLinks.push({ href: "/seasons", label: "Past seasons" });
  clubLinks.push({ href: "/hall-of-fame", label: "Hall of Fame" });
  clubLinks.push({ href: "/records", label: "Record book" });
  clubLinks.push({ href: "/features", label: "Features" });

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
            {/* Tight-cropped emblem (shared with the nav) — no baked-in
                transparent margin, so it reads compact at a smaller height. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/ggd2l-logo-nav.png"
              alt={LEAGUE_CONFIG.name}
              width={520}
              height={427}
              className="h-32 w-auto sm:h-40 lg:h-44"
            />
            {LEAGUE_CONFIG.region === "eu" ? (
              <span className="ml-3 rounded border border-accent/40 px-2 py-1 text-xs font-semibold uppercase tracking-widest text-accent">
                Europe
              </span>
            ) : null}
          </Link>

          <div className="grid w-full gap-8 sm:grid-cols-[minmax(0,1.45fr)_minmax(10rem,0.75fr)] sm:gap-10">
            <nav aria-label="Footer — league" className="min-w-0">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                League
              </span>
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1">
                {leagueLinks.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className={FOOTER_LINK_CLASS}
                  >
                    {l.label}
                  </Link>
                ))}
                {showCalendar ? (
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
                ) : null}
              </div>
            </nav>

            <nav aria-label="Footer — club" className="min-w-0">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                Club
              </span>
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-1">
                {clubLinks.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className={FOOTER_LINK_CLASS}
                  >
                    {l.label}
                  </Link>
                ))}
              </div>
            </nav>
          </div>
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
                  <Badge tone={PHASE_TONE[phase] ?? "neutral"}>
                    {PHASE_LABEL[phase] ?? phase}
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
