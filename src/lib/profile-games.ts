// A player's league games, folded once for their profile and once for its
// link picture by the same rules: their own trusted line in each game, then
// the career folds the profile's sections and their season card share (the
// achievements and their Match MVP count, the report card, the league hero
// pool). Pure and tested.

import { achievementsFor, gameMvp } from "./achievements";
import { careerReportCard } from "./benchmarks";
import type { PlayerStat } from "./match-import";
import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";
import { playerHeroPool } from "./scouting";

/** One game they played: their line in it and the whole box score. */
export type ProfileGameRow<G> = {
  game: G;
  /** Their own line. */
  stat: PlayerStat;
  /** Every trusted line in the game. */
  parsed: PlayerStat[];
  won: boolean;
  /** They were the game's Match MVP. */
  mvp: boolean;
};

/**
 * Their line out of each game, in the order given (the profile passes newest
 * first). A game whose box score isn't trusted, or that they aren't in, is
 * left out.
 */
export function profileGameRows<G extends { players: string; radiantWin: boolean }>(
  userId: string,
  games: readonly G[],
): ProfileGameRow<G>[] {
  return games.flatMap((game) => {
    const parsed = trustedGamePlayers(decodeGamePlayers(game.players));
    const stat = parsed.find((p) => p.userId === userId);
    if (!stat) return [];
    return [
      {
        game,
        stat,
        parsed,
        won: stat.isRadiant === game.radiantWin,
        mvp: gameMvp(parsed, game.radiantWin) === userId,
      },
    ];
  });
}

/**
 * The career folds over those rows: their achievements (the trophy case, and
 * the card's Match MVP count), the career report card (worldwide percentile
 * benchmarks over every graded line) and their league hero pool, most-played
 * first.
 */
export function profileGameFolds(
  userId: string,
  rows: readonly ProfileGameRow<{
    radiantWin: boolean;
    durationSecs: number;
    startTime: number;
  }>[],
) {
  return {
    badges: achievementsFor(
      rows.map(({ stat, won, mvp }) => ({
        kills: stat.kills,
        deaths: stat.deaths,
        assists: stat.assists,
        gpm: stat.gpm,
        lastHits: stat.lastHits,
        won,
        mvp,
      })),
    ),
    reportCard: careerReportCard(rows.map((row) => row.stat)),
    // ScoutGame is the exact shape the match-preview dossier consumes.
    // playerHeroPool tiebreaks games → winRate → heroId.
    leagueHeroes: playerHeroPool(
      userId,
      rows.map((row) => ({
        radiantWin: row.game.radiantWin,
        durationSecs: row.game.durationSecs,
        startTime: row.game.startTime,
        lines: row.parsed.map((p) => ({
          userId: p.userId ?? null,
          heroId: p.heroId,
          isRadiant: p.isRadiant,
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
        })),
      })),
    ),
  };
}
