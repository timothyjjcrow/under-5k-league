/**
 * Match-night hosting copy, built from the league's own settings so it can't
 * drift from the rules it describes.
 *
 * Captains used to get hosting instructions only when the season had a Valve
 * league ticket (the "Official lobby checklist"). A season without one — Europe
 * before its ticket is issued — showed nothing about who hosts, which server,
 * which mode or how many lobbies. The "How to host" line is now shown to both
 * captains whether or not a ticket exists; the ticket only adds the league id.
 */

/**
 * The admin warning for a season with no league ticket. Valve asks for ticket
 * applications at least 15 days before an event, so this has to reach the
 * admin during signups and the draft, not when week 1 is already under way.
 * Worded as "may not": without a ticket a private lobby is not guaranteed to
 * reach OpenDota, and the site must not promise that roster scans will cover
 * for it.
 */
export const MISSING_LEAGUE_TICKET_WARNING =
  "This season has no Dota league ticket. Valve needs about 15 days to issue one; without it, league games may not reach OpenDota and results can't be imported.";

/**
 * What a captain on a ticketless season does when the result doesn't import:
 * paste the match ID, and if OpenDota never got the game, send an admin the
 * score (manual score entry is admin-only). Never "make your match history
 * public" — that is not enough for a private lobby without a ticket.
 */
export const NO_TICKET_RESULT_NOTE =
  "This season has no league ticket yet, so your result may not appear on its own. If it doesn't, paste the Dota match ID in Report your result below. If that can't find the game either, send an admin the score.";

/**
 * How many lobbies a series takes, phrased for its length. Odd series stop at
 * the clinching win; even ones (Bo2) play every game — the same split as
 * `seriesScoreError`.
 */
export function seriesLobbyRule(bestOf: number): string {
  const n = Math.max(1, Math.floor(bestOf));
  if (n === 1) return "Bo1 = one lobby";
  if (n === 2) return "Bo2 = two separate lobbies";
  if (n % 2 === 0) return `Bo${n} = ${n} separate lobbies`;
  return `Bo${n} = one lobby per game, first to ${Math.ceil(n / 2)} wins`;
}

/** The pieces of the one-line "How to host" summary, in reading order. */
export function howToHostParts({
  homeTeamName,
  bestOf,
  region,
  mode,
}: {
  homeTeamName: string;
  bestOf: number;
  /** LEAGUE_CONFIG.gameServerRegion — never a hard-coded region. */
  region: string;
  /** LEAGUE_GAME_MODE.name — the mode the lobby bot sets. */
  mode: string;
}): string[] {
  return [
    `${homeTeamName}'s captain hosts`,
    region,
    mode,
    seriesLobbyRule(bestOf),
  ];
}
