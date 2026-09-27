// Pure helpers for the profile's match history and standout game.

import { fantasyPoints, type FantasyStatLine } from "./fantasy";

/**
 * The player's best game: the highest fantasy (impact) points, the same
 * rating that crowns Match MVP, so a support's big game can stand out as much
 * as a carry's. Net worth used to decide it, which meant the richest game
 * always won. Ties go to more kills, then fewer deaths, then the first row
 * given (callers pass games newest first, so the more recent one).
 */
export function pickStandout<T extends { stat: FantasyStatLine; won: boolean }>(
  rows: readonly T[],
): T | null {
  let best: { row: T; pts: number } | null = null;
  for (const row of rows) {
    const pts = fantasyPoints(row.stat, row.won);
    if (
      !best ||
      pts > best.pts ||
      (pts === best.pts &&
        (row.stat.kills > best.row.stat.kills ||
          (row.stat.kills === best.row.stat.kills &&
            row.stat.deaths < best.row.stat.deaths)))
    ) {
      best = { row, pts };
    }
  }
  return best?.row ?? null;
}
