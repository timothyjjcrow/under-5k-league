/**
 * Geometry for a horizontally scrolling chip bar (the section tabs on team,
 * match, player, admin, inhouse and leaders pages). Pure, so the rules are
 * unit-tested; `SectionNav` only measures the DOM and applies the answers.
 *
 * Two problems on a phone, where the bar is wider than the screen:
 * - A fixed 1rem fade at the right edge said nothing when a chip boundary
 *   happened to land on the edge, so "Overview Matches Roster Heroes" read as
 *   the whole bar while two more sections sat off-screen. The fade now shows
 *   only on a side that really has more chips, and is wide enough to dim the
 *   last visible chip's text, not just its padding.
 * - The highlighted chip followed the reader down the page into chips that
 *   were scrolled out of the bar, so the bar stopped saying where you were.
 *   `revealChipScrollLeft` scrolls the bar (never the page) to bring it back.
 */

/** Width of the edge fade, and how far a revealed chip is kept clear of it. */
export const CHIP_BAR_FADE_PX = 40;

export type ChipBarEdges = { start: boolean; end: boolean };

/** Which sides of the bar have chips scrolled out of view. */
export function chipBarEdges({
  scrollLeft,
  clientWidth,
  scrollWidth,
}: {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}): ChipBarEdges {
  // One pixel of slack: fractional layout widths leave scrollLeft a hair
  // short of the true end, which would keep a fade on a fully scrolled bar.
  return {
    start: scrollLeft > 1,
    end: scrollLeft + clientWidth < scrollWidth - 1,
  };
}

/** The CSS mask for the bar: a fade on each side that has more chips. */
export function chipBarMask(edges: ChipBarEdges): string | undefined {
  const fade = `${CHIP_BAR_FADE_PX}px`;
  if (edges.start && edges.end)
    return `linear-gradient(to right, transparent, black ${fade}, black calc(100% - ${fade}), transparent)`;
  if (edges.end)
    return `linear-gradient(to right, black calc(100% - ${fade}), transparent)`;
  if (edges.start) return `linear-gradient(to right, transparent, black ${fade})`;
  return undefined;
}

/**
 * The bar's new scrollLeft that shows a chip clear of the edge fades, or null
 * when it is already in view. Coordinates are viewport pixels (from
 * getBoundingClientRect), so the answer is independent of offset parents.
 */
export function revealChipScrollLeft({
  bar,
  chip,
  scrollLeft,
  inset = CHIP_BAR_FADE_PX,
}: {
  bar: { left: number; right: number };
  chip: { left: number; right: number };
  scrollLeft: number;
  inset?: number;
}): number | null {
  const room = bar.right - bar.left - 2 * inset;
  let next: number | null = null;
  // A chip wider than the space between the fades: align its start.
  if (chip.right - chip.left > room)
    next = scrollLeft + chip.left - (bar.left + inset);
  else if (chip.left < bar.left + inset)
    next = scrollLeft - (bar.left + inset - chip.left);
  else if (chip.right > bar.right - inset)
    next = scrollLeft + (chip.right - (bar.right - inset));
  if (next === null) return null;
  next = Math.max(0, Math.round(next));
  return next === Math.round(scrollLeft) ? null : next;
}

/**
 * SectionNav highlights the section crossing a reading band: from just under
 * the sticky header down to this fraction of the viewport height (its
 * IntersectionObserver trims the rest off the bottom).
 */
export const SECTION_BAND_BOTTOM = 0.45;

/**
 * Whether the reader is above every section, so the bar should highlight
 * none. The observer only ever SETS a highlight, and at the top of a page the
 * first section starts below the band, so nothing intersects and nothing
 * cleared it: after reading down to Career and back up, the bar still lit
 * "Career" and stayed scrolled sideways past "Overview". `sectionTops` are
 * viewport pixels (getBoundingClientRect().top) of the sections on the page.
 */
export function aboveAllSections({
  anyInBand,
  sectionTops,
  viewportHeight,
}: {
  anyInBand: boolean;
  sectionTops: number[];
  viewportHeight: number;
}): boolean {
  if (anyInBand || sectionTops.length === 0) return false;
  return Math.min(...sectionTops) > viewportHeight * SECTION_BAND_BOTTOM;
}
