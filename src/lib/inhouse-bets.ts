import { INHOUSE_BETS, INHOUSE_STATUS } from "./constants";

// Pure inhouse betting math. Every DB effect lives in inhouse-bet-service.ts;
// this file only encodes the money rules so they can be unit-tested in
// isolation (mirrors inhouse.ts for the draft and standings.ts for the league).
//
// Nothing here reads the clock: `nowMs`, `placedAtMs` and `matchStartMs` all
// arrive from the caller. That is what lets a test drive the 45-second window
// and the late-bet void without faking timers, and it is why the settlement
// resolver can re-run the same math from persisted COLUMNS hours later and get
// a byte-identical answer to the request that first tried it.
//
// THE INVARIANT THIS FILE EXISTS TO HOLD: betting is exactly zero-sum. Matched
// Cred moves between the ten players and is never created or destroyed, so
// `Σ deltas === 0` for every pool that can be constructed. A property test
// asserts it over 500 seeded pools; every rule below is written to keep it
// true, and any change that can't state why it still holds is a bug.

/**
 * One placed wager, as the caller adapts it from a Prisma `InhouseBet` row.
 * `team` is FROZEN at placement — settlement compares it to the post-teamFixes
 * roster and voids on a mismatch, which is what makes a slot swap in the
 * hand-hosted Dota lobby EV-zero in both directions.
 */
export type BetRow = {
  userId: string;
  team: number;
  stake: number;
  placedAtMs: number;
};

/**
 * The four outcomes a SETTLEMENT can produce. `INHOUSE_BET_OUTCOME` carries a
 * fifth, REFUNDED, which belongs to the dead-lobby sweeper (cancel / abandon /
 * void) — that path never reaches this function, because there is no result to
 * settle against.
 */
export type BetOutcome = "WON" | "LOST" | "VOID_LINEUP" | "VOID_LATE";

export type SettledBet = {
  userId: string;
  stake: number;
  /** How much of the stake the other side actually covered. */
  matched: number;
  outcome: BetOutcome;
  /** Net Cred change. Unmatched Cred is not in here — it was never at risk. */
  delta: number;
};

export type Settlement = {
  bets: SettledBet[];
  /** Side totals over the SURVIVORS — voided stakes are gone by this point. */
  pool1: number;
  pool2: number;
  /** min(pool1, pool2): the Cred actually in play, on each side. */
  matched: number;
  /** userId → delta, voided bettors included at 0. Stamped as `betDeltas`. */
  deltas: Record<string, number>;
};

export type PotTier = "casual" | "contested" | "high" | "marquee";

/** Team 1 (Radiant) / team 2 (Dire), or null for a row that names neither. */
function sideOf(bet: BetRow): 1 | 2 | null {
  return bet.team === 1 ? 1 : bet.team === 2 ? 2 : null;
}

function poolOf(bets: BetRow[], team: 1 | 2): number {
  return bets.reduce((s, b) => (sideOf(b) === team ? s + b.stake : s), 0);
}

/**
 * Split `total` across `weights` so the parts sum to `total` EXACTLY, by
 * largest remainder (Hamilton): everyone takes their floor first, then the
 * shortfall goes out one Cred at a time to the largest fractional remainders,
 * ties broken by key ASCENDING.
 *
 * The exactness is the whole point. A ratio-and-round split leaves a Cred or
 * two unaccounted for on most pools, and on this feature an unaccounted Cred is
 * either minted or destroyed — the zero-sum argument that makes the economy
 * safe against a throw conspiracy dies with it. The key tiebreak is the repo's
 * total-order convention (pickem.ts, hall-of-fame.ts): without it the loser of
 * a rounding tie depends on the order Prisma happened to return the rows in,
 * so the same lobby could settle two ways.
 */
export function allocate(
  weights: { key: string; weight: number }[],
  total: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of weights) out[w.key] = 0;
  if (total <= 0) return out;
  // Negative weights are impossible (a stake is a positive Int the gate has
  // already bounded), but a single bad row would otherwise shrink the divisor
  // and hand every other key MORE than the pot holds — clamp rather than
  // invent Cred.
  const clamped = weights.map((w) => ({
    key: w.key,
    weight: Math.max(0, w.weight),
  }));
  const sum = clamped.reduce((s, w) => s + w.weight, 0);
  if (sum <= 0) return out;

  // Integer arithmetic end to end: `weight * total` and `sum` are whole Cred,
  // so `remainder` is the exact numerator of the fraction that was dropped and
  // the comparison below can't be decided by float noise.
  const rows = clamped.map((w) => {
    const share = Math.floor((w.weight * total) / sum);
    return { key: w.key, share, remainder: w.weight * total - share * sum };
  });
  const order = [...rows].sort(
    (a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key),
  );
  let handed = rows.reduce((s, r) => s + r.share, 0);
  // The shortfall is strictly smaller than the number of keys with a remainder
  // left over, so this is one partial pass in practice; the wrap is there so a
  // caller passing fractional weights can't spin here forever.
  for (let i = 0; handed < total; i = (i + 1) % order.length) {
    order[i].share += 1;
    handed += 1;
  }
  for (const r of rows) out[r.key] = r.share;
  return out;
}

/**
 * How much of each bettor's stake the other side covers, given the pools.
 *
 * ONE definition, shared by the live panel and by settlement, deliberately:
 * they are the same question asked at two moments, and the panel's promise
 * ("100 staked · 40 covered · 60 comes home") is only worth anything if the
 * payout agrees with it to the Cred. `avgKnownMmr` is the cautionary tale —
 * three inline copies of one average, disagreeing on screen.
 *
 * The short side is matched at ratio 1.0 (its pool IS the matched total), which
 * is not a special case bolted on but the built-in magnet back toward a
 * balanced pot: staking into the bigger pool buys you a worse fraction, and the
 * COVER button exists to say so before the tap.
 *
 * That branch is an EQUIVALENT MUTANT and no test can kill it: `allocate` over
 * the short side splits its own total across its own stakes, so every floor
 * lands exactly on the stake and the remainder pass has nothing to hand out.
 * It stays because it states the ratio-1.0 rule where a reader looks for it —
 * don't go hunting for the test that covers it, and don't read "no test moved"
 * as a licence to change what it says.
 */
function coverage(
  bets: BetRow[],
  pool1: number,
  pool2: number,
  matched: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of bets) out[b.userId] = 0;
  if (matched <= 0) return out;
  for (const team of [1, 2] as const) {
    const side = bets.filter((b) => sideOf(b) === team);
    const pool = team === 1 ? pool1 : pool2;
    if (pool === matched) {
      for (const b of side) out[b.userId] = b.stake;
      continue;
    }
    Object.assign(
      out,
      allocate(
        side.map((b) => ({ key: b.userId, weight: b.stake })),
        matched,
      ),
    );
  }
  return out;
}

/**
 * The pot as it stands DURING the window: no voids (nobody has played yet, so
 * no lineup can have moved and no start time exists to be late against) and no
 * winner. Every figure here is public the instant a bet lands — the slips are
 * the product, and a pot nobody can see is an argument nobody can join.
 */
export function potView(bets: BetRow[]): {
  pool1: number;
  pool2: number;
  matched: number;
  coveredByUser: Record<string, number>;
} {
  const pool1 = poolOf(bets, 1);
  const pool2 = poolOf(bets, 2);
  const matched = Math.min(pool1, pool2);
  return {
    pool1,
    pool2,
    matched,
    coveredByUser: coverage(bets, pool1, pool2, matched),
  };
}

/**
 * Settle a finished lobby's confirmed bets.
 *
 * THE ORDER IS LOAD-BEARING, and it is the first thing to check if this ever
 * misbehaves: voids are identified and REMOVED BEFORE the pools are computed.
 * Void afterwards and the survivors are matched against Cred that is being
 * refunded in the same breath — the returning side keeps its full stake AND
 * dilutes everyone else's covered fraction, so the two sides' matched totals
 * stop being equal and `Σ deltas` walks away from zero. That is the one bug in
 * this file that pays out real (play-)money to the wrong people, and it looks
 * completely correct in review: every individual rule still reads right.
 *
 * `rosterTeam` must be the POST-`teamFixes` roster — the played game is the
 * truth about who was on which side (see buildResult), and this check is what
 * makes a two-man slot swap in the hand-hosted lobby worthless rather than a
 * live arbitrage. An absent or null seat voids too: a bet we cannot tie to a
 * side that actually played is not a bet we can honour.
 */
export function settleBets(input: {
  bets: BetRow[];
  /** userId → the side they actually played, POST-teamFixes. */
  rosterTeam: Map<string, number | null>;
  winnerTeam: number;
  /** The PLAYED game's own start, from OpenDota. null ⇒ no late-bet void. */
  matchStartMs: number | null;
}): Settlement {
  const { bets, rosterTeam, winnerTeam, matchStartMs } = input;

  // (1) Grade every bet for a void, before anything is added up.
  const graded = bets.map((bet) => {
    // Late first, arbitrarily but FIXED — a bet can be both, and settlement has
    // to name one outcome. Valve's own start_time is the one timestamp ten
    // interested parties can't forge, so when it says the bet came after the
    // first creep spawned, that is the more precise thing to tell the player.
    if (matchStartMs != null && bet.placedAtMs > matchStartMs) {
      return { bet, voided: "VOID_LATE" as const };
    }
    const seat = rosterTeam.get(bet.userId) ?? null;
    if (seat !== bet.team) return { bet, voided: "VOID_LINEUP" as const };
    return { bet, voided: null };
  });

  // (2) + (3) Pools over the survivors ONLY.
  const live = graded.filter((g) => !g.voided).map((g) => g.bet);
  const pool1 = poolOf(live, 1);
  const pool2 = poolOf(live, 2);
  // A winner naming neither side can't be honoured, so nothing is at risk and
  // every stake comes home untouched. Unreachable from the service (it throws
  // on a null `winnerTeam` before calling), but the alternative if it ever were
  // reachable is charging BOTH sides — money destroyed, by a caller bug.
  const decided = winnerTeam === 1 || winnerTeam === 2;
  const matched = decided ? Math.min(pool1, pool2) : 0;

  // (4) + (5)
  const covered = coverage(live, pool1, pool2, matched);
  const deltas: Record<string, number> = {};
  const settled = graded.map(({ bet, voided }) => {
    if (voided) {
      // Full refund: matched 0, delta 0. The service hands the stake back as
      // its own ledger leg, so a voided bettor ends the night exactly where
      // they started — one person's cold feet never costs the other nine.
      deltas[bet.userId] = 0;
      return {
        userId: bet.userId,
        stake: bet.stake,
        matched: 0,
        outcome: voided,
        delta: 0,
      };
    }
    const mine = covered[bet.userId] ?? 0;
    const won = bet.team === winnerTeam;
    const delta = won ? mine : -mine;
    deltas[bet.userId] = delta;
    return {
      userId: bet.userId,
      stake: bet.stake,
      matched: mine,
      outcome: (won ? "WON" : "LOST") as BetOutcome,
      delta,
    };
  });

  return { bets: settled, pool1, pool2, matched, deltas };
}

/** Statuses in which the 45-second window can still be open. */
const BETTABLE_STATUSES: string[] = [
  INHOUSE_STATUS.READY,
  // Pressing Start does NOT close betting: nobody should ever be the person who
  // "closed the ante", and Start has to stay instant. The window closes on
  // `betsCloseAt` alone, which is stamped once and by one code path.
  INHOUSE_STATUS.IN_PROGRESS,
];

/**
 * Why this player can't place this bet (null = they can). Called by the service
 * at read time AND by the room to disable the chips, so the button and the
 * refusal can never tell different stories.
 *
 * NOT a guard. Every input here is read before the write and can be false by
 * the time it lands — the window expiring and an admin cancel are exactly what
 * commits in that gap — so the service re-asserts the window, the membership
 * and the balance in the WHERE of its own writes. This is the sentence a player
 * reads, nothing more.
 */
export function betGateError(o: {
  balance: number;
  stake: number;
  /** The viewer's side in this lobby, or null when they aren't in it. */
  myTeam: number | null;
  lobbyStatus: string;
  betsCloseAtMs: number | null;
  nowMs: number;
  alreadyBet: boolean;
}): string | null {
  // Eligibility is membership of the ten, never "is signed in": /api/inhouse
  // answers `state` before its 401 gate, so a session proves nothing here.
  if (o.myTeam !== 1 && o.myTeam !== 2) {
    return "You're not in this game.";
  }
  // Same wording as the service's P2002 catch — one refusal, one sentence,
  // whichever of the two paths gets there first.
  if (o.alreadyBet) {
    return "You already have a bet on this game.";
  }
  if (!BETTABLE_STATUSES.includes(o.lobbyStatus)) {
    // Before READY the window hasn't opened; after IN_PROGRESS there is
    // nothing left to bet on. Say which — "closed" on a lobby that is still
    // drafting reads as a bug.
    return o.lobbyStatus === INHOUSE_STATUS.COMPLETED ||
      o.lobbyStatus === INHOUSE_STATUS.CANCELLED
      ? "This game is over."
      : "Betting opens when the teams lock.";
  }
  // A READY lobby with no `betsCloseAt` is a lobby that reached READY through a
  // path which forgot to stamp the window (there are two such write sites).
  // Refuse honestly rather than pretending the window has expired — "never
  // opened" and "just closed" are different bugs to chase.
  if (o.betsCloseAtMs == null) {
    return "Betting isn't open on this game.";
  }
  if (o.nowMs >= o.betsCloseAtMs) {
    return "Betting has closed on this game.";
  }
  if (!Number.isInteger(o.stake) || o.stake % INHOUSE_BETS.STEP !== 0) {
    return `Bets go in ${INHOUSE_BETS.STEP}s of Cred.`;
  }
  if (o.stake < INHOUSE_BETS.MIN_STAKE || o.stake > INHOUSE_BETS.MAX_STAKE) {
    return `A bet is ${INHOUSE_BETS.MIN_STAKE}–${INHOUSE_BETS.MAX_STAKE} Cred.`;
  }
  if (o.balance < o.stake) {
    return `Not enough Cred — you have ${o.balance}.`;
  }
  return null;
}

/**
 * How loud the pot is, from the TOTAL staked (both sides, matched or not).
 *
 * Because matched pools pay even money, a side that thinks it is behind stakes
 * nothing — so pot size is a live read on how close the ten think the game is,
 * which is the one number here worth putting on a label.
 */
export function potTier(total: number): PotTier {
  if (total >= INHOUSE_BETS.TIER_MARQUEE) return "marquee";
  if (total >= INHOUSE_BETS.TIER_HIGH) return "high";
  if (total >= INHOUSE_BETS.TIER_CONTESTED) return "contested";
  return "casual";
}

/**
 * The chip's text — empty for `casual`, which renders NOTHING rather than the
 * word "casual". A label on every pot is wallpaper within a night, and the
 * surfaces that carry this (the room panel, the pinned Discord board's frozen
 * LIVE line) are ones a reader sees permanently.
 */
export function tierLabel(t: PotTier): string {
  if (t === "marquee") return "MARQUEE";
  if (t === "high") return "HIGH STAKES";
  if (t === "contested") return "CONTESTED";
  return "";
}
