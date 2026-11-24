import { adminSeasonCards } from "@/lib/admin-sections";
import { rosterPingsLive, unlinkedRoster } from "@/lib/admin-attention";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "@/lib/constants";
import { formatEditState } from "@/lib/season-builder";
import { regularSeasonStatus } from "@/lib/schedule-status";
import type { AdminData, Season } from "@/components/admin/season-admin-data";

/**
 * Which optional cards actually render, so the jump bar and the cards can never
 * disagree.
 *
 * `AdminJump` listed every anchor unconditionally, but two cards return null in
 * some phases — Roster moves (wrong phase, live auction, or nothing to move) and
 * Auto-sync (only REGULAR_SEASON/PLAYOFFS). A chip that scrolls nowhere reads as
 * a broken page, and on a sticky nav the admin is using to find a control under
 * time pressure it is worse than that: it looks like the tool is gone. One
 * predicate, two consumers — the ROW_GRID discipline.
 */
export function rosterMovesVisible(season: Season, data: AdminData): boolean {
  if (season.status === "SIGNUPS" || season.status === "COMPLETE") return false;
  // `?.status !== COMPLETE`, so a MISSING Draft row counts as "the auction
  // hasn't run" — matching the actions. In the DRAFT phase with no draft row
  // (reachable by clicking the Draft phase button before Start draft) the
  // sign/release forms must stay hidden, or the $0 free-agent path bypasses
  // the auction entirely. PROMOTION is the one exception: promoteGateError
  // explicitly blesses the pre-start window ("they'll be auctioned normally"),
  // and a late joiner who filed as a standin the week before draft night is
  // exactly who it serves — yet the form had no render anywhere in that
  // window, so the only workaround was re-opening signups league-wide to move
  // one person. The card shows with ONLY the promote form (see preStart in
  // RosterMoves); a LIVE/PAUSED auction still hides everything.
  if (
    season.status === "DRAFT" &&
    data.draft?.status !== DRAFT_STATUS.COMPLETE
  ) {
    const preStart =
      !data.draft || data.draft.status === DRAFT_STATUS.NOT_STARTED;
    if (!preStart) return false;
    const rostered = new Set(
      data.teams.flatMap((t) => t.members.map((m) => m.userId)),
    );
    return data.standins.some(
      (s) => s.type === REGISTRATION_TYPE.STANDIN && !rostered.has(s.userId),
    );
  }
  const rosteredIds = new Set(
    data.teams.flatMap((t) => t.members.map((m) => m.userId)),
  );
  // A WITHDRAWN team is not a signing target and not a short-team alarm: its
  // fixtures are all forfeited, so "short" is its permanent normal state and
  // the alarm would cry wolf all season — the reason the team most likely to
  // BE short (it usually withdrew because players left) must be excluded
  // here. It stays releasable: freeing its players for standin duty is the
  // documented post-withdrawal cleanup.
  const liveTeams = data.teams.filter((t) => !t.withdrawn);
  const canSign =
    data.players.some((p) => !rosteredIds.has(p.userId)) &&
    liveTeams.some((t) => t.members.length < season.teamSize);
  const releasable = data.teams.some((t) =>
    t.members.some((m) => !m.isCaptain),
  );
  const promotable = data.standins.some(
    (s) => s.type === REGISTRATION_TYPE.STANDIN && !rosteredIds.has(s.userId),
  );
  // A SHORT team keeps the card open even when nothing can be done about it
  // yet: "this team is a player down" is the thing the admin most needs to
  // know, and it used to disappear precisely when no free agent existed.
  const short = liveTeams.some((t) => t.members.length < season.teamSize);
  return canSign || releasable || promotable || short;
}

export function autoSyncVisible(season: Season): boolean {
  return season.status === "REGULAR_SEASON" || season.status === "PLAYOFFS";
}

/** The auction has finished (or the season has moved past it): rosters are real. */
export function draftRostersReady(season: Season, data: AdminData): boolean {
  return (
    data.draft?.status === DRAFT_STATUS.COMPLETE ||
    season.status === SEASON_STATUS.REGULAR_SEASON ||
    season.status === SEASON_STATUS.PLAYOFFS ||
    season.status === SEASON_STATUS.COMPLETE
  );
}

/**
 * The unlinked players and booked standins match-night pings are for, or null
 * while pings still go to signups (or the season is over). Needs attention
 * counts this list and the Discord reach card names it.
 */
export function unlinkedRosterFor(season: Season, data: AdminData): string[] | null {
  if (!rosterPingsLive(season.status, draftRostersReady(season, data)))
    return null;
  const openIds = new Set(
    data.matches
      .filter((match) => match.status !== MATCH_STATUS.COMPLETED)
      .map((match) => match.id),
  );
  return unlinkedRoster(data.teams, data.assignments, openIds);
}

/**
 * Where the season builder renders, for the page and every link to it: its
 * own Season format card while captains are picked (`setupFirst`) and the
 * schedule card is hidden, else inside Schedule & results. Only one renders.
 */
export function formatBuilderAnchor(season: Season, data: AdminData): "#adm-format" | "#adm-schedule" {
  const draftStatus = data.draft?.status ?? null;
  const setupFirst =
    season.status === SEASON_STATUS.SIGNUPS ||
    (season.status === SEASON_STATUS.DRAFT && draftStatus !== DRAFT_STATUS.COMPLETE);
  const scheduleCard = adminSeasonCards({
    seasonStatus: season.status,
    draftStatus,
    matches: data.matches,
    openBookings: 0,
    archivedPostseasonGames: 0,
  }).schedule;
  return setupFirst && !scheduleCard ? "#adm-format" : "#adm-schedule";
}

/** `formatEditState` from the page's data: the counts saveSeasonFormat reads. */
export function seasonFormatEditState(season: Season, data: AdminData) {
  return formatEditState({
    seasonStatus: season.status,
    draftStatus: data.draft?.status ?? null,
    regularFixtures: data.matches.filter((m) => m.phase === MATCH_PHASE.REGULAR).length,
    regularResults: regularSeasonStatus(data.matches).completed,
    games: data.matches.reduce((sum, match) => sum + match.games.length, 0),
  });
}
