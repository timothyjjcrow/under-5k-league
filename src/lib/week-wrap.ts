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
 * The regular-season table of `teamIds` after `week` (every completed regular
 * result up to and including it, as regularTableBeforeWeek(week + 1) counts
 * them), with each team's movement against the table going into the week.
 * Only fixtures between these teams count, so a group's table is the group's
 * own; for the league's one table that is every fixture.
 */
export function weekWrapTable(
  teamIds: string[],
  matches: readonly WeekMatch[],
  week: number,
): WeekWrapRow[] {
  const ids = new Set(teamIds);
  const own = matches.filter((m) => ids.has(m.homeTeamId) && ids.has(m.awayTeamId));
  const after = regularTableBeforeWeek(teamIds, own, week + 1);
  // The arrows need this table's own evidence: a group whose first results
  // are still to come has only the all-zero order to move against.
  const moved = regularWeeksWithResultsBefore(own, week) > 0;
  const beforeRank = new Map(
    regularTableBeforeWeek(teamIds, own, week).map((row, i) => [row.teamId, i]),
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

/** One table of the week wrap: the league's, or one group's. */
export type WeekWrapTable = {
  /** "A", "B"; null for a one-table season. */
  key: string | null;
  /** "Group A"; null for the league's one table. */
  title: string | null;
  rows: WeekWrapRow[];
};

/**
 * The tables after `week`, one per standings section (`standingsSections`
 * over the season's playoff field, which decides whether the season plays
 * groups): the league's one table, or each group's own, with places and
 * arrows inside the group. A group's table ignores results against the other
 * group, as its live table does.
 */
export function weekWrapTables(
  sections: readonly {
    key: string | null;
    title: string | null;
    /** Every team in the table, in any order: only the ids are read. */
    standings: readonly { teamId: string }[];
  }[],
  matches: readonly WeekMatch[],
  week: number,
): WeekWrapTable[] {
  return sections.map((section) => ({
    key: section.key,
    title: section.title,
    rows: weekWrapTable(
      section.standings.map((row) => row.teamId),
      matches,
      week,
    ),
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
