// Fantasy league math — pure and unit-tested. Managers pick a "fantasy five"
// from the drafted rosters under an MMR salary cap; points come from the
// per-player stats of imported games.

import { FANTASY } from "./constants";

/** The slice of a stored game stat line that fantasy scoring reads. */
export type FantasyStatLine = {
  kills: number;
  deaths: number;
  assists: number;
  gpm?: number | null;
  lastHits?: number | null;
};

/** Points one game line is worth. */
export function fantasyPoints(stat: FantasyStatLine, won: boolean): number {
  const raw =
    stat.kills * FANTASY.KILL +
    stat.assists * FANTASY.ASSIST +
    stat.deaths * FANTASY.DEATH +
    (stat.gpm ?? 0) * FANTASY.GPM +
    (stat.lastHits ?? 0) * FANTASY.LAST_HIT +
    (won ? FANTASY.WIN : 0);
  return Math.round(raw * 10) / 10;
}

/**
 * The MMR salary cap: league-average rostered MMR × slots, with a little
 * slack — so a cap-legal five can be above average, but not the top five.
 * Unknown (0) MMRs are excluded from the average. Rounded to 50.
 */
export function fantasyCap(
  rosterMmrs: number[],
  slots: number = FANTASY.SLOTS,
): number {
  const known = rosterMmrs.filter((m) => m > 0);
  if (known.length === 0) return 0;
  const avg = known.reduce((s, m) => s + m, 0) / known.length;
  return Math.round((avg * slots * FANTASY.CAP_SLACK) / 50) * 50;
}

/**
 * Validate a manager's picks. Returns an error message or null when legal.
 * `eligibleMmr` maps every rostered league player to their signup MMR.
 */
export function validateFantasyPicks(
  pickUserIds: string[],
  eligibleMmr: Map<string, number>,
  cap: number,
  slots: number = FANTASY.SLOTS,
): string | null {
  if (pickUserIds.length !== slots) {
    return `Pick exactly ${slots} players (you have ${pickUserIds.length}).`;
  }
  if (new Set(pickUserIds).size !== slots) {
    return "No duplicate players.";
  }
  for (const id of pickUserIds) {
    if (!eligibleMmr.has(id)) {
      return "Every pick must be a rostered league player.";
    }
  }
  const total = pickUserIds.reduce(
    (s, id) => s + (eligibleMmr.get(id) ?? 0),
    0,
  );
  if (cap > 0 && total > cap) {
    return `Over the cap: ${total} MMR of ${cap} allowed.`;
  }
  return null;
}

/** One parsed imported game: who played, and which side won. */
export type FantasyGame = {
  radiantWin: boolean;
  players: (FantasyStatLine & { userId?: string | null; isRadiant: boolean })[];
};

/** Total fantasy points per league player across the season's games. */
export function pointsByPlayer(games: FantasyGame[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const g of games) {
    for (const p of g.players) {
      if (!p.userId) continue;
      const won = p.isRadiant === g.radiantWin;
      totals.set(
        p.userId,
        Math.round(((totals.get(p.userId) ?? 0) + fantasyPoints(p, won)) * 10) /
          10,
      );
    }
  }
  return totals;
}

export type FantasyStanding = {
  managerId: string;
  points: number;
  /** Per-pick contribution, descending. */
  breakdown: { userId: string; points: number }[];
};

/** Rank fantasy rosters by their picks' combined points. */
export function fantasyStandings(
  rosters: { managerId: string; pickUserIds: string[] }[],
  playerPoints: Map<string, number>,
): FantasyStanding[] {
  return rosters
    .map((r) => {
      const breakdown = r.pickUserIds
        .map((id) => ({ userId: id, points: playerPoints.get(id) ?? 0 }))
        .sort((a, b) => b.points - a.points);
      const points =
        Math.round(breakdown.reduce((s, b) => s + b.points, 0) * 10) / 10;
      return { managerId: r.managerId, points, breakdown };
    })
    .sort(
      (a, b) => b.points - a.points || a.managerId.localeCompare(b.managerId),
    );
}
