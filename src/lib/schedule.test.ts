import { describe, it, expect } from "vitest";
import {
  roundRobin,
  byeTeamsByWeek,
  remainingSchedule,
  seedOrder,
  playoffFirstRound,
  pickBracketSize,
  bracketRounds,
  roundName,
  nextRoundPairings,
  slotRound,
  slotIndex,
  bracketSkeleton,
  groupPlayoffRounds,
  matchNightForWeek,
} from "./schedule";

describe("matchNightForWeek", () => {
  const first = new Date("2026-07-12T18:00:00-07:00");

  it("returns the first night for week 1", () => {
    expect(matchNightForWeek(first, 1).getTime()).toBe(first.getTime());
  });

  it("adds exactly 7 days per week", () => {
    const w3 = matchNightForWeek(first, 3);
    expect(w3.getTime() - first.getTime()).toBe(14 * 24 * 3600 * 1000);
  });
});

describe("roundRobin", () => {
  it("has every team play every other exactly once (4 teams)", () => {
    const rounds = roundRobin(["a", "b", "c", "d"]);
    expect(rounds).toHaveLength(3);
    rounds.forEach((r) => expect(r).toHaveLength(2));

    const pairs = new Set(
      rounds.flat().map((p) => [p.home, p.away].sort().join("-")),
    );
    expect(pairs.size).toBe(6); // C(4,2)
  });

  it("handles an odd number of teams with a bye", () => {
    const rounds = roundRobin(["a", "b", "c"]);
    expect(rounds).toHaveLength(3);
    expect(rounds.flat()).toHaveLength(3); // C(3,2), one team rests each round
  });

  it("doubles the fixtures for a double round-robin", () => {
    expect(roundRobin(["a", "b", "c", "d"], true).flat()).toHaveLength(12);
  });

  it("returns nothing for fewer than two teams", () => {
    expect(roundRobin(["a"])).toEqual([]);
    expect(roundRobin([])).toEqual([]);
  });
});

describe("roundRobin home/away balance", () => {
  for (const n of [3, 4, 5, 6, 7, 8, 10]) {
    it(`keeps each team's home vs away within 1 for ${n} teams`, () => {
      const teams = Array.from({ length: n }, (_, i) => `t${i}`);
      const rounds = roundRobin(teams);
      const home = new Map(teams.map((t) => [t, 0]));
      const away = new Map(teams.map((t) => [t, 0]));
      for (const r of rounds)
        for (const p of r) {
          home.set(p.home, (home.get(p.home) ?? 0) + 1);
          away.set(p.away, (away.get(p.away) ?? 0) + 1);
        }
      for (const t of teams) {
        expect(
          Math.abs((home.get(t) ?? 0) - (away.get(t) ?? 0)),
          `${t} has ${home.get(t)}H / ${away.get(t)}A`,
        ).toBeLessThanOrEqual(1);
      }
    });
  }
});

describe("seedOrder", () => {
  it("produces standard bracket ordering", () => {
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
});

describe("playoffFirstRound", () => {
  it("pairs top vs bottom seeds", () => {
    const p = playoffFirstRound(["t1", "t2", "t3", "t4"], 4);
    expect(p).toEqual([
      { home: "t1", away: "t4" },
      { home: "t2", away: "t3" },
    ]);
  });
});

describe("pickBracketSize", () => {
  it("picks the largest power of two that fits", () => {
    expect(pickBracketSize(2)).toBe(2);
    expect(pickBracketSize(3)).toBe(2);
    expect(pickBracketSize(4)).toBe(4);
    expect(pickBracketSize(5)).toBe(4);
    expect(pickBracketSize(8)).toBe(8);
    expect(pickBracketSize(9)).toBe(8);
  });
});

describe("bracketRounds", () => {
  it("counts single-elimination rounds", () => {
    expect(bracketRounds(2)).toBe(1);
    expect(bracketRounds(4)).toBe(2);
    expect(bracketRounds(8)).toBe(3);
  });
});

describe("roundName", () => {
  it("names rounds relative to the final", () => {
    expect(roundName(1, 2)).toBe("Final");
    expect(roundName(0, 2)).toBe("Semifinals");
    expect(roundName(0, 3)).toBe("Quarterfinals");
    expect(roundName(2, 3)).toBe("Final");
  });
});

describe("nextRoundPairings", () => {
  it("pairs winners in bracket order", () => {
    expect(nextRoundPairings(["a", "b", "c", "d"])).toEqual([
      { home: "a", away: "b" },
      { home: "c", away: "d" },
    ]);
  });
});

describe("slotRound", () => {
  it("reads the round index from a bracket slot", () => {
    expect(slotRound("R0M1")).toBe(0);
    expect(slotRound("R2M3")).toBe(2);
    expect(slotRound(null)).toBe(0);
    expect(slotRound("weird")).toBe(0);
  });
});

describe("groupPlayoffRounds", () => {
  it("groups a 4-team bracket into ordered rounds and reports total rounds", () => {
    const matches = [
      { bracketSlot: "R0M1" },
      { bracketSlot: "R0M0" },
      { bracketSlot: "R1M0" }, // final
    ];
    const { totalRounds, rounds } = groupPlayoffRounds(matches);
    expect(totalRounds).toBe(2); // 2 first-round matches -> 4-team bracket
    expect(rounds.map((r) => r.round)).toEqual([0, 1]);
    // round 0 matches sorted by slot
    expect(rounds[0].matches.map((m) => m.bracketSlot)).toEqual([
      "R0M0",
      "R0M1",
    ]);
    expect(rounds[1].matches).toHaveLength(1);
  });

  it("returns empty when there are no playoff matches", () => {
    expect(groupPlayoffRounds([])).toEqual({ totalRounds: 0, rounds: [] });
  });
});

describe("slotIndex", () => {
  it("reads the match index from a bracket slot", () => {
    expect(slotIndex("R0M1")).toBe(1);
    expect(slotIndex("R2M12")).toBe(12);
    expect(slotIndex(null)).toBeNull();
    expect(slotIndex("weird")).toBeNull();
  });
});

describe("bracketSkeleton", () => {
  it("builds every round with TBD slots for matches that don't exist yet", () => {
    // 8-team bracket, only the first round created so far.
    const matches = [
      { bracketSlot: "R0M2" },
      { bracketSlot: "R0M0" },
      { bracketSlot: "R0M1" },
      { bracketSlot: "R0M3" },
    ];
    const { totalRounds, rounds } = bracketSkeleton(matches);
    expect(totalRounds).toBe(3);
    expect(rounds.map((r) => r.slots.length)).toEqual([4, 2, 1]);
    expect(rounds[0].slots.map((m) => m?.bracketSlot)).toEqual([
      "R0M0",
      "R0M1",
      "R0M2",
      "R0M3",
    ]);
    expect(rounds[1].slots).toEqual([null, null]);
    expect(rounds[2].slots).toEqual([null]);
  });

  it("places created later rounds into their slots", () => {
    const matches = [
      { bracketSlot: "R0M0" },
      { bracketSlot: "R0M1" },
      { bracketSlot: "R1M0" },
    ];
    const { totalRounds, rounds } = bracketSkeleton(matches);
    expect(totalRounds).toBe(2);
    expect(rounds[1].slots[0]?.bracketSlot).toBe("R1M0");
  });

  it("fills slotless legacy matches in order", () => {
    const matches = [{ bracketSlot: null }, { bracketSlot: null }];
    const { rounds } = bracketSkeleton(matches);
    expect(rounds[0].slots).toEqual(matches);
  });

  it("returns empty when there are no playoff matches", () => {
    expect(bracketSkeleton([])).toEqual({ totalRounds: 0, rounds: [] });
  });
});

describe("byeTeamsByWeek", () => {
  const m = (week: number, home: string, away: string, phase = "REGULAR") => ({
    week,
    homeTeamId: home,
    awayTeamId: away,
    phase,
  });

  it("rotates the bye through a 5-team round robin", () => {
    const teams = ["a", "b", "c", "d", "e"];
    const rounds = roundRobin(teams);
    const matches = rounds.flatMap((round, i) =>
      round.map((p) => m(i + 1, p.home, p.away)),
    );
    const byes = byeTeamsByWeek(matches, teams);
    expect(byes.size).toBe(5); // 5 weeks
    const all = [...byes.values()].flat();
    expect(all).toHaveLength(5); // exactly one bye per week
    expect([...new Set(all)].sort()).toEqual(teams); // everyone rests once
  });

  it("reports no byes with an even team count", () => {
    const byes = byeTeamsByWeek(
      [m(1, "a", "b"), m(1, "c", "d")],
      ["a", "b", "c", "d"],
    );
    expect(byes.get(1)).toEqual([]);
  });

  it("ignores playoff matches", () => {
    const byes = byeTeamsByWeek([m(9, "a", "b", "PLAYOFF")], ["a", "b", "c"]);
    expect(byes.size).toBe(0);
  });
});

describe("remainingSchedule", () => {
  const m = (
    week: number,
    home: string,
    away: string,
    status = "SCHEDULED",
    phase = "REGULAR",
  ) => ({ week, homeTeamId: home, awayTeamId: away, status, phase });

  it("lists unplayed opponents in week order for both sides", () => {
    const rem = remainingSchedule(
      ["a", "b", "c", "d"],
      [
        m(1, "a", "b", "COMPLETED"),
        m(3, "c", "a"),
        m(2, "a", "d"),
        m(2, "b", "c"),
      ],
    );
    expect(rem.get("a")).toEqual([
      { week: 2, opponentId: "d" },
      { week: 3, opponentId: "c" },
    ]);
    expect(rem.get("c")).toEqual([
      { week: 2, opponentId: "b" },
      { week: 3, opponentId: "a" },
    ]);
    expect(rem.get("d")).toEqual([{ week: 2, opponentId: "a" }]);
  });

  it("ignores completed and playoff matches", () => {
    const rem = remainingSchedule(
      ["a", "b"],
      [m(1, "a", "b", "COMPLETED"), m(9, "a", "b", "SCHEDULED", "PLAYOFF")],
    );
    expect(rem.get("a")).toEqual([]);
    expect(rem.get("b")).toEqual([]);
  });
});
