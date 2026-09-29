/**
 * Match-night hosting copy, built from the league's own settings so it can't
 * drift from the rules it describes.
 *
 * Captains used to get hosting instructions only when the season had a Valve
 * league ticket (the "Official lobby checklist"). A season without one — Europe
 * before its ticket is issued — showed nothing about who hosts, which server,
 * which mode or how many lobbies. The "How to host" line is now shown to both
 * captains whether or not a ticket exists: on its own without a ticket, and as
 * the first line of that checklist (which adds the league id) with one.
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
 * The ticketless season's note under "How to host": why the result may not
 * import by itself, pointing at the Report your result card, whose subtitle
 * (NO_TICKET_REPORT_SUBTITLE) says what to do. Each step is said once. Never
 * "make your match history public" — that is not enough for a private lobby
 * without a ticket.
 */
export const NO_TICKET_RESULT_NOTE =
  "This season has no league ticket yet, so your result may not appear on its own. If it doesn't, add it in Report your result below.";

/**
 * The Report your result card on a ticketless season: paste the match ID or
 * try Auto-fetch, and if OpenDota never got the game, send an admin the score
 * (manual score entry is admin-only). It must never say "no admin needed" —
 * without a ticket, an admin may be the only way the result gets in.
 */
export const NO_TICKET_REPORT_SUBTITLE =
  "Played it? Paste the Dota match ID below, or try Auto-fetch games. A pasted ID must fall near this fixture's scheduled match time, so an old scrim or rematch can't claim the result. If neither finds the game, send an admin the score.";

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
