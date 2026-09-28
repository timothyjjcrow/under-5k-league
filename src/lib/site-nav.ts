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

import { DRAFT_STATUS, REGISTRATION_STATUS, SEASON_STATUS } from "./constants";
import { draftPhasePresentation, seasonPhaseLabel } from "./season-copy";

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

/**
 * What the league has on record, and the viewer's own stake in it. A page is
 * only offered once it has something to show: a league with no games yet (a
 * new region, or the first weeks of a new league) used to list a Record book,
 * Compare players and Hall of Fame that each opened onto an empty page.
 */
export type NavContent = {
  /** At least one archived season exists. */
  hasHistory: boolean;
  /** A league game has been imported, in any season. */
  hasGames: boolean;
  /** Some season has crowned a champion. */
  hasChampion: boolean;
  /** The active season's fantasy rosters are locked: its first game is in. */
  fantasyLocked: boolean;
  /** The viewer has a fantasy roster in the active season. */
  fantasyEntered: boolean;
};

/** What decides which pages a visitor is offered right now. */
export type NavState = NavContent & {
  /** The active season's status; null in the offseason. */
  phase: string | null;
  /** The active season's auction status. Only read during DRAFT. */
  draftStatus: string | null;
  /**
   * Draft night is close and the auction hasn't started (draftNightSoon,
   * SIGNUPS only): the draft room is linked before Start, so people are in
   * the room when the auction goes live.
   */
  draftRoomSoon?: boolean;
  /** The active season's id: a finished season's menus link its own page. */
  seasonId?: string | null;
};

export type NavLink = { href: string; label: string };

type NavPage = NavLink & {
  group: NavGroup;
  visible: (state: NavState) => boolean;
  /** The address when it depends on the state; `href` is the fallback. */
  resolveHref?: (state: NavState) => string;
  /** Also linked from the footer, which is no second site map. */
  footer?: true;
};

function linkFor(page: NavPage, state: NavState): NavLink {
  return { href: page.resolveHref?.(state) ?? page.href, label: page.label };
}

const always = () => true;

const teamsExist = ({ phase }: NavState) =>
  phase === SEASON_STATUS.DRAFT ||
  phase === SEASON_STATUS.REGULAR_SEASON ||
  phase === SEASON_STATUS.PLAYOFFS ||
  phase === SEASON_STATUS.COMPLETE;

// Schedule, Fantasy and Pick'em have nothing to show until the auction has
// sold every roster: before that they open onto "opens after the draft"
// screens (Fantasy narrows this further, below). A completed auction can
// publish fixtures before the admin moves the season on, which is why this
// reads the auction and not only the phase: DRAFT alone is not enough, since
// the auction can still be waiting, live or paused inside it.
const afterAuction = ({
  phase,
  draftStatus,
}: Pick<NavState, "phase" | "draftStatus">) =>
  (phase === SEASON_STATUS.DRAFT && draftStatus === DRAFT_STATUS.COMPLETE) ||
  phase === SEASON_STATUS.REGULAR_SEASON ||
  phase === SEASON_STATUS.PLAYOFFS ||
  phase === SEASON_STATUS.COMPLETE;

const resultsPhase = ({ phase }: NavState) =>
  phase === SEASON_STATUS.REGULAR_SEASON ||
  phase === SEASON_STATUS.PLAYOFFS ||
  phase === SEASON_STATUS.COMPLETE;

// The statistics pages fill from imported games; until the league has one,
// each opens onto "No stats yet".
const gamesOnRecord = ({ hasGames }: NavState) => hasGames;

// Leaders and Hero meta show the active season, so they also wait for it to
// reach the regular season (they have a switcher for past seasons).
const seasonStats = (state: NavState) => resultsPhase(state) && state.hasGames;

type FantasyNavState = Pick<
  NavState,
  "phase" | "draftStatus" | "fantasyLocked" | "fantasyEntered"
>;

/**
 * Fantasy's pick window: from the completed auction (it picks from the
 * drafted rosters) until rosters lock at the season's first imported game.
 * A completed season is read-only.
 */
export function fantasyPickWindowOpen(state: FantasyNavState): boolean {
  return (
    afterAuction(state) &&
    state.phase !== SEASON_STATUS.COMPLETE &&
    !state.fantasyLocked
  );
}

/**
 * Fantasy is promoted while picks are open, and after the lock only to the
 * managers who entered, who have standings to follow. Everyone else used to
 * be sent all season to "Rosters are locked… Catch the next season!". The page
 * itself stays reachable by its address. Home's Fantasy tile and the current
 * season's page use this too.
 */
export function fantasyListed(state: FantasyNavState): boolean {
  if (fantasyPickWindowOpen(state)) return true;
  return afterAuction(state) && state.fantasyEntered;
}

/**
 * Every page any menu can list, in display order within its group. Pages that
 * are not listed right now stay reachable by their address.
 */
const NAV_PAGES: readonly NavPage[] = [
  { href: "/", label: "Home", group: "season", visible: always },
  { href: "/players", label: "Players", group: "season", visible: always },
  // Inhouse is a standalone pick-up mode: available season or not.
  {
    href: "/inhouse",
    label: "Inhouse",
    group: "season",
    visible: always,
    footer: true,
  },
  { href: "/teams", label: "Teams", group: "season", visible: teamsExist },
  {
    href: "/draft",
    label: "Draft",
    group: "season",
    visible: ({ phase, draftRoomSoon }) =>
      phase === SEASON_STATUS.DRAFT ||
      (phase === SEASON_STATUS.SIGNUPS && draftRoomSoon === true),
  },
  // ONE name in every phase. The page's own heading still says "Playoffs"
  // or names the champion; the link is how people find it, and a link that
  // changes its name with the phase reads as a different page.
  { href: "/schedule", label: "Schedule", group: "season", visible: afterAuction },
  // A finished season's recap (champion, bracket, stat strip and awards) is
  // that season's own page; /recap only redirects there. Before the final
  // the page only repeats Leaders and the bracket.
  {
    href: "/recap",
    label: "Season recap",
    group: "season",
    visible: ({ phase }) => phase === SEASON_STATUS.COMPLETE,
    resolveHref: ({ seasonId }) =>
      seasonId ? `/seasons/${seasonId}` : "/recap",
  },
  // Scrims are listed in every phase: the archive stays useful between
  // seasons.
  {
    href: "/scrims",
    label: "Scrims",
    group: "play",
    visible: always,
    footer: true,
  },
  { href: "/fantasy", label: "Fantasy", group: "play", visible: fantasyListed },
  { href: "/pickem", label: "Pick'em", group: "play", visible: afterAuction },
  { href: "/leaders", label: "Leaders", group: "stats", visible: seasonStats },
  { href: "/meta", label: "Hero meta", group: "stats", visible: seasonStats },
  // Same order as the statistics pages' own tab bar (stats-nav.tsx).
  { href: "/records", label: "Record book", group: "stats", visible: gamesOnRecord },
  {
    href: "/players/compare",
    label: "Compare players",
    group: "stats",
    visible: gamesOnRecord,
  },
  {
    href: "/news",
    label: "League news",
    group: "league",
    visible: always,
    footer: true,
  },
  {
    href: "/how-it-works",
    label: "How it works",
    group: "league",
    visible: always,
    footer: true,
  },
  // Champion history is what makes it a hall of fame; until a season has
  // one, its boards are empty or repeat Leaders.
  {
    href: "/hall-of-fame",
    label: "Hall of Fame",
    group: "league",
    visible: ({ hasChampion }) => hasChampion,
  },
  {
    href: "/seasons",
    label: "Season history",
    group: "league",
    visible: ({ hasHistory }) => hasHistory,
    footer: true,
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
    if (page.visible(state)) links.push(linkFor(page, state));
    if (page.href === "/teams" && myTeamId) {
      links.push({ href: `/teams/${myTeamId}`, label: "My Team" });
    }
  }
  return links;
}

export type HeaderStatus = { label: string; href: string; live: boolean };

/**
 * The header's status chip: what is happening in the league right now.
 * While the auction runs it reads "Draft live" and opens the draft room;
 * while any series is being played it reads "Series live" and opens this
 * week's fixtures. Otherwise it names the phase and links Home. It used to
 * name the phase only, so nothing in the header said a draft or a match was
 * on. `null` in the offseason.
 */
export function headerStatus({
  phase,
  draftStatus,
  seriesLive,
}: {
  phase: string | null;
  draftStatus: string | null;
  /** A match in the active season is LIVE. */
  seriesLive: boolean;
}): HeaderStatus | null {
  if (!phase) return null;
  if (
    phase === SEASON_STATUS.DRAFT &&
    draftPhasePresentation(draftStatus).live
  ) {
    return { label: "Draft live", href: "/draft", live: true };
  }
  if (seriesLive && phase === SEASON_STATUS.REGULAR_SEASON) {
    return { label: "Series live", href: "/schedule#this-week", live: true };
  }
  // The playoff schedule leads with the bracket; it has no week anchor.
  if (seriesLive && phase === SEASON_STATUS.PLAYOFFS) {
    return { label: "Series live", href: "/schedule", live: true };
  }
  return {
    label: seasonPhaseLabel(phase, draftStatus),
    href: "/",
    live: false,
  };
}

/** A button that takes a visitor to the signup form. */
export type JoinCta = { href: string; label: string };

/**
 * During signups, the header and the phone tab bar offer "Join Season N" to
 * anyone who hasn't joined yet, on every page (only Home and Players had a
 * join button before). The rule is Home's: no active signup, not a signup an
 * admin removed, and not already on a roster. It goes where Home's button
 * goes: the signup form on /me, through sign-in when needed.
 */
export function joinSeasonCta({
  phase,
  seasonName,
  signedIn,
  registrationStatus,
  onRoster,
}: {
  phase: string | null;
  seasonName: string | null;
  signedIn: boolean;
  /** The viewer's signup in the active season; null when there is none. */
  registrationStatus: string | null;
  onRoster: boolean;
}): JoinCta | null {
  if (phase !== SEASON_STATUS.SIGNUPS || !seasonName || onRoster) return null;
  if (
    registrationStatus === REGISTRATION_STATUS.ACTIVE ||
    registrationStatus === REGISTRATION_STATUS.REMOVED
  ) {
    return null;
  }
  return {
    href: signedIn ? "/me" : "/login?next=/me",
    // Season names are admin-typed; a long one would crowd the header.
    label:
      seasonName.length <= 16 ? `Join ${seasonName}` : "Join the season",
  };
}

export type DockIconName = "home" | "matches" | "team" | "join";

export type DockTab = NavLink & {
  icon: DockIconName;
  /** The full name when the tab's visible label is shortened. */
  ariaLabel?: string;
};

/**
 * The phone tab bar and its one menu sheet. The bar holds three pages (Home,
 * the season's current focus, and the viewer's team or the player list) and
 * a last slot that opens the sheet. The sheet lists every OTHER primary page,
 * so no page is ever both a tab and a sheet entry; the Explore groups follow
 * it. Phones used to have a ☰ menu as well, which listed the same pages a
 * third time.
 *
 * During signups, a viewer who hasn't joined gets "Join" in the third slot,
 * where Players would be, and Players moves to the sheet. The second slot
 * keeps Inhouse, the one thing to play while signups run: the inhouse queue
 * is never de-promoted. The one exception is draft night (draftRoomSoon):
 * for the few hours before Start the draft room takes that slot, as it does
 * through the whole DRAFT phase, and Inhouse moves to the sheet.
 */
export function phoneDock(
  items: NavLink[],
  myTeamHref: string | null,
  join: JoinCta | null = null,
): { tabs: DockTab[]; sheet: NavLink[] } {
  const has = (href: string) => items.some((item) => item.href === href);
  const pick = (href: string, icon: DockIconName): DockTab[] => {
    const item = items.find((link) => link.href === href);
    return item ? [{ ...item, icon }] : [];
  };
  const focusHref = has("/draft")
    ? "/draft"
    : has("/schedule")
      ? "/schedule"
      : "/inhouse";
  const teamHref =
    myTeamHref && has(myTeamHref)
      ? myTeamHref
      : has("/teams")
        ? "/teams"
        : "/players";
  const tabs: DockTab[] = [
    ...pick("/", "home"),
    ...pick(focusHref, "matches"),
    ...(join
      ? [
          {
            href: join.href,
            label: "Join",
            ariaLabel: join.label,
            icon: "join" as const,
          },
        ]
      : pick(teamHref, "team")),
  ];
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
    ).map((page) => linkFor(page, state)),
  })).filter((section) => section.links.length > 0);
}

/** A listed page's link, under the one name every menu uses. */
function pageLink(href: string): NavLink {
  const page = NAV_PAGES.find((candidate) => candidate.href === href);
  if (!page) throw new Error(`No navigation entry for ${href}`);
  return { href: page.href, label: page.label };
}

/**
 * The 404 page's second way out, after Home. An old Discord link to a
 * fixture or a team usually lands there, so it is the Schedule while the
 * menus list it; before the auction the Schedule only says it opens after
 * the draft, so it is How it works instead.
 */
export function notFoundLink(
  state: Pick<NavState, "phase" | "draftStatus">,
): NavLink {
  return pageLink(afterAuction(state) ? "/schedule" : "/how-it-works");
}

/**
 * The footer's few links. It used to repeat every page from the header and
 * Explore (up to 16 links, a second site map under every page); it now keeps
 * the two ways to play outside the season (Inhouse and Scrims), the league's
 * news, How it works and past seasons, all of which the menus list too.
 */
export function footerNav(state: NavState): NavLink[] {
  return NAV_PAGES.filter((page) => page.footer && page.visible(state)).map(
    (page) => linkFor(page, state),
  );
}
