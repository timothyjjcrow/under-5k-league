// What a link says when it's pasted into Discord (Open Graph and X card
// titles and descriptions). Pure, so every sentence is tested; the pages'
// generateMetadata loads the few rows these need (link-preview-metadata.ts).
//
// Discord shows og:title, not the page <title>, and before this most pages
// unfurled as a bare "GGD2L" over one sentence shared by every page, which
// also claimed a "soft 4.5K" limit the US league (Under 5K) doesn't have.

import {
  DRAFT_STATUS,
  MATCH_STATUS,
  SEASON_STATUS,
} from "./constants";
import { LEAGUE_CONFIG } from "./league-config";
import { announcedMatchNight, type FixtureKickoff } from "./match-night";
import { leaguePitch, mmrCeilingPhrase, seasonPhaseLabel } from "./season-copy";
import { formatLeagueTime } from "./zoned-time";

export type LinkPreview = { title: string; description: string };

/**
 * The site-wide description: the root layout's default and the installed
 * app's. The hard ceiling is the only MMR line the site enforces
 * (registrationGate); a season's soft limit is only a review threshold, so it
 * doesn't belong in a sentence that outlives every season.
 */
export function siteDescription(): string {
  return `${leaguePitch()} Open to players ${mmrCeilingPhrase()}, on ${LEAGUE_CONFIG.gameServerRegion} servers.`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A time that hasn't happened yet, on the league's own clock; else null. */
function upcoming(date: Date | null, nowMs: number): string | null {
  return date && date.getTime() > nowMs ? formatLeagueTime(date) : null;
}

export type HomePreviewSeason = {
  name: string;
  status: string;
  /** The auction's own state inside the DRAFT phase. */
  draftStatus: string | null;
  /** ACTIVE player signups (standins aside), as Home counts them. */
  playerCount: number;
  draftAt: Date | null;
  /** Season.matchSchedule: the admin-set match night, when there is one. */
  matchSchedule: string | null;
  /** The season's fixtures, which name the night once they have kickoffs
   *  (lib/match-night). Only the regular season's preview reads them. */
  fixtures: readonly FixtureKickoff[];
  /** The champion public pages may name (resolveChampionPresentation). */
  championName: string | null;
};

/**
 * Home's preview, which is what "Copy invite link" shares: the season and its
 * phase in the header chip's words, then what a visitor can do now. Null is
 * the offseason.
 */
export function homePreview(
  season: HomePreviewSeason | null,
  nowMs: number,
): LinkPreview {
  if (!season) {
    return { title: LEAGUE_CONFIG.name, description: siteDescription() };
  }
  const title = `${season.name} · ${seasonPhaseLabel(season.status, season.draftStatus)}`;
  const draftNight = upcoming(season.draftAt, nowMs);
  switch (season.status) {
    case SEASON_STATUS.SIGNUPS: {
      const facts = [
        season.playerCount > 0
          ? `${plural(season.playerCount, "player", "players")} signed up`
          : "Signups just opened",
        draftNight ? `Draft ${draftNight}` : null,
      ].filter(Boolean);
      // The pitch first: this is what "Copy invite link" unfurls into, often
      // for a friend who has never heard of the league, so it says what the
      // league is and which servers it plays on before the count.
      return {
        title,
        description: `${leaguePitch()} ${facts.join(" · ")}. Open to players ${mmrCeilingPhrase()}, on ${LEAGUE_CONFIG.gameServerRegion} servers. Sign in with Steam to join.`,
      };
    }
    case SEASON_STATUS.DRAFT: {
      const description =
        season.draftStatus === DRAFT_STATUS.IN_PROGRESS
          ? "The draft is live: captains are bidding for players now."
          : season.draftStatus === DRAFT_STATUS.PAUSED
            ? "The draft is paused for now."
            : season.draftStatus === DRAFT_STATUS.COMPLETE
              ? "The teams are set. The regular season starts soon."
              : draftNight
                ? `Draft night: ${draftNight}. Captains bid for players in a live auction.`
                : "Captains bid for players in a live auction on draft night.";
      return { title, description };
    }
    case SEASON_STATUS.REGULAR_SEASON: {
      // The same night /me and Schedule print; nothing when none is set.
      const night = announcedMatchNight(season, season.fixtures);
      return {
        title,
        description: `Standings, fixtures and results.${night ? ` Match night: ${night}.` : ""}`,
      };
    }
    case SEASON_STATUS.PLAYOFFS:
      return {
        title,
        description: "The playoff bracket, results and the road to the grand final.",
      };
    case SEASON_STATUS.COMPLETE:
      return {
        title,
        description: season.championName
          ? `${season.championName} won ${season.name}. Final standings, the bracket and every result.`
          : "Final standings and every result.",
      };
    default:
      return { title, description: siteDescription() };
  }
}

export type SeasonPage = "schedule" | "teams" | "players" | "draft";

export type SeasonPagePreviewSeason = {
  name: string;
  status: string;
  draftAt: Date | null;
};

const SEASON_PAGE_TITLES: Record<SeasonPage, string> = {
  schedule: "Schedule",
  teams: "Teams",
  players: "Players",
  draft: "Draft",
};

/**
 * A season page's preview: its name, and the active season in the text.
 * Between seasons the text says what the page holds without one.
 */
export function seasonPagePreview(
  page: SeasonPage,
  season: SeasonPagePreviewSeason | null,
  nowMs: number,
): LinkPreview {
  const league = LEAGUE_CONFIG.name;
  const name = season?.name;
  let description: string;
  switch (page) {
    case "schedule":
      description = name
        ? `${name} fixtures, kickoff times, results and standings in ${league}.`
        : `Fixtures, results and standings in ${league}.`;
      break;
    case "teams":
      description = name
        ? `${name} teams, rosters and results in ${league}.`
        : `Teams, rosters and results in ${league}.`;
      break;
    case "players":
      description = name
        ? `Every ${name} signup, standin and roster in ${league}.`
        : `The players of ${league}.`;
      break;
    case "draft": {
      const draftNight =
        season?.status === SEASON_STATUS.SIGNUPS ||
        season?.status === SEASON_STATUS.DRAFT
          ? upcoming(season.draftAt, nowMs)
          : null;
      description = `${name ? `The ${name} draft` : "The draft"}: captains bid for players in a live auction.${draftNight ? ` Draft night: ${draftNight}.` : ""}`;
      break;
    }
  }
  return { title: SEASON_PAGE_TITLES[page], description };
}

export type MatchPreviewInput = {
  /** matchRoundLabel: "Week 3", "Semifinal", "Grand final"... */
  round: string;
  seasonName: string;
  homeTeamId: string;
  awayTeamId: string;
  homeName: string;
  awayName: string;
  status: string;
  homeScore: number;
  awayScore: number;
  winnerTeamId: string | null;
  /** At least part of the score was ruled (a forfeit or manual result). */
  forfeit: boolean;
  scheduledAt: Date | null;
  bestOf: number;
};

type SeriesResult = Pick<
  MatchPreviewInput,
  "homeTeamId" | "awayTeamId" | "homeScore" | "awayScore" | "winnerTeamId"
>;

/**
 * The side that won a completed series: the recorded winner, else the higher
 * score (older rows may not name one). Null for a draw.
 */
export function seriesWinnerSide(match: SeriesResult): "home" | "away" | null {
  const h = match.homeScore;
  const a = match.awayScore;
  if (match.winnerTeamId === match.homeTeamId || (!match.winnerTeamId && h > a)) {
    return "home";
  }
  if (match.winnerTeamId === match.awayTeamId || (!match.winnerTeamId && a > h)) {
    return "away";
  }
  return null;
}

/**
 * A completed series in words: "Radiant Rascals won 2–1", "Drawn 1–1", with
 * "(ruled result)" after a forfeit or manual result. The link preview's text
 * and its picture both say it this way.
 */
export function seriesResultText(
  match: SeriesResult & { forfeit: boolean },
  names: { home: string; away: string },
): string {
  const h = match.homeScore;
  const a = match.awayScore;
  const winner = seriesWinnerSide(match);
  const result = winner
    ? `${names[winner]} won ${Math.max(h, a)}–${Math.min(h, a)}`
    : `Drawn ${h}–${a}`;
  return match.forfeit ? `${result} (ruled result)` : result;
}

/**
 * A match's preview: the round and teams, then the kickoff before it's
 * played, the live score during it, or the result after.
 */
export function matchPreview(match: MatchPreviewInput): LinkPreview {
  const title = `${match.round} · ${match.homeName} vs ${match.awayName}`;
  const series = `Best of ${match.bestOf}`;
  const h = match.homeScore;
  const a = match.awayScore;
  let state: string;
  if (match.status === MATCH_STATUS.COMPLETED) {
    state = seriesResultText(match, {
      home: match.homeName,
      away: match.awayName,
    });
  } else if (match.status === MATCH_STATUS.LIVE || h + a > 0) {
    state = `Live · ${h}–${a} · ${series}`;
  } else {
    state = `${match.scheduledAt ? formatLeagueTime(match.scheduledAt) : "Kickoff time to be set"} · ${series}`;
  }
  return { title, description: `${match.seasonName} · ${state}` };
}
