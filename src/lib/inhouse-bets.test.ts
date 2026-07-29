import { describe, expect, it } from "vitest";
import {
  allocate,
  betGateError,
  potTier,
  potView,
  settleBets,
  tierLabel,
  type BetRow,
} from "./inhouse-bets";
import { INHOUSE_BETS, INHOUSE_STATUS } from "./constants";

const bet = (
  userId: string,
  team: number,
  stake: number,
  placedAtMs = 0,
): BetRow => ({ userId, team, stake, placedAtMs });

/** The roster settlement compares against — POST-teamFixes, per player. */
const roster = (...pairs: [string, number | null][]) =>
  new Map<string, number | null>(pairs);

/** Every bet's own side, unless a pair below says otherwise. */
const rosterFrom = (bets: BetRow[], ...overrides: [string, number | null][]) => {
  const m = new Map<string, number | null>(bets.map((b) => [b.userId, b.team]));
  for (const [id, team] of overrides) m.set(id, team);
  return m;
};

const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0);
const totalDelta = (deltas: Record<string, number>) => sum(Object.values(deltas));

describe("allocate", () => {
  it("hands out exactly the total, never a Cred more or less", () => {
    // Worked example 2: 120 matched across a 280-Cred long side.
    const out = allocate(
      [
        { key: "dooley", weight: 100 },
        { key: "mig", weight: 100 },
        { key: "nine", weight: 60 },
        { key: "pia", weight: 20 },
      ],
      120,
    );
    // Floors are 42 / 42 / 25 / 8 (Σ 117); the 3 short go to the three largest
    // remainders, and Pia's .571 is the one that misses out.
    expect(out).toEqual({ dooley: 43, mig: 43, nine: 26, pia: 8 });
    expect(sum(Object.values(out))).toBe(120);
  });

  it("breaks a remainder tie by key ASCENDING", () => {
    // Four equal weights, ten to share: everyone floors at 2 with an identical
    // remainder, so the two spare Cred are decided by the tiebreak alone.
    const out = allocate(
      [
        { key: "d", weight: 10 },
        { key: "b", weight: 10 },
        { key: "a", weight: 10 },
        { key: "c", weight: 10 },
      ],
      10,
    );
    expect(out).toEqual({ a: 3, b: 3, c: 2, d: 2 });
  });

  it("does not depend on the order the rows arrive in", () => {
    const rows = [
      { key: "zeta", weight: 70 },
      { key: "alpha", weight: 30 },
      { key: "mid", weight: 45 },
    ];
    expect(allocate([...rows].reverse(), 61)).toEqual(allocate(rows, 61));
  });

  it("returns every key at zero when there is nothing to split", () => {
    const rows = [
      { key: "a", weight: 10 },
      { key: "b", weight: 20 },
    ];
    expect(allocate(rows, 0)).toEqual({ a: 0, b: 0 });
    // Nobody staked: the weights sum to zero and there is no ratio to take.
    expect(allocate([{ key: "a", weight: 0 }], 50)).toEqual({ a: 0 });
    expect(allocate([], 50)).toEqual({});
  });

  it("gives a lone weight the whole total", () => {
    expect(allocate([{ key: "solo", weight: 10 }], 100)).toEqual({ solo: 100 });
  });

  it("conserves across a sweep of awkward splits", () => {
    for (let n = 2; n <= 7; n++) {
      const rows = Array.from({ length: n }, (_, i) => ({
        key: `u${i}`,
        weight: 10 * (i + 1) + (i % 3), // deliberately not divisible
      }));
      const pool = sum(rows.map((r) => r.weight));
      // Only ever up to the pool itself: the long side is allocating the SHORT
      // side's total, which by construction can't exceed its own stakes.
      for (let total = 0; total <= pool; total += 7) {
        const out = allocate(rows, total);
        expect(sum(Object.values(out))).toBe(total);
        // Nobody is handed more than their own weight — a share above your own
        // stake would be Cred the pot never held.
        for (const r of rows) expect(out[r.key]).toBeLessThanOrEqual(r.weight);
      }
    }
  });
});

describe("settleBets", () => {
  it("pays even money when both sides matched at ratio 1.0 (worked example 1)", () => {
    const bets = [
      bet("kessler", 1, 100),
      bet("roo", 1, 50),
      bet("vex", 1, 40),
      bet("bo", 1, 10),
      bet("dooley", 2, 100),
      bet("mig", 2, 60),
      bet("nine", 2, 40),
    ];
    const s = settleBets({
      bets,
      rosterTeam: rosterFrom(bets),
      winnerTeam: 1,
      matchStartMs: null,
    });
    expect(s.pool1).toBe(200);
    expect(s.pool2).toBe(200);
    expect(s.matched).toBe(200);
    expect(s.deltas).toEqual({
      kessler: 100,
      roo: 50,
      vex: 40,
      bo: 10,
      dooley: -100,
      mig: -60,
      nine: -40,
    });
    expect(totalDelta(s.deltas)).toBe(0);
  });

  it("matches the short side in full and allocates the long side (worked example 2)", () => {
    const bets = [
      bet("ash", 1, 100),
      bet("bo", 1, 20),
      bet("dooley", 2, 100),
      bet("mig", 2, 100),
      bet("nine", 2, 60),
      bet("pia", 2, 20),
    ];
    const s = settleBets({
      bets,
      rosterTeam: rosterFrom(bets),
      winnerTeam: 2,
      matchStartMs: null,
    });
    expect([s.pool1, s.pool2, s.matched]).toEqual([120, 280, 120]);
    // Short side (team 1) covered in full; long side by largest remainder.
    expect(s.deltas).toEqual({
      ash: -100,
      bo: -20,
      dooley: 43,
      mig: 43,
      nine: 26,
      pia: 8,
    });
    expect(totalDelta(s.deltas)).toBe(0);
    // The underdog side's extra 160 was never live — it comes home untouched,
    // which is what `matched < stake` means to the service's RETURN leg.
    const dooley = s.bets.find((b) => b.userId === "dooley")!;
    expect(dooley.stake - dooley.matched).toBe(57);
  });

  it("caps a lopsided pool at the small side (worked example 3)", () => {
    const bets = [
      bet("a", 1, 100),
      bet("b", 1, 100),
      bet("c", 1, 100),
      bet("d", 1, 100),
      bet("e", 1, 100),
      bet("q", 2, 20),
    ];
    const s = settleBets({
      bets,
      rosterTeam: rosterFrom(bets),
      winnerTeam: 1,
      matchStartMs: null,
    });
    expect(s.matched).toBe(20);
    // Staking 500 against 20 wins 20, four Cred each.
    for (const id of ["a", "b", "c", "d", "e"]) expect(s.deltas[id]).toBe(4);
    expect(s.deltas.q).toBe(-20);
    expect(totalDelta(s.deltas)).toBe(0);
  });

  it("returns every stake when one side stakes nothing", () => {
    const bets = [bet("a", 1, 50), bet("b", 1, 30)];
    const s = settleBets({
      bets,
      rosterTeam: rosterFrom(bets),
      winnerTeam: 1,
      matchStartMs: null,
    });
    // Perfect information is worth exactly zero as a property of the mechanism:
    // with nobody on the other side there is nothing to collect.
    expect([s.pool1, s.pool2, s.matched]).toEqual([80, 0, 0]);
    for (const b of s.bets) {
      expect(b.matched).toBe(0);
      expect(b.delta).toBe(0);
    }
    expect(totalDelta(s.deltas)).toBe(0);
  });

  it("handles no bets at all", () => {
    const s = settleBets({
      bets: [],
      rosterTeam: roster(),
      winnerTeam: 1,
      matchStartMs: null,
    });
    expect(s).toEqual({
      bets: [],
      pool1: 0,
      pool2: 0,
      matched: 0,
      deltas: {},
    });
  });

  it("VOIDS a bettor whose post-teamFixes side isn't the side they bet on", () => {
    const bets = [bet("swapper", 1, 100), bet("honest", 2, 100)];
    const s = settleBets({
      bets,
      // teamFixes moved the swapper onto team 2 — the played game is the truth.
      rosterTeam: roster(["swapper", 2], ["honest", 2]),
      winnerTeam: 2,
      matchStartMs: null,
    });
    const swapper = s.bets.find((b) => b.userId === "swapper")!;
    expect(swapper.outcome).toBe("VOID_LINEUP");
    expect(swapper.matched).toBe(0);
    expect(swapper.delta).toBe(0);
    // …and their stake is gone from the pool the survivor would be matched
    // against, so the honest bet has nothing live either.
    expect([s.pool1, s.pool2, s.matched]).toEqual([0, 100, 0]);
    expect(s.deltas).toEqual({ swapper: 0, honest: 0 });
  });

  it("voids a bettor missing from the roster entirely", () => {
    const bets = [bet("ghost", 1, 50), bet("real", 2, 50)];
    const s = settleBets({
      bets,
      rosterTeam: roster(["real", 2]), // no row for `ghost`
      winnerTeam: 2,
      matchStartMs: null,
    });
    expect(s.bets.find((b) => b.userId === "ghost")!.outcome).toBe(
      "VOID_LINEUP",
    );
    expect(s.matched).toBe(0);
  });

  it("voids a bet placed after the played game's own start_time", () => {
    const bets = [bet("early", 1, 40, 1_000), bet("late", 2, 40, 9_000)];
    const s = settleBets({
      bets,
      rosterTeam: rosterFrom(bets),
      winnerTeam: 1,
      matchStartMs: 5_000,
    });
    expect(s.bets.find((b) => b.userId === "late")!.outcome).toBe("VOID_LATE");
    expect(s.bets.find((b) => b.userId === "early")!.outcome).toBe("WON");
    expect(s.matched).toBe(0); // team 2's only stake left the pool
    expect(totalDelta(s.deltas)).toBe(0);
  });

  it("never voids on time when there is no recorded start (matchStartMs null)", () => {
    const bets = [
      bet("a", 1, 40, Number.MAX_SAFE_INTEGER),
      bet("b", 2, 40, Number.MAX_SAFE_INTEGER),
    ];
    const s = settleBets({
      bets,
      rosterTeam: rosterFrom(bets),
      winnerTeam: 1,
      matchStartMs: null,
    });
    expect(s.bets.map((b) => b.outcome)).toEqual(["WON", "LOST"]);
    expect(s.matched).toBe(40);
  });

  it("a bet exactly ON the start time still stands", () => {
    const bets = [bet("a", 1, 10, 5_000), bet("b", 2, 10, 5_000)];
    const s = settleBets({
      bets,
      rosterTeam: rosterFrom(bets),
      winnerTeam: 1,
      matchStartMs: 5_000,
    });
    expect(s.bets.every((b) => b.outcome !== "VOID_LATE")).toBe(true);
  });

  // The ordering test the whole file is built around. Every number below is
  // chosen so that voiding AFTER the pools are computed still returns the
  // voided stake, still looks locally correct, and quietly pays the survivors
  // the wrong amount.
  describe("voids leave the pools BEFORE they are computed", () => {
    it("does not match survivors against a voided stake (VOID_LINEUP)", () => {
      const bets = [
        bet("swapper", 1, 100), // voided: teamFixes says they played team 2
        bet("bo", 1, 20),
        bet("q", 2, 20),
      ];
      const s = settleBets({
        bets,
        rosterTeam: roster(["swapper", 2], ["bo", 1], ["q", 2]),
        winnerTeam: 1,
        matchStartMs: null,
      });
      // Void first  → pool1 20 vs pool2 20, M = 20, Bo fully covered.
      // Void after   → pool1 120 vs pool2 20, M = 20, Bo allocated just 3 of it
      //                (the swapper would soak up 17), and Σ deltas = -17.
      expect([s.pool1, s.pool2, s.matched]).toEqual([20, 20, 20]);
      expect(s.deltas).toEqual({ swapper: 0, bo: 20, q: -20 });
      expect(totalDelta(s.deltas)).toBe(0);
    });

    it("does not match survivors against a late stake (VOID_LATE)", () => {
      const bets = [
        bet("sniper", 1, 100, 9_000), // placed after the game started
        bet("bo", 1, 20, 1_000),
        bet("q", 2, 20, 1_000),
      ];
      const s = settleBets({
        bets,
        rosterTeam: rosterFrom(bets),
        winnerTeam: 2,
        matchStartMs: 5_000,
      });
      expect([s.pool1, s.pool2, s.matched]).toEqual([20, 20, 20]);
      expect(s.deltas).toEqual({ sniper: 0, bo: -20, q: 20 });
      expect(totalDelta(s.deltas)).toBe(0);
    });
  });

  it("labels a bet that is both late and off-lineup as VOID_LATE", () => {
    const bets = [bet("both", 1, 30, 9_000)];
    const s = settleBets({
      bets,
      rosterTeam: roster(["both", 2]),
      winnerTeam: 1,
      matchStartMs: 5_000,
    });
    expect(s.bets[0].outcome).toBe("VOID_LATE");
    expect(s.bets[0].delta).toBe(0);
  });

  it("risks nothing when the winner names neither side", () => {
    const bets = [bet("a", 1, 50), bet("b", 2, 50)];
    const s = settleBets({
      bets,
      rosterTeam: rosterFrom(bets),
      winnerTeam: 0, // unreachable from the service, which throws first
      matchStartMs: null,
    });
    // Charging both sides would DESTROY 100 Cred on a caller bug; every stake
    // comes home instead.
    expect(s.matched).toBe(0);
    expect(totalDelta(s.deltas)).toBe(0);
    expect(s.bets.every((b) => b.matched === 0 && b.delta === 0)).toBe(true);
  });

  it("reports one settled row per bet, in input order", () => {
    const bets = [bet("z", 1, 10), bet("a", 2, 10), bet("m", 1, 10)];
    const s = settleBets({
      bets,
      rosterTeam: rosterFrom(bets),
      winnerTeam: 1,
      matchStartMs: null,
    });
    expect(s.bets.map((b) => b.userId)).toEqual(["z", "a", "m"]);
  });
});

describe("potView", () => {
  it("shows both pools and what each Cred is actually covering", () => {
    const bets = [bet("ash", 1, 100), bet("dooley", 2, 40)];
    const view = potView(bets);
    expect([view.pool1, view.pool2, view.matched]).toEqual([100, 40, 40]);
    // "100 staked · 40 covered · 60 comes home" — the panel's promise.
    expect(view.coveredByUser).toEqual({ ash: 40, dooley: 40 });
  });

  it("covers nobody while only one side has staked", () => {
    const view = potView([bet("a", 1, 50), bet("b", 1, 50)]);
    expect(view.matched).toBe(0);
    expect(view.coveredByUser).toEqual({ a: 0, b: 0 });
  });

  it("is empty before the first bet lands", () => {
    expect(potView([])).toEqual({
      pool1: 0,
      pool2: 0,
      matched: 0,
      coveredByUser: {},
    });
  });

  it("agrees with settleBets on the matched figure and on every slip", () => {
    // The panel and the payout are the same question at two moments; if they
    // disagree, the number the player tapped on was a lie.
    const bets = [
      bet("ash", 1, 100),
      bet("bo", 1, 20),
      bet("dooley", 2, 100),
      bet("mig", 2, 100),
      bet("nine", 2, 60),
      bet("pia", 2, 20),
    ];
    const view = potView(bets);
    const s = settleBets({
      bets,
      rosterTeam: rosterFrom(bets),
      winnerTeam: 1,
      matchStartMs: null,
    });
    expect(view.matched).toBe(s.matched);
    expect([view.pool1, view.pool2]).toEqual([s.pool1, s.pool2]);
    for (const settled of s.bets) {
      expect(view.coveredByUser[settled.userId]).toBe(settled.matched);
      expect(Math.abs(settled.delta)).toBe(view.coveredByUser[settled.userId]);
    }
  });
});

describe("betGateError", () => {
  type GateInput = Parameters<typeof betGateError>[0];

  // A player who is in the game, inside the window, with the Cred for it —
  // every case below is this one with a single thing wrong.
  const ok: GateInput = {
    balance: 500,
    stake: 50,
    myTeam: 1,
    lobbyStatus: INHOUSE_STATUS.READY,
    betsCloseAtMs: 10_000,
    nowMs: 5_000,
    alreadyBet: false,
  };

  const cases: [string, Partial<GateInput>, string | null][] = [
    ["a legal bet inside the window", {}, null],
    [
      "Start doesn't close betting",
      { lobbyStatus: INHOUSE_STATUS.IN_PROGRESS },
      null,
    ],
    ["the minimum stake", { stake: INHOUSE_BETS.MIN_STAKE }, null],
    ["the maximum stake", { stake: INHOUSE_BETS.MAX_STAKE, balance: 100 }, null],
    ["spending the last of the balance", { stake: 50, balance: 50 }, null],
    ["a spectator", { myTeam: null }, "You're not in this game."],
    ["a bogus side", { myTeam: 0 }, "You're not in this game."],
    [
      "a second bet",
      { alreadyBet: true },
      "You already have a bet on this game.",
    ],
    [
      "the draft still running",
      { lobbyStatus: INHOUSE_STATUS.DRAFTING },
      "Betting opens when the teams lock.",
    ],
    [
      "a lobby still in its ready check",
      { lobbyStatus: INHOUSE_STATUS.READY_CHECK },
      "Betting opens when the teams lock.",
    ],
    [
      "a finished game",
      { lobbyStatus: INHOUSE_STATUS.COMPLETED },
      "This game is over.",
    ],
    [
      "a cancelled game",
      { lobbyStatus: INHOUSE_STATUS.CANCELLED },
      "This game is over.",
    ],
    [
      "a READY lobby that never got a window stamped",
      { betsCloseAtMs: null },
      "Betting isn't open on this game.",
    ],
    [
      "the window having expired",
      { nowMs: 10_001 },
      "Betting has closed on this game.",
    ],
    [
      "the exact closing millisecond",
      { nowMs: 10_000 },
      "Betting has closed on this game.",
    ],
    [
      "an off-step stake",
      { stake: 15 },
      `Bets go in ${INHOUSE_BETS.STEP}s of Cred.`,
    ],
    [
      "a fractional stake",
      { stake: 10.5 },
      `Bets go in ${INHOUSE_BETS.STEP}s of Cred.`,
    ],
    [
      "a stake that isn't a number at all",
      { stake: Number.NaN },
      `Bets go in ${INHOUSE_BETS.STEP}s of Cred.`,
    ],
    [
      "a zero stake",
      { stake: 0 },
      `A bet is ${INHOUSE_BETS.MIN_STAKE}–${INHOUSE_BETS.MAX_STAKE} Cred.`,
    ],
    [
      "a negative stake",
      { stake: -10 },
      `A bet is ${INHOUSE_BETS.MIN_STAKE}–${INHOUSE_BETS.MAX_STAKE} Cred.`,
    ],
    [
      "a stake over the flat cap",
      { stake: INHOUSE_BETS.MAX_STAKE + INHOUSE_BETS.STEP },
      `A bet is ${INHOUSE_BETS.MIN_STAKE}–${INHOUSE_BETS.MAX_STAKE} Cred.`,
    ],
    [
      "not enough Cred",
      { stake: 50, balance: 40 },
      "Not enough Cred — you have 40.",
    ],
    ["a broke account", { stake: 10, balance: 0 }, "Not enough Cred — you have 0."],
  ];

  for (const [name, over, expected] of cases) {
    it(`${expected === null ? "allows" : "refuses"} ${name}`, () => {
      expect(betGateError({ ...ok, ...over })).toBe(expected);
    });
  }

  // The check ORDER is part of the contract: the most fundamental refusal wins,
  // so a spectator is never told to fix their stake.
  it("reports membership before anything else", () => {
    expect(
      betGateError({
        ...ok,
        myTeam: null,
        alreadyBet: true,
        stake: 7,
        balance: 0,
        lobbyStatus: INHOUSE_STATUS.COMPLETED,
      }),
    ).toBe("You're not in this game.");
  });

  it("tells a player who already bet that they already bet, even once the window has gone", () => {
    // Bets are single-shot and immutable, so "you already have one" is the
    // useful sentence — "betting has closed" would send them looking for a
    // window they never needed.
    expect(betGateError({ ...ok, alreadyBet: true, nowMs: 99_999 })).toBe(
      "You already have a bet on this game.",
    );
  });

  it("reports a closed window before quibbling about the stake", () => {
    expect(betGateError({ ...ok, nowMs: 99_999, stake: 15 })).toBe(
      "Betting has closed on this game.",
    );
  });

  it("reports the stake shape before the balance", () => {
    expect(betGateError({ ...ok, stake: 990, balance: 0 })).toBe(
      `A bet is ${INHOUSE_BETS.MIN_STAKE}–${INHOUSE_BETS.MAX_STAKE} Cred.`,
    );
  });
});

describe("potTier / tierLabel", () => {
  it("tiers off the total staked", () => {
    expect(potTier(0)).toBe("casual");
    expect(potTier(INHOUSE_BETS.TIER_CONTESTED - 1)).toBe("casual");
    expect(potTier(INHOUSE_BETS.TIER_CONTESTED)).toBe("contested");
    expect(potTier(INHOUSE_BETS.TIER_HIGH - 1)).toBe("contested");
    expect(potTier(INHOUSE_BETS.TIER_HIGH)).toBe("high");
    expect(potTier(INHOUSE_BETS.TIER_MARQUEE - 1)).toBe("high");
    expect(potTier(INHOUSE_BETS.TIER_MARQUEE)).toBe("marquee");
    // Ten players, every one of them maxed out.
    expect(potTier(INHOUSE_BETS.MAX_STAKE * 10)).toBe("marquee");
  });

  it("renders nothing for a casual pot", () => {
    expect(tierLabel("casual")).toBe("");
    expect(tierLabel("contested")).toBe("CONTESTED");
    expect(tierLabel("high")).toBe("HIGH STAKES");
    expect(tierLabel("marquee")).toBe("MARQUEE");
  });
});

// Deterministic PRNG so the property test below never flakes and any failure
// reproduces from the seed alone (same generator as scenarios.test.ts).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("settleBets — conservation property (seeded random pools)", () => {
  it("Σ deltas is exactly 0 for every pool that can be built", () => {
    const rand = mulberry32(0x0d2b2026);
    const pick = (n: number) => Math.floor(rand() * n);
    // A property that never sees a void, a lopsided pool or an empty side is a
    // property about nothing — count the interesting shapes and demand them.
    const seen = {
      voidLineup: 0,
      voidLate: 0,
      zeroPool: 0,
      lopsided: 0,
      even: 0,
      clean: 0,
    };

    for (let iter = 0; iter < 500; iter++) {
      const n = 1 + pick(10);
      const bets: BetRow[] = [];
      const rosterTeam = new Map<string, number | null>();
      for (let i = 0; i < n; i++) {
        const userId = `u${i}`;
        const team = 1 + pick(2);
        // Chips only: whole Cred, in STEP-sized jumps, under the flat cap.
        const stake = INHOUSE_BETS.STEP * (1 + pick(10));
        bets.push(bet(userId, team, stake, 1_000 + pick(10_000)));
        const roll = rand();
        // 12% play the other side (teamFixes), 6% never show on the roster.
        rosterTeam.set(
          userId,
          roll < 0.06 ? null : roll < 0.18 ? (team === 1 ? 2 : 1) : team,
        );
      }
      const matchStartMs = rand() < 0.5 ? null : 1_000 + pick(10_000);
      const winnerTeam = 1 + pick(2);

      const s = settleBets({ bets, rosterTeam, winnerTeam, matchStartMs });
      const why = `seed iteration ${iter}`;

      // THE invariant: matched Cred moves between the ten and is never minted.
      expect(totalDelta(s.deltas), why).toBe(0);

      // Every bettor is accounted for exactly once, voided ones included.
      expect(Object.keys(s.deltas).length, why).toBe(n);
      expect(s.bets.length, why).toBe(n);

      const survivors = s.bets.filter(
        (b) => b.outcome === "WON" || b.outcome === "LOST",
      );
      const voided = s.bets.filter((b) => !survivors.includes(b));
      for (const v of voided) {
        expect(v.matched, why).toBe(0);
        expect(v.delta, why).toBe(0);
        if (v.outcome === "VOID_LATE") seen.voidLate++;
        else seen.voidLineup++;
      }

      // Pools are the survivors' stakes and nothing else — this is the
      // void-before-pools ordering, asserted over every generated shape.
      const bySide = (team: 1 | 2) =>
        survivors.filter(
          (b) => bets.find((x) => x.userId === b.userId)!.team === team,
        );
      expect(s.pool1, why).toBe(sum(bySide(1).map((b) => b.stake)));
      expect(s.pool2, why).toBe(sum(bySide(2).map((b) => b.stake)));
      expect(s.matched, why).toBe(Math.min(s.pool1, s.pool2));

      // Both sides put up the same Cred — that equality IS the zero-sum proof.
      expect(sum(bySide(1).map((b) => b.matched)), why).toBe(s.matched);
      expect(sum(bySide(2).map((b) => b.matched)), why).toBe(s.matched);

      for (const b of s.bets) {
        expect(Number.isInteger(b.matched), why).toBe(true);
        expect(b.matched, why).toBeGreaterThanOrEqual(0);
        // You can never have more covered than you staked.
        expect(b.matched, why).toBeLessThanOrEqual(b.stake);
        expect(Math.abs(b.delta), why).toBe(b.matched);
        const won =
          bets.find((x) => x.userId === b.userId)!.team === winnerTeam;
        if (b.outcome === "WON") expect(won, why).toBe(true);
        if (b.outcome === "LOST") expect(won, why).toBe(false);
        if (b.delta > 0) expect(b.outcome, why).toBe("WON");
        if (b.delta < 0) expect(b.outcome, why).toBe("LOST");
      }

      if (s.matched === 0) seen.zeroPool++;
      else if (s.pool1 === s.pool2) seen.even++;
      else seen.lopsided++;

      // With nothing voided the live panel must have shown these exact numbers.
      if (voided.length === 0) {
        seen.clean++;
        const view = potView(bets);
        expect(view.matched, why).toBe(s.matched);
        expect([view.pool1, view.pool2], why).toEqual([s.pool1, s.pool2]);
        for (const b of s.bets) {
          expect(view.coveredByUser[b.userId], why).toBe(b.matched);
        }
      }
    }

    for (const [shape, count] of Object.entries(seen)) {
      expect(count, `the seed never produced a ${shape} pool`).toBeGreaterThan(
        0,
      );
    }
  });
});
