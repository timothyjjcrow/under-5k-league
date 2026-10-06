// "Your match night": a player's own recap of their latest series, for the
// few days after it, from the stored box scores alone (their line in each
// game, impact points, Match MVPs, and any badge the night earned them for
// the first time). Pure and tested; Home's card loads the games and renders.

import { achievementsFor, type Achievement } from "./achievements";
import { fantasyPoints } from "./fantasy";
import { profileGameRows } from "./profile-games";

/** How long after a series its recap stays on Home. */
export const MY_MATCH_NIGHT_HOURS = 72;

export type MyMatchNightGameInput = {
  id: string;
  matchId: string;
  players: string;
  radiantWin: boolean;
  /** Epoch seconds (OpenDota's start_time). */
  startTime: number;
  durationSecs: number;
  radiantTeamId: string | null;
  direTeamId: string | null;
};

export type MyMatchNightGame = {
  gameNumber: number;
  won: boolean;
  heroId: number;
  kills: number;
  deaths: number;
  assists: number;
  /** Impact points (fantasyPoints), one decimal. */
  impact: number;
  mvp: boolean;
};

export type MyMatchNight = {
  matchId: string;
  /** The team they played for in it (their line's team, else their side's). */
  teamId: string | null;
  /** When the series' last game ended, epoch ms. */
  finishedAtMs: number;
  games: MyMatchNightGame[];
  totalImpact: number;
  mvps: number;
  /** Badges their career had never had before this series. */
  newBadges: Achievement[];
};

const endMs = (game: MyMatchNightGameInput) =>
  (game.startTime + game.durationSecs) * 1000;

/**
 * Their latest decided series (`completedMatchIds`), while it ended within
 * MY_MATCH_NIGHT_HOURS of `nowMs`; null otherwise. `games` is their league
 * career, any order: games they aren't in, or whose box score isn't trusted,
 * are skipped (profileGameRows). "Latest" is by when a game ended, never a
 * row's update time.
 */
export function myMatchNight(input: {
  userId: string;
  games: readonly MyMatchNightGameInput[];
  completedMatchIds: ReadonlySet<string>;
  nowMs: number;
  windowHours?: number;
}): MyMatchNight | null {
  const rows = profileGameRows(input.userId, input.games);
  const decided = rows.filter((row) => input.completedMatchIds.has(row.game.matchId));
  if (decided.length === 0) return null;
  const latest = [...decided].sort(
    (a, b) =>
      endMs(b.game) - endMs(a.game) || a.game.id.localeCompare(b.game.id),
  )[0];
  const matchId = latest.game.matchId;
  const series = decided
    .filter((row) => row.game.matchId === matchId)
    .sort(
      (a, b) =>
        a.game.startTime - b.game.startTime || a.game.id.localeCompare(b.game.id),
    );
  const finishedAtMs = Math.max(...series.map((row) => endMs(row.game)));
  const windowMs = (input.windowHours ?? MY_MATCH_NIGHT_HOURS) * 60 * 60 * 1000;
  if (input.nowMs - finishedAtMs > windowMs || finishedAtMs > input.nowMs) {
    return null;
  }

  const games = series.map((row, index) => ({
    gameNumber: index + 1,
    won: row.won,
    heroId: row.stat.heroId,
    kills: row.stat.kills,
    deaths: row.stat.deaths,
    assists: row.stat.assists,
    impact: Math.round(fantasyPoints(row.stat, row.won) * 10) / 10,
    mvp: row.mvp,
  }));
  const first = series[0];
  const teamId =
    first.stat.teamId ??
    (first.stat.isRadiant ? first.game.radiantTeamId : first.game.direTeamId);

  // A badge is new when the career before this series didn't have it.
  // Counted badges (Match MVP ×N) already show as this night's MVPs.
  const line = (row: (typeof rows)[number]) => ({
    kills: row.stat.kills,
    deaths: row.stat.deaths,
    assists: row.stat.assists,
    gpm: row.stat.gpm,
    lastHits: row.stat.lastHits,
    won: row.won,
    mvp: row.mvp,
  });
  const seriesIds = new Set(series.map((row) => row.game.id));
  const before = new Set(
    achievementsFor(
      rows.filter((row) => !seriesIds.has(row.game.id)).map(line),
    ).map((badge) => badge.key),
  );
  const newBadges = achievementsFor(rows.map(line)).filter(
    (badge) => !before.has(badge.key),
  );

  return {
    matchId,
    teamId,
    finishedAtMs,
    games,
    totalImpact: Math.round(games.reduce((sum, g) => sum + g.impact, 0) * 10) / 10,
    mvps: games.filter((g) => g.mvp).length,
    newBadges,
  };
}
