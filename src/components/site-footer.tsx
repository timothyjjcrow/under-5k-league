import Link from "next/link";
import { Badge, DiscordButton } from "@/components/ui";

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
    phase === "REGULAR_SEASON" ||
    phase === "PLAYOFFS" ||
    phase === "COMPLETE";

  // "League" — the surfaces tied to the current season, phase-gated exactly the
  // way site-header.tsx gates the same links so the two never disagree.
  const leagueLinks: { href: string; label: string }[] = [
    { href: "/", label: "Home" },
    { href: "/players", label: "Players" },
    { href: "/inhouse", label: "Inhouse" },
  ];
  if (teamsExist) leagueLinks.push({ href: "/teams", label: "Teams" });
  if (phase === "DRAFT") leagueLinks.push({ href: "/draft", label: "Draft" });
  if (midSeason) {
    leagueLinks.push({ href: "/schedule", label: "Schedule" });
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
    <footer className="border-t border-line/70">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        {/* Centered logo centerpiece with the link groups flanking it. On
            phones it stacks logo-first, then the two link groups, all centered. */}
        <div className="grid grid-cols-1 items-center gap-8 md:grid-cols-[1fr_auto_1fr] md:gap-12">
          <nav
            aria-label="Footer — league"
            className="order-2 flex flex-col items-center gap-2 text-sm md:order-1 md:items-end"
          >
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              League
            </span>
            {leagueLinks.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-muted transition-colors hover:text-fg"
              >
                {l.label}
              </Link>
            ))}
            {showCalendar ? (
              <a
                href="/api/calendar"
                className="text-muted transition-colors hover:text-fg"
              >
                <span aria-hidden="true">📅</span> Calendar (.ics)
              </a>
            ) : null}
          </nav>

          <div className="order-1 flex flex-col items-center text-center md:order-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/ggd2l-logo.png"
              alt="GGD2L"
              width={768}
              height={512}
              className="h-28 w-auto md:h-36"
            />
            <p className="mt-3 max-w-xs text-sm text-muted">
              A drafted, team-based Dota 2 league built around a soft 4.5K MMR
              limit.
            </p>
            <DiscordButton size="sm" className="mt-4" />
          </div>

          <nav
            aria-label="Footer — club"
            className="order-3 flex flex-col items-center gap-2 text-sm md:items-start"
          >
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Club
            </span>
            {clubLinks.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-muted transition-colors hover:text-fg"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-2 border-t border-line/60 pt-6 text-xs text-muted sm:justify-between">
          <span>© {year} GGD2L</span>
          {seasonName ? (
            <span className="flex items-center gap-2">
              <span>{seasonName}</span>
              {phase ? (
                <Badge tone={PHASE_TONE[phase] ?? "neutral"}>
                  {PHASE_LABEL[phase] ?? phase}
                </Badge>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
