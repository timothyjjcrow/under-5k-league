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
  heroDamage?: number | null;
  towerDamage?: number | null;
  heroHealing?: number | null;
  denies?: number | null;
};

export type FantasyImpact = "economy" | "playmaking" | "pressure";

export type FantasyScore = {
  points: number;
  base: number;
  bonus: number;
  impact: FantasyImpact | null;
};

/**
 * Every position has a path to the same eight-point contribution bonus.
 * Only the strongest path counts: a carry cannot stack farm and damage while
 * supports can reach the cap through assists or healing, and offlaners through
 * hero/tower damage or denies. We use box-score production from this game,
 * rather than self-reported preferred roles, so flex players score what they
 * actually did. Missing optional OpenDota fields contribute zero.
 */
export function fantasyScore(stat: FantasyStatLine, won: boolean): FantasyScore {
  const base =
    stat.kills * FANTASY.KILL +
    stat.assists * FANTASY.ASSIST +
    stat.deaths * FANTASY.DEATH +
    (won ? FANTASY.WIN : 0);
  const contributions: { impact: FantasyImpact; value: number }[] = [
    {
      impact: "economy",
      value:
        Math.max(0, (stat.gpm ?? 0) - FANTASY.ECONOMY_GPM_FLOOR) *
          FANTASY.ECONOMY_GPM +
        (stat.lastHits ?? 0) * FANTASY.ECONOMY_LAST_HIT,
    },
    {
      impact: "playmaking",
      value:
        stat.assists * FANTASY.PLAYMAKING_ASSIST +
        (stat.heroHealing ?? 0) * FANTASY.PLAYMAKING_HEALING,
    },
    {
      impact: "pressure",
      value:
        (stat.heroDamage ?? 0) * FANTASY.PRESSURE_HERO_DAMAGE +
        (stat.towerDamage ?? 0) * FANTASY.PRESSURE_TOWER_DAMAGE +
        (stat.denies ?? 0) * FANTASY.PRESSURE_DENY,
    },
  ];
  const strongest = contributions.reduce((best, current) =>
    current.value > best.value ? current : best,
  );
  const bonus = Math.min(FANTASY.BONUS_CAP, Math.max(0, strongest.value));
  return {
    points: Math.round((base + bonus) * 10) / 10,
    base: Math.round(base * 10) / 10,
    bonus: Math.round(bonus * 10) / 10,
    impact: bonus > 0 ? strongest.impact : null,
  };
}

/** Points one game line is worth; shared by fantasy, MVPs, and weekly honors. */
export function fantasyPoints(stat: FantasyStatLine, won: boolean): number {
  return fantasyScore(stat, won).points;
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
 * Fair salary values for a drafted pool. A missing legacy/signup MMR must not
 * make a player a zero-cost fantasy pick: impute the known-pool average,
 * rounded to the same 50-MMR granularity as the cap. If nobody has a known
 * rating, keep the whole pool at zero and the feature explicitly runs uncapped
 * rather than pretending those zeroes are real prices.
 */
export function fantasyPrices(
  rosterMmrs: Map<string, number>,
): Map<string, number> {
  const known = [...rosterMmrs.values()].filter((mmr) => mmr > 0);
  const estimate =
    known.length > 0
      ? Math.round(
          (known.reduce((sum, mmr) => sum + mmr, 0) / known.length) / 50,
        ) * 50
      : 0;
  return new Map(
    [...rosterMmrs].map(([userId, mmr]) => [
      userId,
      mmr > 0 ? mmr : estimate,
    ]),
  );
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
export type FantasyPlayerTotal = {
  points: number;
  games: number;
  wins: number;
  impacts: Record<FantasyImpact, number>;
};

export function fantasyTotalsByPlayer(
  games: FantasyGame[],
): Map<string, FantasyPlayerTotal> {
  const totals = new Map<string, FantasyPlayerTotal>();
  for (const g of games) {
    for (const p of g.players) {
      if (!p.userId) continue;
      const won = p.isRadiant === g.radiantWin;
      const score = fantasyScore(p, won);
      const previous = totals.get(p.userId) ?? {
        points: 0,
        games: 0,
        wins: 0,
        impacts: { economy: 0, playmaking: 0, pressure: 0 },
      };
      totals.set(p.userId, {
        points: Math.round((previous.points + score.points) * 10) / 10,
        games: previous.games + 1,
        wins: previous.wins + Number(won),
        impacts: {
          ...previous.impacts,
          ...(score.impact
            ? { [score.impact]: previous.impacts[score.impact] + 1 }
            : {}),
        },
      });
    }
  }
  return totals;
}

/** Total fantasy points per league player across the season's games. */
export function pointsByPlayer(games: FantasyGame[]): Map<string, number> {
  return new Map(
    [...fantasyTotalsByPlayer(games)].map(([id, total]) => [id, total.points]),
  );
}

/**
 * How contested each player is: fraction of fantasy rosters (0..1) that picked
 * them. Players nobody picked are absent from the map.
 */
export function ownershipByPlayer(
  rosters: { pickUserIds: string[] }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rosters) {
    for (const id of new Set(r.pickUserIds)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const total = rosters.length;
  return new Map(
    [...counts.entries()].map(([id, n]) => [id, total > 0 ? n / total : 0]),
  );
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
