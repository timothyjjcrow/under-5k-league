import type { AwardGame } from "./awards";
import { SEASON_STATUS } from "./constants";
import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";

export type RecapGameInput = {
  matchId: string;
  radiantWin: boolean;
  radiantScore: number;
  direScore: number;
  durationSecs: number;
  players: string;
};

export type RecapGameSummary = {
  awardGames: AwardGame[];
  totalKills: number;
  trustedStatGames: number;
  totalDuration: number;
  timedGames: number;
  playerIds: Set<string>;
  heroIds: Set<number>;
};

/**
 * Build recap rollups through the same complete-5v5 trust boundary as Leaders
 * and Hero meta. Header-vs-line kill fallback is chosen per game because old
 * and new imports routinely coexist within one season.
 */
export function summarizeRecapGames(
  games: RecapGameInput[],
): RecapGameSummary {
  const awardGames: AwardGame[] = [];
  const playerIds = new Set<string>();
  const heroIds = new Set<number>();
  let totalKills = 0;
  let trustedStatGames = 0;
  let totalDuration = 0;
  let timedGames = 0;

  for (const game of games) {
    if (game.durationSecs > 0) {
      totalDuration += game.durationSecs;
      timedGames++;
    }
    const trusted = trustedGamePlayers(decodeGamePlayers(game.players));
    if (trusted.length === 0) continue;

    const lines = trusted.map((player) => {
      if (player.userId) playerIds.add(player.userId);
      heroIds.add(player.heroId);
      return {
        userId: player.userId,
        heroId: player.heroId,
        isRadiant: player.isRadiant,
        kills: player.kills,
        deaths: player.deaths,
        assists: player.assists,
        netWorth: player.netWorth,
        gpm: player.gpm,
        // The rest of the line the MVP's points read (Player of the Week
        // scoring) — dropping them would under-score supports and offlaners.
        lastHits: player.lastHits,
        denies: player.denies,
        heroDamage: player.heroDamage,
        towerDamage: player.towerDamage,
        heroHealing: player.heroHealing,
      };
    });
    trustedStatGames++;
    const headerKills = game.radiantScore + game.direScore;
    const lineKills = lines.reduce((sum, line) => sum + line.kills, 0);
    totalKills += headerKills > 0 ? headerKills : lineKills;
    awardGames.push({
      matchId: game.matchId,
      radiantWin: game.radiantWin,
      radiantScore: game.radiantScore,
      direScore: game.direScore,
      lines,
    });
  }

  return {
    awardGames,
    totalKills,
    trustedStatGames,
    totalDuration,
    timedGames,
    playerIds,
    heroIds,
  };
}

/**
 * Where /recap sends a visitor. A finished season's recap (champion, bracket,
 * stat strip and awards) lives on that season's own page now, and /recap only
 * redirects, so old links and the champion posts already in Discord keep
 * working:
 * - a link to a season lands on that season's page, unless the season is
 *   still running: then Leaders, which already carries every award so far;
 * - the bare /recap lands on the current season's page once it is complete,
 *   on Leaders while it is being played, and before its first game (signups,
 *   draft) or between seasons on the last archived season's page;
 * - with nothing to recap at all, Leaders, which says so.
 */
export function recapDestination({
  requested,
  active,
  lastArchived,
}: {
  /** The season a ?season= link names; null for the bare /recap. */
  requested: { id: string; isActive: boolean; status: string } | null;
  active: { id: string; status: string } | null;
  /** The most recent season that is no longer active. */
  lastArchived: { id: string } | null;
}): string {
  const seasonPage = (id: string) => `/seasons/${encodeURIComponent(id)}`;
  if (requested) {
    return requested.isActive && requested.status !== SEASON_STATUS.COMPLETE
      ? "/leaders"
      : seasonPage(requested.id);
  }
  if (active?.status === SEASON_STATUS.COMPLETE) return seasonPage(active.id);
  if (
    active?.status === SEASON_STATUS.REGULAR_SEASON ||
    active?.status === SEASON_STATUS.PLAYOFFS
  ) {
    return "/leaders";
  }
  return lastArchived ? seasonPage(lastArchived.id) : "/leaders";
}
