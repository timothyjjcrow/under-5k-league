// Which Dota games can count for a league fixture. Pure, so /rules quotes the
// same numbers the importer (`match-import.ts`) enforces.

/** How far either side of its kickoff a game may sit and still belong to a
 *  match. Generous backwards because amateur teams often play early without
 *  filing a reschedule; mis-attribution is prevented by `claimsGame`
 *  (match-import.ts), not by keeping this window tight. */
export const DETECT_WINDOW_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;
export const DETECT_WINDOW_AFTER_MS = 6 * 24 * 60 * 60 * 1000;

/** Known players (a roster seat or a standin booked for the match, with a
 *  linked Dota account) each team needs in a game, on opposite sides, for it
 *  to count. A couple of unknown accounts (smurfs, unbooked friends) are
 *  tolerated; a team smaller than this needs every seat. */
const MIN_KNOWN_PLAYERS_PER_SIDE = 3;

/** `classifyGame`'s per-side threshold for a season's team size. */
export function knownPlayersPerSide(teamSize: number): number {
  return Math.min(MIN_KNOWN_PLAYERS_PER_SIDE, teamSize);
}
