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

/**
 * Can this team still take part — does it need a player AND have the money for
 * one at the minimum bid? Equivalent to `budget >= need * minBid`, the invariant
 * `maxBid` maintains on every purchase, so in a healthy auction every needy team
 * is affordable. It can be false after a roster move that removes a player
 * without returning their fee, and the rotation must not hand the clock to a
 * team that cannot legally bid: `resolveStalledNomination` would open a lot at
 * MIN_BID on its behalf (it is the one nomination path with no affordability
 * check) and the sale would then drive the budget negative.
 */
export function canNominate(
  team: DraftTeam,
  teamSize: number,
  minBid = DEFAULTS.MIN_BID,
): boolean {
  return (
    teamNeed(teamSize, team.rosterCount) > 0 &&
    maxBid(team, teamSize, minBid) >= minBid
  );
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

/**
 * Uniform Fisher-Yates shuffle.
 *
 * `[...xs].sort(() => Math.random() - 0.5)` is NOT uniform — the comparator is
 * inconsistent, so the result depends on the sort implementation and heavily
 * favours orderings close to the input. Draft order decides who nominates
 * first all night, so "randomize" needs to actually be random. `rand` is
 * injectable for the test.
 */
export function shuffle<T>(items: T[], rand: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The captain MMR gap (lowest to highest) at which the budget weighting
 * reaches full strength. Below it the effect scales down proportionally, so
 * near-equal captains get near-equal budgets instead of the full spread.
 */
export const BUDGET_FULL_EFFECT_GAP = 1000;

/**
 * MMR-weighted starting budgets: a high-MMR captain is already a strong pick
 * on their own roster, so they get less to spend than a low-MMR captain.
 *
 * Linear interpolation across the actual captain pool, with the weight scaled
 * by how lopsided that pool really is: at a gap of `BUDGET_FULL_EFFECT_GAP`+
 * MMR between the lowest and highest captain, the lowest gets
 * `base × (1 + weightPct/100)` and the highest `base × (1 − weightPct/100)`;
 * smaller gaps shrink the spread proportionally (175 apart at 20% ⇒ ±3.5%).
 * Identical MMRs (or weightPct 0) produce exactly `base`. Captains with
 * unknown MMR get `base`.
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
  const gap = known.length > 0 ? max - min : 0;
  const gapScale = Math.min(1, Math.max(0, gap) / BUDGET_FULL_EFFECT_GAP);
  const w =
    (Number.isFinite(weightPct) ? Math.max(0, weightPct) / 100 : 0) * gapScale;

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
    // Needy AND able to pay. Skipping the broke is what stops the "advance past
    // a team that can't afford the minimum" path from cycling forever; -1 here
    // means nobody can bid, which the callers already treat as draft-complete.
    if (canNominate(teamsInOrder[idx], teamSize)) return idx;
  }
  return -1;
}

/**
 * Did the viewer's team just lose the high bid between two polls? The
 * same-player guard matters: when a winning bid resolves into a sale AND the
 * next nomination lands within one poll, the bid team changes but it's a new
 * auction — flashing "Outbid!" then would be a lie.
 */
export function wasOutbid(args: {
  myTeamId: string | null;
  prevBidTeamId: string | null;
  curBidTeamId: string | null;
  prevNominatedId: string | null;
  curNominatedId: string | null;
}): boolean {
  return (
    !!args.myTeamId &&
    args.prevBidTeamId === args.myTeamId &&
    args.curBidTeamId !== args.myTeamId &&
    !!args.curNominatedId &&
    args.curNominatedId === args.prevNominatedId
  );
}

/** What to do with the 💸 Outbid! latch this poll. */
export type OutbidDecision = "set" | "clear" | "keep";

/**
 * The other half of the outbid banner: `wasOutbid` says when to RAISE it, this
 * says when to drop it — and, just as importantly, when to leave it alone.
 *
 * It takes no budget or `canBid` input ON PURPOSE, and the signature is the
 * guard: a captain who has been priced out of the lot is exactly the person
 * who most needs to see that they lost the player. (Their re-bid button
 * disables itself.) The latch drops only when the fact it asserts stops being
 * true: the viewer's team retook the high bid, the lot moved on, or bidding
 * closed.
 *
 * The two rules were separate `if`s in the room and their mutual exclusivity
 * was assumed, never stated — which matters now that one function returns a
 * single decision.
 */
export function outbidLatchAfter(args: {
  myTeamId: string | null;
  prevBidTeamId: string | null;
  curBidTeamId: string | null;
  prevNominatedId: string | null;
  curNominatedId: string | null;
}): OutbidDecision {
  if (wasOutbid(args)) return "set";
  if (
    (args.myTeamId && args.curBidTeamId === args.myTeamId) ||
    args.curNominatedId !== args.prevNominatedId ||
    !args.curNominatedId
  ) {
    return "clear";
  }
  return "keep";
}

/**
 * The draft room's tab-title flag, in priority order, or null.
 *
 * "Outbid" is latched on the actual outbid EVENT (see above), never on merely
 * "not holding the high bid" — that would mislabel every nomination the
 * captain never bid on. "Your pick" outranks it: an expiring nomination clock
 * auto-skips your turn, which costs more than a lost lot.
 */
export const DRAFT_TITLE_PREFIXES = [
  "⏰ Your pick — ",
  "💸 Outbid — ",
] as const;

export function draftTitleFlag(o: {
  /** False before the first payload — nothing to say yet. */
  loaded: boolean;
  status: string | null;
  canNominate: boolean;
  /** The outbid latch is currently raised. */
  outbid: boolean;
}): string | null {
  if (!o.loaded) return null;
  // `canNominate` already implies IN_PROGRESS server-side; the status guard is
  // belt-and-braces against a stale payload, and invisible until it isn't.
  if (o.status !== "COMPLETE" && o.canNominate) return DRAFT_TITLE_PREFIXES[0];
  if (o.outbid) return DRAFT_TITLE_PREFIXES[1];
  return null;
}

/**
 * Remove a flag this module added, so the room can prepend the current one
 * against a title it may have already written to.
 *
 * Exported beside the prefixes deliberately: the room used to carry its own
 * hand-copied array of the same two literals five lines below where they were
 * defined, and a one-character drift (an en dash for an em dash, a lost
 * trailing space) would have stacked prefixes in the tab forever with nothing
 * to notice it.
 */
export function stripDraftTitleFlag(title: string): string {
  for (const p of DRAFT_TITLE_PREFIXES) {
    if (title.startsWith(p)) return title.slice(p.length);
  }
  return title;
}

/**
 * Does this viewer need the draft room to keep polling in a hidden tab?
 *
 * A captain, an admin, or anyone still in the pool: all three can have the
 * auction turn to them while they are looking at something else. Note it goes
 * FALSE the moment the viewer is sold — which is correct, and means their
 * "you were drafted" chime has to arrive on the very poll that removes them.
 */
export function draftViewerStake(s: {
  me: { userId: string | null; myTeamId: string | null; isAdmin: boolean };
  available: { userId: string }[];
}): boolean {
  if (s.me.myTeamId || s.me.isAdmin) return true;
  const id = s.me.userId;
  return !!id && s.available.some((p) => p.userId === id);
}
