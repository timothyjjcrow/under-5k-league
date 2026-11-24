// The admin area's tabs: /admin (Overview) and one route per tab under it,
// and the tab that renders each admin card. One map, so the tab bar, every
// link into the admin from the site or Discord, the forwarder for old
// /admin#… links and the guards all agree on where a card lives.
import { ADMIN_MATCH_ROW_PREFIX } from "./match-anchors";

export type AdminTabId =
  | "overview"
  | "season"
  | "matches"
  | "people"
  | "inhouse"
  | "discord"
  | "system";

export type AdminTab = {
  id: AdminTabId;
  /** The tab's name in the tab bar. */
  label: string;
  path: string;
  /** What the tab holds, under the page title. */
  subtitle: string;
};

/** The tabs, in the order the tab bar shows them. */
export const ADMIN_TABS: readonly AdminTab[] = [
  {
    id: "overview",
    label: "Overview",
    path: "/admin",
    subtitle: "What needs you now, tonight's matches and the league's phase.",
  },
  {
    id: "season",
    label: "Season",
    path: "/admin/season",
    subtitle:
      "Set up the season: its settings, the league id, its format, the draft, turnout and the handoff.",
  },
  {
    id: "matches",
    label: "Matches",
    path: "/admin/matches",
    subtitle: "Results, tiebreakers, playoffs, standins and automatic imports.",
  },
  {
    id: "people",
    label: "People",
    path: "/admin/people",
    subtitle:
      "Teams and captains, roster moves, signups, Discord links and medal-limit approvals.",
  },
  {
    id: "inhouse",
    label: "Inhouse",
    path: "/admin/inhouse",
    subtitle:
      "The inhouse night, every player's inhouse MMR, medal and bans, and inhouse on Discord.",
  },
  {
    id: "discord",
    label: "Discord & news",
    path: "/admin/discord",
    subtitle:
      "League announcements and the Discord bot, league news and the match stream link.",
  },
  {
    id: "system",
    label: "System",
    path: "/admin/system",
    subtitle:
      "Automation, the database, historical records, activity, reports and security.",
  },
];

/**
 * The tab each card renders on, by the card's anchor id. Only cards a link
 * can target are listed; a card's inner ids (the breaks box, a result row's
 * help) move with their card.
 */
export const ADMIN_SECTION_TAB: Readonly<Record<string, AdminTabId>> = {
  "adm-attention": "overview",
  "adm-tonight": "overview",
  "adm-season": "overview",
  "adm-settings": "season",
  "adm-league": "season",
  "adm-format": "season",
  "adm-draft": "season",
  "adm-roll-call": "season",
  "adm-poll": "season",
  "adm-new-season": "season",
  "adm-tiebreakers": "matches",
  "adm-schedule": "matches",
  "adm-playoffs": "matches",
  "adm-standins": "matches",
  "adm-sync": "matches",
  "adm-teams": "people",
  "adm-roster": "people",
  "adm-signups": "people",
  "adm-reach": "people",
  // MEDAL_APPROVALS_ANCHOR (medal-approval.ts), spelled out so this file
  // stays free of the signup rules it imports; admin-tabs.test.ts pins it.
  "adm-medal-approvals": "people",
  "adm-inhouse-night": "inhouse",
  "adm-inhouse-players": "inhouse",
  "adm-inhouse-discord": "inhouse",
  "adm-discord": "discord",
  "adm-news": "discord",
  "adm-stream": "discord",
  "adm-automation": "system",
  "adm-database": "system",
  "adm-history": "system",
  "adm-activity": "system",
  "adm-security": "system",
};

/**
 * Anchors no card carries any more, and where they land now: the folded
 * "<season> record" section held the finished season's schedule, /schedule
 * linked the Playoffs card by a stray `id="playoffs"`, Captains & draft split
 * into Draft (Season) and Teams and Signups (People), and the season
 * settings left the phase card for their own card on Season.
 */
const RETIRED_ANCHORS: Readonly<Record<string, string>> = {
  "adm-record": "adm-schedule",
  playoffs: "adm-playoffs",
  "adm-captains": "adm-draft",
  "adm-season-settings": "adm-settings",
};

export function adminTab(id: AdminTabId): AdminTab {
  return ADMIN_TABS.find((tab) => tab.id === id)!;
}

/**
 * Where an anchor lives now: its tab and the id to land on, or null for an
 * id no admin card answers to. A match's result row (`adm-match-<id>`) is
 * on Matches.
 */
export function adminAnchorTarget(
  anchor: string,
): { tab: AdminTabId; id: string } | null {
  const id = anchor.replace(/^#/, "");
  const current = RETIRED_ANCHORS[id] ?? id;
  const tab = ADMIN_SECTION_TAB[current];
  if (tab) return { tab, id: current };
  if (current.startsWith(ADMIN_MATCH_ROW_PREFIX) && current.length > ADMIN_MATCH_ROW_PREFIX.length)
    return { tab: "matches", id: current };
  return null;
}

/**
 * The link to an admin card from anywhere: its tab's path and the card's
 * anchor (`#adm-standins` → `/admin/matches#adm-standins`). A path is
 * already a link and passes through (the next step on draft night opens
 * `/draft`). An id no card answers to links to Overview with the hash
 * kept, which the forwarder there leaves alone.
 */
export function adminHref(anchor: string): string {
  if (anchor.startsWith("/")) return anchor;
  const target = adminAnchorTarget(anchor);
  if (!target) return `/admin#${anchor.replace(/^#/, "")}`;
  return `${adminTab(target.tab).path}#${target.id}`;
}

/**
 * Where an old one-page link (`/admin?…#anchor`) belongs now: the tab path
 * with the query and the current anchor, or null when it already is on
 * Overview or names no card.
 */
export function adminForwardHref(search: string, hash: string): string | null {
  const target = adminAnchorTarget(hash);
  if (!target || target.tab === "overview") return null;
  return `${adminTab(target.tab).path}${search}#${target.id}`;
}
