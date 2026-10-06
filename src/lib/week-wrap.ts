// The week wrap (/seasons/[id]/weeks/[week]): one page that tells a regular
// week's story from stored results only. These are its pure parts; the page
// loads the season and renders. Upsets, honors and pick'em come from their
// own modules, so the wrap can never disagree with Home, /leaders or Discord.

import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import { fantasyPoints } from "./fantasy";
import type { HonorsGame } from "./honors";
import {
  regularTableBeforeWeek,
  regularWeeksWithResultsBefore,
  type MatchLike,
} from "./standings";

type WeekMatch = MatchLike & { week: number };

export type WeekWrapRow = {
  teamId: string;
  /** 1-based place after the week. */
  rank: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  gameDiff: number;
  /** Places climbed (+) or dropped (−) during the week; null when the table
   *  before it had no results behind it (the all-zero preseason order, whose
   *  "movement" would be alphabetical noise). */
  movement: number | null;
};

/**
 * The regular-season table after `week` (every completed regular result up to
 * and including it, as regularTableBeforeWeek(week + 1) counts them), with
 * each team's movement against the table going into the week.
 */
export function weekWrapTable(
  teamIds: string[],
  matches: readonly WeekMatch[],
  week: number,
): WeekWrapRow[] {
  const after = regularTableBeforeWeek(teamIds, matches, week + 1);
  const moved = regularWeeksWithResultsBefore(matches, week) > 0;
  const beforeRank = new Map(
    regularTableBeforeWeek(teamIds, matches, week).map((row, i) => [row.teamId, i]),
  );
  return after.map((row, i) => ({
    teamId: row.teamId,
    rank: i + 1,
    played: row.played,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
    points: row.points,
    gameDiff: row.gameDiff,
    movement: moved ? (beforeRank.get(row.teamId) ?? i) - i : null,
  }));
}

export type WeekBestGame = {
  userId: string;
  heroId: number | null;
  kills: number;
  deaths: number;
  assists: number;
  /** Impact points, one decimal. */
  impact: number;
  won: boolean;
};

/**
 * The week's best single game: the highest impact line by a league player,
 * then more kills, fewer deaths, then user id, so a tie always lands the
 * same way. From the honors readiness games, so it exists only for a week
 * whose box scores are complete.
 */
export function bestGameOfWeek(games: readonly HonorsGame[]): WeekBestGame | null {
  let best: WeekBestGame | null = null;
  for (const game of games) {
    for (const line of game.players) {
      if (!line.userId) continue;
      const won = line.isRadiant === game.radiantWin;
      const impact = Math.round(fantasyPoints(line, won) * 10) / 10;
      const candidate: WeekBestGame = {
        userId: line.userId,
        heroId: line.heroId ?? null,
        kills: line.kills,
        deaths: line.deaths,
        assists: line.assists,
        impact,
        won,
      };
      if (
        !best ||
        candidate.impact > best.impact ||
        (candidate.impact === best.impact &&
          (candidate.kills > best.kills ||
            (candidate.kills === best.kills &&
              (candidate.deaths < best.deaths ||
                (candidate.deaths === best.deaths &&
                  candidate.userId < best.userId)))))
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

/** How far through its slate a regular week is. */
export function weekProgress(
  matches: readonly { week: number; phase: string; status: string }[],
  week: number,
): { total: number; final: number; done: boolean } {
  const slate = matches.filter(
    (match) => match.phase === MATCH_PHASE.REGULAR && match.week === week,
  );
  const final = slate.filter((match) => match.status === MATCH_STATUS.COMPLETED).length;
  return { total: slate.length, final, done: slate.length > 0 && final === slate.length };
}

/** The wrap's path: a season's own URL, so an old link outlives the season. */
export function weekWrapPath(seasonId: string, week: number): string {
  return `/seasons/${encodeURIComponent(seasonId)}/weeks/${week}`;
}
