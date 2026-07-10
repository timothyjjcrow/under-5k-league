import { DEFAULTS } from "./constants";

// Pure auction-draft rules. DB effects live in the server actions; these
// functions just encode the math so they can be unit-tested in isolation.

export type DraftTeam = {
  id: string;
  budget: number;
  rosterCount: number; // includes the captain
};

/** How many more players a team still needs (captain already counts as 1). */
export function teamNeed(teamSize: number, rosterCount: number): number {
  return Math.max(0, teamSize - rosterCount);
}

/**
 * The most a team may bid on the CURRENT player while still reserving at least
 * `minBid` for every other empty roster slot. This guarantees a captain can
 * always fill their team.
 */
export function maxBid(
  team: DraftTeam,
  teamSize: number,
  minBid = DEFAULTS.MIN_BID,
): number {
  const need = teamNeed(teamSize, team.rosterCount);
  if (need <= 0) return 0;
  return Math.max(0, team.budget - (need - 1) * minBid);
}

/** Whether `amount` is a legal bid for this team given the current high bid. */
export function canBid(
  team: DraftTeam,
  teamSize: number,
  amount: number,
  currentBid: number,
  minBid = DEFAULTS.MIN_BID,
): boolean {
  if (teamNeed(teamSize, team.rosterCount) <= 0) return false;
  if (!Number.isInteger(amount)) return false;
  if (amount < minBid) return false;
  if (amount <= currentBid) return false;
  return amount <= maxBid(team, teamSize, minBid);
}

/** Draft is done when no team still needs players, or no players remain. */
export function isDraftComplete(
  teams: DraftTeam[],
  teamSize: number,
  availablePlayers: number,
): boolean {
  const anyNeeds = teams.some((t) => teamNeed(teamSize, t.rosterCount) > 0);
  return !anyNeeds || availablePlayers <= 0;
}

/**
 * MMR-weighted starting budgets: a high-MMR captain is already a strong pick
 * on their own roster, so they get less to spend than a low-MMR captain.
 *
 * Linear interpolation across the actual captain pool: the lowest-MMR captain
 * gets `base × (1 + weightPct/100)`, the highest gets `base × (1 − weightPct/100)`,
 * everyone else proportionally by MMR distance. Self-calibrating — clustered
 * captain MMRs produce nearly flat budgets, identical MMRs (or weightPct 0)
 * produce exactly `base`. Captains with unknown MMR get `base`.
 */
export function mmrWeightedBudgets(
  base: number,
  weightPct: number,
  captains: { teamId: string; mmr: number | null }[],
  floor = 1,
): Map<string, number> {
  const out = new Map<string, number>();
  const known = captains.filter((c) => c.mmr != null) as {
    teamId: string;
    mmr: number;
  }[];
  const min = Math.min(...known.map((c) => c.mmr));
  const max = Math.max(...known.map((c) => c.mmr));
  const w = Number.isFinite(weightPct) ? Math.max(0, weightPct) / 100 : 0;

  for (const c of captains) {
    if (c.mmr == null || max === min || w === 0) {
      out.set(c.teamId, Math.max(floor, base));
      continue;
    }
    // 0 at the lowest MMR → 1 at the highest.
    const t = (c.mmr - min) / (max - min);
    const budget = Math.round(base * (1 + w - 2 * w * t));
    out.set(c.teamId, Math.max(floor, budget));
  }
  return out;
}

/**
 * Snake-free simple rotation: from the team that last nominated, find the next
 * team in draft order that still needs players. Returns its index, or -1 if
 * every team is full.
 */
export function nextNominatorIndex(
  teamsInOrder: DraftTeam[],
  teamSize: number,
  lastIndex: number,
): number {
  const n = teamsInOrder.length;
  for (let step = 1; step <= n; step++) {
    const idx = (lastIndex + step) % n;
    if (teamNeed(teamSize, teamsInOrder[idx].rosterCount) > 0) return idx;
  }
  return -1;
}
