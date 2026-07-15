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
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-sm">
            <div className="flex items-center gap-3">
              <span className="grid h-16 place-items-center rounded-xl bg-gradient-to-br from-brand to-brand/60 px-6 font-display text-4xl font-bold uppercase tracking-tight text-brand-fg shadow-lg shadow-brand/30 ring-1 ring-white/15">
                GGD2L
              </span>
            </div>
            <p className="mt-2 text-sm text-muted">
              A drafted, team-based Dota 2 league built around a soft 4.5K MMR
              limit.
            </p>
            <DiscordButton size="sm" className="mt-4" />
          </div>
          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm"
          >
            <div className="flex min-w-0 flex-col gap-2">
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
            </div>
            <div className="flex min-w-0 flex-col gap-2">
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
            </div>
          </nav>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-4 text-xs text-muted">
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
