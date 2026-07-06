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
