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
  minBid: number = DEFAULTS.MIN_BID,
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
  return s.me.isAdmin || draftAlertsReachViewer(s);
}

/**
 * Can the draft room ever ring for this viewer? It decides whether the room
 * shows its sound toggle at all — a toggle for a bell that never rings is
 * clutter at the top of the busiest screen in the app.
 *
 * Mirrors what actually rings (draft-feed.ts's alerts plus the outbid latch):
 * a CAPTAIN gets "your turn to nominate" and "outbid"; a player still IN THE
 * POOL gets "you're on the block" and "you were drafted". Nobody else gets
 * anything — not a signed-out visitor, not a drafted player, and not an admin
 * as such (an admin who is also a captain or a pool player qualifies through
 * that). Being an admin is why draftViewerStake keeps polling a hidden tab;
 * it is not a reason to offer a bell.
 */
export function draftAlertsReachViewer(s: {
  me: { userId: string | null; myTeamId: string | null };
  available: { userId: string }[];
}): boolean {
  if (s.me.myTeamId) return true;
  const id = s.me.userId;
  return !!id && s.available.some((p) => p.userId === id);
}

/**
 * A team card's roster in reading order: the captain first, then everyone else
 * in the order they arrived (the payload sorts members by price, highest
 * first).
 *
 * Keyed on the captain FLAG, never on price. Captains are usually the $0 row,
 * which is why a price sort put them at the bottom of their own team — but a
 * captaincy transfer promotes a player who was bought, and that row keeps its
 * nonzero price. Stable: the non-captain order is left exactly as given.
 */
export function rosterDisplayOrder<M extends { isCaptain: boolean }>(
  members: readonly M[],
): M[] {
  return [
    ...members.filter((m) => m.isCaptain),
    ...members.filter((m) => !m.isCaptain),
  ];
}

/** "3 open seats" / "1 open seat" for a team card, or null when full. */
export function openSeatsLabel(need: number): string | null {
  if (need <= 0) return null;
  return `${need} open ${need === 1 ? "seat" : "seats"}`;
}

/**
 * The one line above a captain's bid buttons: how high they can go, and why
 * not higher. `need` counts the seats still to fill INCLUDING the one being
 * auctioned; the cap keeps `minBid` back for each of the others (see maxBid).
 *
 * It deliberately does not mention the current price. The old line did
 * ("winning at $4 leaves $100 for 3 more seats"), so its length changed with
 * every bid and it re-wrapped — moving the buttons under a captain's thumb.
 */
export function bidAllowanceLine(o: {
  maxBid: number;
  need: number;
  minBid?: number;
}): string {
  const minBid = o.minBid ?? DEFAULTS.MIN_BID;
  const others = o.need - 1;
  const head = `You can bid up to $${o.maxBid}`;
  if (others <= 0) return `${head}. This is your last open seat.`;
  if (others === 1) return `${head} (keeps $${minBid} for 1 more seat).`;
  return `${head} (keeps $${minBid} for each of ${others} more seats).`;
}

/**
 * The team the room shows as ON THE CLOCK, or null.
 *
 * Only while that team still has a nomination to make. Once its player is on
 * the block the countdown is the BIDDING clock, and a gold "on clock" badge on
 * the nominator read as though that team were winning, or had to act, while a
 * rival held the high bid. PAUSED is excluded too: nothing is ticking.
 */
export function nominationTurnTeamId(s: {
  status: string;
  nominatorTeamId: string | null;
  nominatedPlayer: unknown;
}): string | null {
  return s.status === "IN_PROGRESS" && !s.nominatedPlayer
    ? s.nominatorTeamId
    : null;
}

/**
 * The words before the nominating team's name in the lot card's header.
 * "On the clock" belongs to the nomination turn only; while a lot is live the
 * team is just who put the player up, and the clock beside it is the bidding
 * clock. A lot the clock opened for an absent captain says so — it used to
 * read exactly like their own choice.
 */
export function lotHeadingLead(o: {
  lotLive: boolean;
  autoNominated?: boolean;
}): string {
  if (!o.lotLive) return "On the clock:";
  return o.autoNominated ? "Clock ran out: auto-picked for" : "Nominated by";
}

type AuctionTeam = {
  id: string;
  name: string;
  budget: number;
  /** Everyone on the roster, the captain included. */
  members: readonly unknown[];
};

/**
 * The teams that can still top the current price on the live lot, in draft
 * order, each with the most it may bid. Same rule the server applies to a bid
 * (canBid) and the team cards show as "max $N": an open seat, a cap above the
 * price, and not already holding the high bid.
 */
export function outbidders(s: {
  teams: readonly AuctionTeam[];
  teamSize: number;
  minBid?: number;
  currentBid: number;
  currentBidTeamId: string | null;
}): { id: string; name: string; cap: number }[] {
  const minBid = s.minBid ?? DEFAULTS.MIN_BID;
  return s.teams
    .filter((t) => t.id !== s.currentBidTeamId)
    .map((t) => ({
      id: t.id,
      name: t.name,
      cap: maxBid(
        { id: t.id, budget: t.budget, rosterCount: t.members.length },
        s.teamSize,
        minBid,
      ),
      need: teamNeed(s.teamSize, t.members.length),
    }))
    .filter((t) => t.need > 0 && t.cap > s.currentBid)
    .map(({ id, name, cap }) => ({ id, name, cap }));
}

/**
 * One line under a live lot: who can still respond to this price, or that
 * nobody can. Deciding whether to go higher turns on exactly this, and it used
 * to mean scanning every team card for a 10px "max $N" turning red.
 * Null when there is no high bid to outbid.
 */
export function outbidLine(s: {
  teams: readonly AuctionTeam[];
  teamSize: number;
  minBid?: number;
  currentBid: number;
  currentBidTeamId: string | null;
  myTeamId: string | null;
}): string | null {
  if (!s.currentBidTeamId) return null;
  const rivals = outbidders(s);
  if (rivals.length > 0) {
    const names = rivals.map(
      (t) => `${t.id === s.myTeamId ? "you" : t.name} (up to $${t.cap})`,
    );
    return `Can still outbid: ${names.join(", ")}.`;
  }
  if (s.currentBidTeamId === s.myTeamId) {
    return `No one can outbid you: you win at $${s.currentBid} when the clock runs out.`;
  }
  const leader =
    s.teams.find((t) => t.id === s.currentBidTeamId)?.name ?? "the high bidder";
  return `No one can outbid ${leader}: sells at $${s.currentBid} when the clock runs out.`;
}

/**
 * The line under a live lot for a signed-in viewer who is not a captain: the
 * player being auctioned, or a player still waiting in the pool. Everyone else
 * — a visitor, a drafted player, an admin — gets no line (null). They all used
 * to read the captains' bidding rule on every lot, twenty-odd times a night,
 * the player on the block included, at their big moment.
 *
 * Captains are left to the room's own lines (bid controls, "You hold the high
 * bid", priced out, roster full); a captain who reaches none of those is
 * looking at a paused or closing lot, which the banner and clock already say.
 */
export function lotWatcherLine(s: {
  me: { userId: string | null; myTeamId: string | null };
  nominatedPlayer: { userId: string } | null;
  available: readonly { userId: string }[];
  currentBid: number;
  highBidderName: string | null;
}): string | null {
  const id = s.me.userId;
  if (!s.nominatedPlayer || !id || s.me.myTeamId) return null;
  if (s.nominatedPlayer.userId === id) {
    return s.highBidderName
      ? `Captains are bidding on you: ${s.highBidderName} leads at $${s.currentBid}.`
      : "Captains are bidding on you.";
  }
  if (!s.available.some((p) => p.userId === id)) return null;
  const left = s.available.length;
  return `You're still available: ${left} ${left === 1 ? "player" : "players"} left in the pool.`;
}
