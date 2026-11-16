import { cookies } from "next/headers";
import {
  parseStandinGame,
  STANDIN_GAME_COOKIE,
  type StandinGame,
} from "./standin-game";

/**
 * The game this browser came to stand in for, read without clearing it: /me
 * says what its signup will also do. Best-effort: no request scope (a
 * script, a test) reads as no game.
 */
export async function peekStandinGame(): Promise<StandinGame | null> {
  try {
    return parseStandinGame((await cookies()).get(STANDIN_GAME_COOKIE)?.value);
  } catch {
    return null;
  }
}

/**
 * The same, read once and forgotten: a standin signup consumes it whether or
 * not the offer is taken, so a later edit of the signup never offers again.
 * Like the invite tag (`takeInviteRef`), it must never fail a signup.
 */
export async function takeStandinGame(): Promise<StandinGame | null> {
  try {
    const store = await cookies();
    const raw = store.get(STANDIN_GAME_COOKIE)?.value ?? null;
    if (raw !== null) store.delete(STANDIN_GAME_COOKIE);
    return parseStandinGame(raw);
  } catch {
    return null;
  }
}
