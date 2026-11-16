// The game a visitor came to stand in for, remembered across the standin
// signup (sign in with Steam, link Discord, fill the form on /me), so the
// signup's own submit can put them on that game's list. A plain cookie the
// browser sets when they press "Register as a standin" on a game: it carries
// two public ids and grants nothing, since the offer it leads to is checked
// like any other (offerToStandIn).

/** The cookie that remembers which game this browser wants to stand in for. */
export const STANDIN_GAME_COOKIE = "ggd2l_standin_game";
/** Long enough for a first sign-in and the Discord step; not a standing wish. */
export const STANDIN_GAME_MAX_AGE_SECONDS = 2 * 60 * 60;

/** Match and team ids as the cookie carries them: cuid shaped, nothing to encode. */
const ID = "[A-Za-z0-9_-]{8,64}";
const GAME_SHAPE = new RegExp(`^(${ID})\\.(${ID})$`);

export type StandinGame = { matchId: string; teamId: string };

/** The cookie's value for a game; null when an id isn't cookie-safe. */
export function standinGameValue(game: StandinGame): string | null {
  const value = `${game.matchId}.${game.teamId}`;
  return GAME_SHAPE.test(value) ? value : null;
}

/** The game a cookie value names; null for anything else. */
export function parseStandinGame(raw: unknown): StandinGame | null {
  if (typeof raw !== "string") return null;
  const hit = GAME_SHAPE.exec(raw);
  return hit ? { matchId: hit[1], teamId: hit[2] } : null;
}
