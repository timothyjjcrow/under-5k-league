// The re-grade once OpenDota parses a game's replay. A result usually lands
// before the parse does: OpenDota has the match summary within minutes of the
// game ending, but damage taken, stuns, wards, stacks and laning come only
// from the replay, which waits in its parse queue. Such a game is graded
// "partial" and left a marker (a Setting row); the worker checks OpenDota on
// the schedule below and grades the game again once the replay is in.
// Pure and tested; inhouse-regrade-service.ts runs it.

import type { OpenDotaMatch } from "./dota";
import {
  inhouseBoxStats,
  isGradedBox,
  type InhouseBoxPlayer,
} from "./inhouse-box";

export const INHOUSE_REGRADE_PREFIX = "inhouse-regrade:";

export const inhouseRegradeKey = (lobbyId: string) =>
  `${INHOUSE_REGRADE_PREFIX}${lobbyId}`;

/**
 * When OpenDota is asked again, in minutes after the result landed. Most
 * replays are parsed within the hour; after a day the game keeps its partial
 * grade. Seven calls at most per game.
 */
export const INHOUSE_REGRADE_CHECK_MINUTES = [10, 30, 60, 120, 240, 480, 1440] as const;

export type InhouseRegradeMarker = {
  lobbyId: string;
  /** The match the grade was built from; a void or a new result drops it. */
  dotaMatchId: string;
  /** When the result landed, the schedule's zero. */
  resultAtMs: number;
  /** Checks already made. */
  tries: number;
};

const VALUE = /^(\d+):(\d+):(\d+)$/;

export function inhouseRegradeValue(m: InhouseRegradeMarker): string {
  return `${m.dotaMatchId}:${m.resultAtMs}:${m.tries}`;
}

/** The marker in a Setting row, or null when the row is not a valid one. */
export function parseInhouseRegrade(
  key: string,
  value: string,
): InhouseRegradeMarker | null {
  if (!key.startsWith(INHOUSE_REGRADE_PREFIX)) return null;
  const lobbyId = key.slice(INHOUSE_REGRADE_PREFIX.length);
  const m = VALUE.exec(value);
  if (!lobbyId || !m) return null;
  const resultAtMs = Number(m[2]);
  const tries = Number(m[3]);
  if (!Number.isSafeInteger(resultAtMs) || !Number.isSafeInteger(tries)) {
    return null;
  }
  return { lobbyId, dotaMatchId: m[1], resultAtMs, tries };
}

/** The next check, or null once every check has been made. */
export function inhouseRegradeDueAtMs(m: InhouseRegradeMarker): number | null {
  const minutes = INHOUSE_REGRADE_CHECK_MINUTES[m.tries];
  return minutes === undefined ? null : m.resultAtMs + minutes * 60_000;
}

/**
 * When the worker must wake for these rows: the earliest check due, or now
 * for a row that is malformed or spent (the next pass deletes it). Null when
 * there are none.
 */
export function inhouseRegradeWakeAtMs(
  rows: readonly { key: string; value: string }[],
  nowMs: number,
): number | null {
  let wake: number | null = null;
  for (const row of rows) {
    const marker = parseInhouseRegrade(row.key, row.value);
    const at = (marker && inhouseRegradeDueAtMs(marker)) ?? nowMs;
    wake = wake === null ? at : Math.min(wake, at);
  }
  return wake;
}

/** A graded game whose grade was made before the replay was parsed. */
export function needsInhouseRegrade(box: readonly InhouseBoxPlayer[]): boolean {
  return isGradedBox(box) && box.some((line) => line.grade?.partial === true);
}

/**
 * The stored lines with every stat beyond K/D/A taken again from a parsed
 * payload, and their grades dropped for regrading. Null when the replay is
 * still unparsed (no player has damage taken, the same test that makes a
 * grade partial) or a line cannot be matched to exactly one player in it.
 * Lines match on side and hero: each hero is played once a game.
 */
export function withParsedStats(
  box: readonly InhouseBoxPlayer[],
  od: OpenDotaMatch,
): InhouseBoxPlayer[] | null {
  const parsed = od.players.some(
    (p) => p.damage_taken != null && typeof p.damage_taken === "object",
  );
  if (!parsed || box.length !== od.players.length) return null;
  const out: InhouseBoxPlayer[] = [];
  for (const line of box) {
    const same = od.players.filter(
      (p) =>
        p.hero_id === line.heroId &&
        (p.isRadiant ?? p.player_slot < 128) === line.isRadiant,
    );
    if (same.length !== 1) return null;
    const keep: InhouseBoxPlayer = {
      userId: line.userId,
      name: line.name,
      team: line.team,
      isRadiant: line.isRadiant,
      heroId: line.heroId,
      kills: line.kills,
      deaths: line.deaths,
      assists: line.assists,
      netWorth: line.netWorth,
      gpm: line.gpm,
      lastHits: line.lastHits,
    };
    out.push({ ...keep, ...inhouseBoxStats(same[0]) });
  }
  return out;
}
