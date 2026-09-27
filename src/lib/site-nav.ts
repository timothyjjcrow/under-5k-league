// The site's navigation, defined ONCE.
//
// Every surface that lists pages builds its list from this file: the desktop
// header row, the Explore dropdown, the phone tab bar and its one menu sheet,
// and the footer. Before this, the header
// and footer each kept their own lists, so the same page had up to three names
// ("Meta"/"Hero meta", "News"/"League news", "Features"/"Feature tour",
// "History"/"Past seasons"/"Season history") and two different groupings, and
// the schedule was renamed by phase ("Playoffs", "Season results", "Matches").
// A page now has one label, one group and one visibility rule, here.
//
// Pure on purpose (no React, no Prisma): the client header, the server footer
// and the unit tests all import it.

import { SEASON_STATUS } from "./constants";
import { featureAvailability } from "./features-lifecycle";

/**
 * `season` pages are the league's own chapter and sit in the primary row (the
 * desktop header, the phone tab bar and the top of its sheet). The other
 * three are the Explore groups, in this order everywhere.
 */
export type NavGroup = "season" | "play" | "stats" | "league";

type ExploreGroup = Exclude<NavGroup, "season">;

const EXPLORE_GROUPS: readonly ExploreGroup[] = ["play", "stats", "league"];

const EXPLORE_GROUP_LABEL: Record<ExploreGroup, string> = {
  play: "Play",
  stats: "Statistics",
  league: "League",
};

/** What decides which pages a visitor is offered right now. */
export type NavState = {
  /** The active season's status; null in the offseason. */
  phase: string | null;
  /** The active season's auction status. Only read during DRAFT. */
  draftStatus: string | null;
  /** At least one archived season exists. */
  hasHistory: boolean;
};

export type NavLink = { href: string; label: string };

type NavPage = NavLink & {
  group: NavGroup;
  visible: (state: NavState) => boolean;
};

const always = () => true;

const teamsExist = ({ phase }: NavState) =>
  phase === SEASON_STATUS.DRAFT ||
  phase === SEASON_STATUS.REGULAR_SEASON ||
  phase === SEASON_STATUS.PLAYOFFS ||
  phase === SEASON_STATUS.COMPLETE;

// Schedule, Fantasy and Pick'em have nothing to show until the auction has
// sold every roster: before that they open onto "opens after the draft"
// screens. This is the feature tour's own POST_AUCTION rule, so the menus and
// the tour agree. A completed auction can publish fixtures before the admin
// moves the season on, which is why this reads the auction and not the phase.
const afterAuction = ({ phase, draftStatus }: NavState) =>
  featureAvailability("POST_AUCTION", phase, draftStatus).available;

const resultsPhase = ({ phase }: NavState) =>
  phase === SEASON_STATUS.REGULAR_SEASON ||
  phase === SEASON_STATUS.PLAYOFFS ||
  phase === SEASON_STATUS.COMPLETE;

/**
 * Every page any menu can list, in display order within its group. Pages that
 * are not listed right now stay reachable by their address.
 */
const NAV_PAGES: readonly NavPage[] = [
  { href: "/", label: "Home", group: "season", visible: always },
  { href: "/players", label: "Players", group: "season", visible: always },
  // Inhouse is a standalone pick-up mode: available season or not.
  { href: "/inhouse", label: "Inhouse", group: "season", visible: always },
  { href: "/teams", label: "Teams", group: "season", visible: teamsExist },
  {
    href: "/draft",
    label: "Draft",
    group: "season",
    visible: ({ phase }) => phase === SEASON_STATUS.DRAFT,
  },
  // ONE name in every phase. The page's own heading still says "Playoffs"
  // or names the champion; the link is how people find it, and a link that
  // changes its name with the phase reads as a different page.
  { href: "/schedule", label: "Schedule", group: "season", visible: afterAuction },
  {
    href: "/recap",
    label: "Season recap",
    group: "season",
    visible: ({ phase }) => phase === SEASON_STATUS.COMPLETE,
  },
  // Scrims are listed in every phase: the archive stays useful between
  // seasons.
  { href: "/scrims", label: "Scrims", group: "play", visible: always },
  { href: "/fantasy", label: "Fantasy", group: "play", visible: afterAuction },
  { href: "/pickem", label: "Pick'em", group: "play", visible: afterAuction },
  { href: "/leaders", label: "Leaders", group: "stats", visible: resultsPhase },
  { href: "/meta", label: "Hero meta", group: "stats", visible: resultsPhase },
  // Same order as the statistics pages' own tab bar (stats-nav.tsx).
  { href: "/records", label: "Record book", group: "stats", visible: always },
  {
    href: "/players/compare",
    label: "Compare players",
    group: "stats",
    visible: always,
  },
  { href: "/news", label: "League news", group: "league", visible: always },
  { href: "/features", label: "Feature tour", group: "league", visible: always },
  { href: "/hall-of-fame", label: "Hall of Fame", group: "league", visible: always },
  {
    href: "/seasons",
    label: "Season history",
    group: "league",
    visible: ({ hasHistory }) => hasHistory,
  },
];

/**
 * The primary row: the season's own pages that are useful right now. The
 * viewer's own team ("My Team") sits where Teams does whenever they are on a
 * roster, including a captain whose team exists before the draft.
 */
export function seasonNav(
  state: NavState,
  myTeamId: string | null = null,
): NavLink[] {
  const links: NavLink[] = [];
  for (const page of NAV_PAGES) {
    if (page.group !== "season") continue;
    if (page.visible(state)) {
      links.push({ href: page.href, label: page.label });
    }
    if (page.href === "/teams" && myTeamId) {
      links.push({ href: `/teams/${myTeamId}`, label: "My Team" });
    }
  }
  return links;
}

export type DockIconName = "home" | "matches" | "team";

export type DockTab = NavLink & { icon: DockIconName };

/**
 * The phone tab bar and its one menu sheet. The bar holds three pages (Home,
 * the season's current focus, and the viewer's team or the player list) and
 * a last slot that opens the sheet. The sheet lists every OTHER primary page,
 * so no page is ever both a tab and a sheet entry; the Explore groups follow
 * it. Phones used to have a ☰ menu as well, which listed the same pages a
 * third time.
 */
export function phoneDock(
  items: NavLink[],
  myTeamHref: string | null,
): { tabs: DockTab[]; sheet: NavLink[] } {
  const has = (href: string) => items.some((item) => item.href === href);
  const slots: { href: string; icon: DockIconName }[] = [
    { href: "/", icon: "home" },
    {
      href: has("/draft")
        ? "/draft"
        : has("/schedule")
          ? "/schedule"
          : "/inhouse",
      icon: "matches",
    },
    {
      href:
        myTeamHref && has(myTeamHref)
          ? myTeamHref
          : has("/teams")
            ? "/teams"
            : "/players",
      icon: "team",
    },
  ];
  const tabs = slots.flatMap(({ href, icon }) => {
    const item = items.find((link) => link.href === href);
    return item ? [{ ...item, icon }] : [];
  });
  const inTabs = new Set(tabs.map((tab) => tab.href));
  return { tabs, sheet: items.filter((item) => !inTabs.has(item.href)) };
}

export type NavSection = { group: NavGroup; label: string; links: NavLink[] };

/** The Explore groups (Play, Statistics, League), skipping empty ones. */
export function exploreNav(state: NavState): NavSection[] {
  return EXPLORE_GROUPS.map((group) => ({
    group,
    label: EXPLORE_GROUP_LABEL[group],
    links: NAV_PAGES.filter(
      (page) => page.group === group && page.visible(state),
    ).map(({ href, label }) => ({ href, label })),
  })).filter((section) => section.links.length > 0);
}
