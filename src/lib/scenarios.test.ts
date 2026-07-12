import { describe, expect, it } from "vitest";
import {
  matchStakes,
  scenarioReport,
  stakesHeadline,
  type ScenarioMatch,
  type ScenarioReport,
  type TeamScenario,
} from "./scenarios";
import {
  clinchStatuses,
  computeStandings,
  type MatchLike,
  type TeamStanding,
} from "./standings";

function row(teamId: string, points: number): TeamStanding {
  return {
    teamId,
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    points,
    gameWins: 0,
    gameLosses: 0,
    gameDiff: 0,
  };
}

let matchSeq = 0;
function rem(
  homeTeamId: string,
  awayTeamId: string,
  bestOf = 1,
): ScenarioMatch {
  return { id: `m${++matchSeq}`, homeTeamId, awayTeamId, bestOf };
}

function completedRow(
  home: string,
  away: string,
  bestOf: number,
  winner: string | null,
): MatchLike {
  const w = Math.ceil((bestOf + 1) / 2); // bo1 → 1-0, bo2 → 2-0, bo3 → 2-0
  return {
    homeTeamId: home,
    awayTeamId: away,
    status: "COMPLETED",
    phase: "REGULAR",
    homeScore: winner === null ? 1 : winner === home ? w : 0,
    awayScore: winner === null ? 1 : winner === away ? w : 0,
    winnerTeamId: winner,
  };
}

function scheduledShim(m: ScenarioMatch): MatchLike {
  return {
    homeTeamId: m.homeTeamId,
    awayTeamId: m.awayTeamId,
    status: "SCHEDULED",
    homeScore: 0,
    awayScore: 0,
    winnerTeamId: null,
    phase: "REGULAR",
  };
}

// The classic last-night scenario, fully hand-checkable. Cut 2.
// A 9pts, B 6, C 6, D 0. Remaining: B–C (bo1), then A–D (bo1). Every match
// branches win/loss/draw (abandoned series draw for any length) → 9 leaves;
// the decisive ones: B or C winning reaches 9, a B–C draw leaves both ≤7.
function lastNight() {
  const standings = [row("A", 9), row("B", 6), row("C", 6), row("D", 0)];
  const remaining = [rem("B", "C"), rem("A", "D")];
  return { standings, remaining, cut: 2 };
}

describe("scenarioReport — hand-built 4-team league, cut 2", () => {
  it("refines a bounds-null leader to CLINCHED via head-to-head enumeration", () => {
    const { standings, remaining, cut } = lastNight();
    // Bounds alone can't clinch A: B and C could BOTH reach 9 on paper…
    expect(
      clinchStatuses(standings, remaining.map(scheduledShim), cut).get("A"),
    ).toBeNull();
    // …but they play each other, so at most one catches A (ties still safe).
    const report = scenarioReport(standings, remaining, cut);
    expect(report.exact).toBe(true);
    expect(report.teams.get("A")!.status).toBe("CLINCHED");
  });

  it("forces winAndIn false on a CLINCHED team even though a win trivially suffices", () => {
    const { standings, remaining, cut } = lastNight();
    const a = scenarioReport(standings, remaining, cut).teams.get("A")!;
    expect(a.status).toBe("CLINCHED");
    expect(a.winAndIn).toBe(false); // status carries the story
    expect(a.loseAndOut).toBe(false);
  });

  it("keeps the conservative magic number even when enumeration clinched them", () => {
    const { standings, remaining, cut } = lastNight();
    const a = scenarioReport(standings, remaining, cut).teams.get("A")!;
    // Bounds never deduct B/C's head-to-head, so A still "needs" one win.
    expect(a.magicNumber).toBe(1);
    expect(a.eliminationLosses).toBeNull(); // nobody can pass 9 banked… losing out is survivable
  });

  it("marks both sides of the B–C decider win-and-in AND lose-and-out", () => {
    const { standings, remaining, cut } = lastNight();
    const report = scenarioReport(standings, remaining, cut);
    for (const id of ["B", "C"]) {
      const s = report.teams.get(id)!;
      expect(s.status).toBeNull();
      expect(s.winAndIn).toBe(true);
      expect(s.loseAndOut).toBe(true);
      // Bounds can't promise either fate without the head-to-head context:
      expect(s.magicNumber).toBeNull();
      expect(s.eliminationLosses).toBeNull();
      expect(s.madeCount).toBe(3); // in exactly the leaves where they win (×3 A–D outcomes)
    }
  });

  it("eliminates D outright and suppresses its loseAndOut flag", () => {
    const { standings, remaining, cut } = lastNight();
    const d = scenarioReport(standings, remaining, cut).teams.get("D")!;
    expect(d.status).toBe("ELIMINATED");
    expect(d.eliminationLosses).toBe(0);
    expect(d.winAndIn).toBe(false);
    expect(d.loseAndOut).toBe(false); // already out — status carries it
    expect(d.madeCount).toBe(0);
    expect(d.bestRank).toBe(4);
    expect(d.worstRank).toBe(4);
  });

  it("counts leaves and computes exact rank ranges", () => {
    const { standings, remaining, cut } = lastNight();
    const report = scenarioReport(standings, remaining, cut);
    const a = report.teams.get("A")!;
    const b = report.teams.get("B")!;
    expect(a.leafCount).toBe(9); // two matches × (win/loss/draw)
    expect(a.madeCount).toBe(9);
    expect(a.bestRank).toBe(1);
    expect(a.worstRank).toBe(2); // B or C can tie at 9; pessimistic ties
    expect(b.bestRank).toBe(1); // beat C while A loses → tied top, optimistic
    expect(b.worstRank).toBe(3);
  });

  it("reports magicNumber 0 for a team clinched on banked points alone", () => {
    const standings = [row("A", 9), row("B", 3), row("C", 3), row("D", 3)];
    const report = scenarioReport(standings, [rem("B", "C")], 2);
    const a = report.teams.get("A")!;
    expect(a.status).toBe("CLINCHED");
    expect(a.magicNumber).toBe(0);
    expect(a.winAndIn).toBe(false); // no remaining match either
    expect(a.bestRank).toBe(1);
    expect(a.worstRank).toBe(1);
  });

  it("can prove ELIMINATED by enumeration while eliminationLosses stays null", () => {
    // D (3 pts, done) survives on bounds — but B or C MUST reach 6 in a bo1.
    const standings = [row("A", 9), row("B", 3), row("C", 3), row("D", 3)];
    const remaining = [rem("B", "C")];
    expect(
      clinchStatuses(standings, remaining.map(scheduledShim), 2).get("D"),
    ).toBeNull();
    const d = scenarioReport(standings, remaining, 2).teams.get("D")!;
    expect(d.status).toBe("ELIMINATED");
    expect(d.eliminationLosses).toBeNull(); // pure bound: can't see the forced winner
  });

  it("finds a nonzero eliminationLosses when one loss caps them below the field", () => {
    const standings = [row("A", 4), row("B", 6), row("C", 6), row("D", 0)];
    const a = scenarioReport(standings, [rem("A", "D")], 2).teams.get("A")!;
    expect(a.status).toBeNull();
    expect(a.eliminationLosses).toBe(1); // lose it → max 4, B and C sit at 6
    expect(a.winAndIn).toBe(true); // win it → 7, past both
    expect(a.loseAndOut).toBe(true);
    expect(a.magicNumber).toBe(1);
  });
});

describe("scenarioReport — draw branches (any series length)", () => {
  // T 4 pts (done), A 3, B 3, one A–B match left, cut 2. Win/loss-only would
  // keep T safe (winner 6, loser 3) — but a drawn series (a 1-1 Bo2, an
  // abandoned 1-1 Bo3, even a 0-0 forfeit) puts ALL THREE on 4 pts, and
  // pessimistic ties sink T to 3rd. recordResult permits those results for
  // every bestOf, so no series length may skip the draw branch.
  it("refuses to clinch a team a draw scenario could sink — even a Bo1/Bo3", () => {
    const standings = [row("T", 4), row("A", 3), row("B", 3)];
    for (const bestOf of [1, 2, 3]) {
      const report = scenarioReport(standings, [rem("A", "B", bestOf)], 2);
      const t = report.teams.get("T")!;
      expect(t.status).toBeNull(); // the 4-4-4 draw leaf
      expect(t.leafCount).toBe(3);
      expect(t.madeCount).toBe(2);
      expect(t.bestRank).toBe(1); // in the draw leaf nobody outpoints T
      expect(t.worstRank).toBe(3);
    }
  });

  it("treats a drawn focal series as neither the win nor the loss", () => {
    const standings = [row("T", 4), row("A", 3), row("B", 3)];
    const a = scenarioReport(standings, [rem("A", "B", 2)], 2).teams.get("A")!;
    // A: win → 6, in every such leaf; lose → 3 with B at 6 and T at 4, out.
    // The draw leaf (everyone 4) constrains neither flag.
    expect(a.status).toBeNull();
    expect(a.winAndIn).toBe(true);
    expect(a.loseAndOut).toBe(true);
  });
});

describe("scenarioReport — next-match selection and edges", () => {
  // The flags key off the FIRST remaining match in input order. Same fixture,
  // schedule order swapped: A's night reads completely differently.
  it("winAndIn/loseAndOut follow the input-order next match", () => {
    const standings = [row("A", 4), row("B", 6), row("C", 0)];
    const vsB = rem("A", "B");
    const vsC = rem("A", "C");

    const bFirst = scenarioReport(standings, [vsB, vsC], 1).teams.get("A")!;
    expect(bFirst.status).toBeNull();
    expect(bFirst.winAndIn).toBe(true); // beat B tonight → B capped at 6, A ≥ 7
    expect(bFirst.loseAndOut).toBe(true); // lose → B on 9, out of reach

    const cFirst = scenarioReport(standings, [vsC, vsB], 1).teams.get("A")!;
    expect(cFirst.status).toBeNull();
    expect(cFirst.winAndIn).toBe(false); // beating C leaves B able to reach 9
    expect(cFirst.loseAndOut).toBe(false); // A can still beat B afterwards
  });

  it("clinches everyone when the cut covers the whole league", () => {
    const standings = [row("A", 6), row("B", 3), row("C", 0)];
    const report = scenarioReport(standings, [rem("B", "C", 2)], 3);
    for (const id of ["A", "B", "C"]) {
      expect(report.teams.get(id)!.status).toBe("CLINCHED");
      expect(report.teams.get(id)!.magicNumber).toBe(0);
    }
  });

  it("ignores remaining matches referencing teams outside the standings", () => {
    const standings = [row("A", 6), row("B", 0)];
    const report = scenarioReport(standings, [rem("A", "ghost")], 1);
    expect(report.exact).toBe(true);
    const a = report.teams.get("A")!;
    expect(a.leafCount).toBe(1); // the ghost match contributed no branches
    expect(a.status).toBe("CLINCHED");
    expect(a.winAndIn).toBe(false); // no scoreable remaining match
  });

  it("echoes the cut on the report", () => {
    expect(scenarioReport([row("A", 0)], [], 1).cut).toBe(1);
  });
});

describe("scenarioReport — empty remaining schedule", () => {
  it("is exact with a single leaf reflecting the final table", () => {
    const standings = [row("A", 9), row("B", 6), row("C", 3), row("D", 0)];
    const report = scenarioReport(standings, [], 2);
    expect(report.exact).toBe(true);
    for (const [id, status, rank, made] of [
      ["A", "CLINCHED", 1, 1],
      ["B", "CLINCHED", 2, 1],
      ["C", "ELIMINATED", 3, 0],
      ["D", "ELIMINATED", 4, 0],
    ] as const) {
      const s = report.teams.get(id)!;
      expect(s.status).toBe(status);
      expect(s.leafCount).toBe(1);
      expect(s.madeCount).toBe(made);
      expect(s.bestRank).toBe(rank);
      expect(s.worstRank).toBe(rank);
      expect(s.winAndIn).toBe(false);
      expect(s.loseAndOut).toBe(false);
    }
    expect(report.teams.get("A")!.magicNumber).toBe(0);
    expect(report.teams.get("C")!.magicNumber).toBeNull();
    expect(report.teams.get("C")!.eliminationLosses).toBe(0);
  });
});

describe("scenarioReport — cap degradation", () => {
  it("falls back to clinchStatuses + bounds when the tree exceeds the cap", () => {
    const { standings, remaining, cut } = lastNight();
    const report = scenarioReport(standings, remaining, cut, { cap: 1 });
    expect(report.exact).toBe(false);

    const cs = clinchStatuses(standings, remaining.map(scheduledShim), cut);
    for (const id of ["A", "B", "C", "D"]) {
      const s = report.teams.get(id)!;
      expect(s.exact).toBe(false);
      expect(s.status).toBe(cs.get(id));
      expect(s.madeCount).toBeNull();
      expect(s.leafCount).toBeNull();
    }
    const a = report.teams.get("A")!;
    expect(a.status).toBeNull(); // no enumeration, no head-to-head insight
    expect(a.magicNumber).toBe(1); // bounds still populated
    expect(a.bestRank).toBe(1);
    expect(a.worstRank).toBe(3); // cruder than the exact 2
    const b = report.teams.get("B")!;
    expect(b.winAndIn).toBe(true); // layer-1 win-and-in sees the focal opponent
    expect(b.loseAndOut).toBe(true);
    expect(report.teams.get("D")!.status).toBe("ELIMINATED");
  });
});

// Deterministic PRNG so the property tests never flake.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomConfig(rand: () => number, tag: string) {
  const n = 3 + Math.floor(rand() * 4); // 3–6 teams
  const teamIds = Array.from({ length: n }, (_, i) => `t${i + 1}`);
  const pair = (): [string, string] => {
    const h = Math.floor(rand() * n);
    let a = Math.floor(rand() * (n - 1));
    if (a >= h) a++;
    return [teamIds[h], teamIds[a]];
  };
  const bestOfs = [1, 2, 3];
  const completed: MatchLike[] = [];
  const playedCount = Math.floor(rand() * 7);
  for (let i = 0; i < playedCount; i++) {
    const [home, away] = pair();
    const bestOf = bestOfs[Math.floor(rand() * 3)];
    const r = rand();
    let winner: string | null = r < 0.45 ? home : r < 0.9 ? away : null;
    if (winner === null && bestOf % 2 === 1) winner = home; // odd can't draw
    completed.push(completedRow(home, away, bestOf, winner));
  }
  const remaining: ScenarioMatch[] = [];
  const remainingCount = Math.floor(rand() * 5); // ≤4 matches → ≤81 leaves
  for (let i = 0; i < remainingCount; i++) {
    const [home, away] = pair();
    remaining.push({
      id: `${tag}-m${i}`,
      homeTeamId: home,
      awayTeamId: away,
      bestOf: bestOfs[Math.floor(rand() * 3)],
    });
  }
  const cut = 1 + Math.floor(rand() * (n - 1));
  return { teamIds, completed, remaining, cut };
}

function forEachLeaf(
  remaining: ScenarioMatch[],
  cb: (outcomes: number[]) => void,
) {
  // Every match branches win/loss/draw — the engine enumerates a draw for any
  // series length, since recordResult accepts drawn scores regardless of bestOf.
  const radix = remaining.map(() => 3);
  const total = radix.reduce((acc, r) => acc * r, 1);
  for (let leaf = 0; leaf < total; leaf++) {
    let x = leaf;
    const outcomes = radix.map((r) => {
      const o = x % r;
      x = Math.floor(x / r);
      return o; // 0 home win, 1 away win, 2 draw
    });
    cb(outcomes);
  }
}

describe("scenarioReport — property tests (seeded random leagues)", () => {
  it("every claim holds in every enumerated leaf, and counts/ranks are exact", () => {
    const rand = mulberry32(0x1d2c2026);
    // Guard against a vacuously-passing property: the seed must actually
    // exercise every interesting claim at least once.
    const seen = { clinched: 0, eliminated: 0, open: 0, winAndIn: 0, loseAndOut: 0, draws: 0 };
    for (let iter = 0; iter < 40; iter++) {
      const { teamIds, completed, remaining, cut } = randomConfig(
        rand,
        `p${iter}`,
      );
      const standings = computeStandings(teamIds, completed);
      const report = scenarioReport(standings, remaining, cut);
      expect(report.exact).toBe(true);

      // Focal (next) match per team, in input order — mirrors the engine.
      const focal = new Map<string, number>();
      remaining.forEach((m, i) => {
        if (!focal.has(m.homeTeamId)) focal.set(m.homeTeamId, i);
        if (!focal.has(m.awayTeamId)) focal.set(m.awayTeamId, i);
      });

      const made = new Map(teamIds.map((id) => [id, 0]));
      const out = new Map(teamIds.map((id) => [id, 0]));
      const best = new Map(teamIds.map((id) => [id, Infinity]));
      const worst = new Map(teamIds.map((id) => [id, 0]));
      let leaves = 0;

      // Re-derive every leaf from scratch: play the remaining matches as
      // COMPLETED rows and let computeStandings do the scoring.
      forEachLeaf(remaining, (outcomes) => {
        leaves++;
        const played = remaining.map((m, i) =>
          completedRow(
            m.homeTeamId,
            m.awayTeamId,
            m.bestOf,
            outcomes[i] === 0
              ? m.homeTeamId
              : outcomes[i] === 1
                ? m.awayTeamId
                : null,
          ),
        );
        const table = computeStandings(teamIds, [...completed, ...played]);
        const pts = new Map(table.map((r) => [r.teamId, r.points]));
        for (const id of teamIds) {
          const p = pts.get(id)!;
          let ge = 0;
          let gt = 0;
          for (const o of teamIds) {
            if (o === id) continue;
            if (pts.get(o)! > p) {
              gt++;
              ge++;
            } else if (pts.get(o)! === p) ge++;
          }
          const definitelyIn = ge <= cut - 1; // top-cut, ties against
          const definitelyOut = gt >= cut; // missed, ties for
          if (definitelyIn) made.set(id, made.get(id)! + 1);
          if (definitelyOut) out.set(id, out.get(id)! + 1);
          best.set(id, Math.min(best.get(id)!, 1 + gt));
          worst.set(id, Math.max(worst.get(id)!, 1 + ge));

          const s = report.teams.get(id)!;
          if (s.status === "CLINCHED") expect(definitelyIn).toBe(true);
          if (s.status === "ELIMINATED") expect(definitelyOut).toBe(true);
          const f = focal.get(id);
          if (f !== undefined) {
            const won =
              outcomes[f] === (remaining[f].homeTeamId === id ? 0 : 1);
            const lost =
              outcomes[f] === (remaining[f].homeTeamId === id ? 1 : 0);
            if (s.winAndIn && won) expect(definitelyIn).toBe(true);
            if (s.loseAndOut && lost) expect(definitelyOut).toBe(true);
          }
        }
      });

      for (const id of teamIds) {
        const s = report.teams.get(id)!;
        expect(s.leafCount).toBe(leaves);
        expect(s.madeCount).toBe(made.get(id));
        expect(s.bestRank).toBe(best.get(id));
        expect(s.worstRank).toBe(worst.get(id));
        expect(s.bestRank).toBeLessThanOrEqual(s.worstRank);
        const derived =
          made.get(id) === leaves
            ? "CLINCHED"
            : out.get(id) === leaves
              ? "ELIMINATED"
              : null;
        expect(s.status).toBe(derived);
        if (s.status === "CLINCHED") seen.clinched++;
        else if (s.status === "ELIMINATED") seen.eliminated++;
        else seen.open++;
        if (s.winAndIn) seen.winAndIn++;
        if (s.loseAndOut) seen.loseAndOut++;
      }
      if (remaining.length > 0) seen.draws++;
    }
    for (const count of Object.values(seen)) {
      expect(count).toBeGreaterThan(0);
    }
  });

  it("never contradicts a non-null clinchStatuses, exact or capped (50 configs)", () => {
    const rand = mulberry32(987654321);
    for (let iter = 0; iter < 50; iter++) {
      const { teamIds, completed, remaining, cut } = randomConfig(
        rand,
        `c${iter}`,
      );
      const standings = computeStandings(teamIds, completed);
      const cs = clinchStatuses(standings, remaining.map(scheduledShim), cut);
      for (const report of [
        scenarioReport(standings, remaining, cut),
        scenarioReport(standings, remaining, cut, { cap: 1 }),
      ]) {
        for (const id of teamIds) {
          const bound = cs.get(id);
          if (bound) expect(report.teams.get(id)!.status).toBe(bound);
        }
      }
    }
  });
});

// ---- matchStakes / stakesHeadline ----

function scen(teamId: string, over: Partial<TeamScenario>): TeamScenario {
  return {
    teamId,
    status: null,
    winAndIn: false,
    loseAndOut: false,
    magicNumber: null,
    eliminationLosses: null,
    bestRank: 1,
    worstRank: 4,
    exact: true,
    madeCount: 0,
    leafCount: 1,
    nextMatchId: "focal",
    ...over,
  };
}

function reportOf(...scens: TeamScenario[]): ScenarioReport {
  return { cut: 2, exact: true, teams: new Map(scens.map((s) => [s.teamId, s])) };
}

describe("matchStakes", () => {
  it("labels a real decider everything-on-the-line for both sides", () => {
    const { standings, remaining, cut } = lastNight();
    const report = scenarioReport(standings, remaining, cut);
    expect(matchStakes(remaining[0].id, "B", "C", report)).toEqual([
      { teamId: "B", label: "Everything on the line: win and in, lose and out" },
      { teamId: "C", label: "Everything on the line: win and in, lose and out" },
    ]);
  });

  it("labels the dead rubber locked vs playing-for-pride", () => {
    const { standings, remaining, cut } = lastNight();
    const report = scenarioReport(standings, remaining, cut);
    expect(matchStakes(remaining[1].id, "A", "D", report)).toEqual([
      { teamId: "A", label: "Playoff spot locked — playing for seeding" },
      { teamId: "D", label: "Out of the race — playing for pride" },
    ]);
  });

  it("status outranks the flags", () => {
    const report = reportOf(
      scen("A", { status: "CLINCHED", winAndIn: true, loseAndOut: true }),
      scen("B", { status: "ELIMINATED", loseAndOut: true, magicNumber: 1 }),
    );
    expect(matchStakes("focal", "A", "B", report).map((s) => s.label)).toEqual([
      "Playoff spot locked — playing for seeding",
      "Out of the race — playing for pride",
    ]);
  });

  it("picks win-and-in, lose-and-out, magic-1, and hunt in that priority", () => {
    const report = reportOf(
      scen("W", { winAndIn: true, magicNumber: 1 }),
      scen("L", { loseAndOut: true, magicNumber: 1 }),
      scen("M", { magicNumber: 1 }),
      scen("H", { magicNumber: 2 }),
    );
    expect(matchStakes("focal", "W", "L", report).map((s) => s.label)).toEqual([
      "Win and they're in",
      "Lose and they're out",
    ]);
    expect(matchStakes("focal", "M", "H", report).map((s) => s.label)).toEqual([
      "One more win locks a playoff spot",
      "In the hunt for a playoff spot",
    ]);
  });

  it("suppresses next-match guarantees on a match that is NOT the team's next", () => {
    // A team's winAndIn belongs to its next match only: on a later match's
    // page the label must fall through to the match-independent facts.
    const report = reportOf(
      scen("W", { winAndIn: true, loseAndOut: true, nextMatchId: "week5" }),
      scen("M", { winAndIn: true, magicNumber: 1, nextMatchId: "week5" }),
    );
    expect(matchStakes("week7", "W", "M", report).map((s) => s.label)).toEqual([
      "In the hunt for a playoff spot",
      "One more win locks a playoff spot",
    ]);
    // …and on the actual next match, the guarantee shows.
    expect(matchStakes("week5", "W", "M", report).map((s) => s.label)).toEqual([
      "Everything on the line: win and in, lose and out",
      "Win and they're in",
    ]);
  });

  it("skips teams missing from the report", () => {
    const report = reportOf(scen("A", { magicNumber: 3 }));
    expect(matchStakes("focal", "A", "ghost", report)).toEqual([
      { teamId: "A", label: "In the hunt for a playoff spot" },
    ]);
  });
});

describe("stakesHeadline", () => {
  const all = "Everything on the line: win and in, lose and out";
  const winIn = "Win and they're in";
  const loseOut = "Lose and they're out";
  const oneMore = "One more win locks a playoff spot";

  it("is null with no stakes or only calm labels", () => {
    expect(stakesHeadline([])).toBeNull();
    expect(
      stakesHeadline([
        { teamId: "A", label: "Playoff spot locked — playing for seeding" },
        { teamId: "B", label: "Out of the race — playing for pride" },
      ]),
    ).toBeNull();
    expect(
      stakesHeadline([
        { teamId: "A", label: "In the hunt for a playoff spot" },
      ]),
    ).toBeNull();
  });

  it("returns the most dramatic line present", () => {
    expect(
      stakesHeadline([
        { teamId: "A", label: winIn },
        { teamId: "B", label: all },
      ]),
    ).toBe(all);
    expect(
      stakesHeadline([
        { teamId: "A", label: oneMore },
        { teamId: "B", label: loseOut },
      ]),
    ).toBe(loseOut);
    expect(
      stakesHeadline([
        { teamId: "A", label: "In the hunt for a playoff spot" },
        { teamId: "B", label: winIn },
      ]),
    ).toBe(winIn);
    expect(stakesHeadline([{ teamId: "A", label: oneMore }])).toBe(oneMore);
  });
});
