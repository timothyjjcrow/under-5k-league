// Pure rules for the season-scoped pages (Leaders, Hero meta, Record book,
// Pick'em, Fantasy): which seasons their one season picker offers, where each
// choice links, and the link from a finished season's boards to its page.
// The database side (which seasons have data, resolving ?season=) lives in
// season-scope.ts.

import { SEASON_STATUS } from "./constants";

/** A season a page can switch to. */
export type SeasonChoice = { id: string; name: string; isActive: boolean };

/** Every season, newest first, flagged with whether it has anything to show
 *  on the page asking (games, pick'em predictions or fantasy entries). */
export type SeasonChoiceRow = SeasonChoice & { hasData: boolean };

/**
 * The seasons a page's picker offers, in the rows' order (newest first): each
 * season with something to show, plus the season being viewed and, unless
 * the page opts out, the current season, so there is always a way back to
 * the page's default.
 */
export function seasonSwitcherChoices(
  rows: readonly SeasonChoiceRow[],
  {
    selectedId,
    includeActive = true,
  }: { selectedId?: string | null; includeActive?: boolean },
): SeasonChoice[] {
  return rows
    .filter(
      (row) =>
        row.hasData ||
        row.id === selectedId ||
        (includeActive && row.isActive),
    )
    .map(({ id, name, isActive }) => ({ id, name, isActive }));
}

/**
 * Whether the picker renders at all. One season has nothing to switch to, so
 * a league with one season never sees it. A page whose bare address is every
 * season (the Record book's "All seasons") keeps it while one season is
 * picked, as the way back to the all-time view.
 */
export function showSeasonSwitcher(
  choices: readonly SeasonChoice[],
  { allSeasons = false, selectedId }: {
    allSeasons?: boolean;
    selectedId?: string | null;
  },
): boolean {
  return choices.length >= 2 || (allSeasons && !!selectedId);
}

/**
 * Where a season choice links. On most pages the bare address already shows
 * the current season, so that choice drops the query; on an all-seasons page
 * every season needs its own ?season=.
 */
export function seasonHref(
  basePath: string,
  season: { id: string; isActive: boolean },
  { allSeasons = false }: { allSeasons?: boolean } = {},
): string {
  if (season.isActive && !allSeasons) return basePath;
  return `${basePath}?${new URLSearchParams({ season: season.id })}`;
}

/**
 * The link from a finished season's boards to that season's own page, which
 * holds its champion, bracket and season awards: its recap, archived or not
 * ("Season history" is the list of every season, /seasons). None while the
 * season is still running: that page would only repeat the boards.
 */
export function finishedSeasonLink(season: {
  id: string;
  isActive: boolean;
  status: string;
}): { href: string; label: string } | null {
  const href = `/seasons/${encodeURIComponent(season.id)}`;
  if (!season.isActive || season.status === SEASON_STATUS.COMPLETE) {
    return { href, label: "Season recap" };
  }
  return null;
}
