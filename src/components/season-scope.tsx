import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState, PageTitle } from "@/components/ui";
import {
  seasonHref,
  showSeasonSwitcher,
  type SeasonChoice,
} from "@/lib/season-choices";

/**
 * The one season picker for Leaders, Hero meta, the Record book, Pick'em and
 * Fantasy (they used to have a chip bar, a row of buttons and a dropdown with
 * a submit button). Renders nothing until there are two seasons to choose
 * between, so a league's first season never sees it.
 */
export function SeasonSwitcher({
  label,
  basePath,
  seasons,
  selectedId,
  allSeasons = false,
}: {
  /** Named in the accessible label: "Choose a season for {label}". */
  label: string;
  basePath: string;
  /** From loadSeasonChoices / seasonSwitcherChoices, newest first. */
  seasons: SeasonChoice[];
  /** The season on screen; null on an all-seasons view. */
  selectedId: string | null;
  /** The bare address shows every season (the Record book). */
  allSeasons?: boolean;
}) {
  if (!showSeasonSwitcher(seasons, { allSeasons, selectedId })) return null;
  const options = [
    ...(allSeasons
      ? [{ key: "all", href: basePath, name: "All seasons", current: !selectedId }]
      : []),
    ...seasons.map((season) => ({
      key: season.id,
      href: seasonHref(basePath, season, { allSeasons }),
      name: `${season.name}${season.isActive ? " · Current" : ""}`,
      current: season.id === selectedId,
    })),
  ];
  return (
    <nav
      aria-label={`Choose a season for ${label}`}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface/55 px-4 py-3"
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-muted">
        Season
      </span>
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
        {options.map((option) => (
          <Link
            key={option.key}
            href={option.href}
            aria-current={option.current ? "page" : undefined}
            className={
              option.current
                ? "inline-flex min-h-10 shrink-0 items-center rounded-lg border border-accent/50 bg-accent/10 px-3 text-xs font-semibold text-fg"
                : "inline-flex min-h-10 shrink-0 items-center rounded-lg border border-line px-3 text-xs text-muted transition-colors hover:border-info/50 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
            }
          >
            {option.name}
          </Link>
        ))}
      </div>
    </nav>
  );
}

/**
 * A season-scoped page before the league has any season at all. With a
 * season on record the page opens on it instead (resolveSeasonScope), so this
 * is only ever a brand-new league's screen.
 */
export function NoSeasonYet({
  title,
  children,
}: {
  title: string;
  /** Page chrome that still belongs above the note (the Statistics nav). */
  children?: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <PageTitle title={title} />
      {children}
      <EmptyState
        title="No seasons yet"
        description="This page fills in once the league's first season is under way."
      />
    </div>
  );
}
