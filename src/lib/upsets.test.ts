import { describe, expect, it } from "vitest";
import {
  UPSET_MIN_POINTS_GAP,
  UPSET_MIN_PRIOR_WEEKS,
  biggestUpset,
  seriesUpset,
  upsetContext,
  type UpsetMatch,
} from "./upsets";

const TEAMS = ["a", "b", "c", "d", "e", "f"];

let nextId = 0;
/** A series result: `hs`-`as`, the winner derived from the score. */
function series(
  week: number,
  home: string,
  away: string,
  hs: number,
  as: number,
  extra: Partial<UpsetMatch> = {},
): UpsetMatch {
  nextId += 1;
  return {
    id: `m${String(nextId).padStart(3, "0")}`,
    week,
    phase: "REGULAR",
    status: "COMPLETED",
    homeTeamId: home,
    awayTeamId: away,
    homeScore: hs,
    awayScore: as,
    winnerTeamId: hs > as ? home : as > hs ? away : null,
    ...extra,
  };
}

const judge = (matches: UpsetMatch[], match: UpsetMatch) =>
  seriesUpset(match, upsetContext(TEAMS, [...matches, match]));

/**
 * Two weeks in which a wins both, b wins one, and f loses both:
 * a 6, b 3, c 3, d 3, e 3, f 0 going into week 3.
 */
const twoWeeks = () => [
  series(1, "a", "b", 2, 0),
  series(1, "c", "d", 2, 0),
  series(1, "e", "f", 2, 0),
  series(2, "a", "c", 2, 0),
  series(2, "b", "f", 2, 0),
  series(2, "d", "e", 2, 0),
];

describe("the rule's numbers", () => {
  it("asks for a full win of points and two earlier weeks", () => {
    expect(UPSET_MIN_POINTS_GAP).toBe(3);
    expect(UPSET_MIN_PRIOR_WEEKS).toBe(2);
  });
});

describe("seriesUpset in the regular season", () => {
  it("tags a winner a full win behind going into the week", () => {
    const upset = judge(twoWeeks(), series(3, "a", "f", 0, 2));
    expect(upset).toMatchObject({
      kind: "points",
      winnerId: "f",
      loserId: "a",
      winner: 0,
      loser: 6,
      gap: 6,
    });
  });

  it("tags nothing in weeks 1 and 2, whatever the scores", () => {
    const week1 = [series(1, "a", "b", 2, 0), series(1, "c", "d", 2, 0)];
    // Week 2: d (0 points) beats a (3 points), a three-point gap, but the
    // table behind it is one night's results.
    expect(judge(week1, series(2, "d", "a", 2, 0))).toBeNull();
    expect(judge([], series(1, "a", "b", 0, 2))).toBeNull();
  });

  it("needs two earlier WEEKS with results, not two earlier week numbers", () => {
    // Week 1 was never played; weeks 2 and 3 have one result each, so a
    // week-3 surprise has only one week behind it and a week-4 one has two.
    const played = [series(2, "a", "f", 2, 0), series(3, "a", "e", 2, 0)];
    expect(judge(played.slice(0, 1), series(3, "f", "a", 2, 0))).toBeNull();
    expect(judge(played, series(4, "f", "a", 2, 0))).toMatchObject({
      winnerId: "f",
      gap: 6,
    });
  });

  it("splits a gap of 2 from a gap of 3", () => {
    // Going into week 3: a 4 (win, draw), b 1 (draw, loss), f 1 (draw, loss).
    const weeks = [
      series(1, "a", "c", 2, 0),
      series(1, "b", "f", 1, 1),
      series(2, "a", "d", 1, 1),
      series(2, "b", "e", 0, 2),
      series(2, "f", "c", 0, 2),
    ];
    // b trailed a by 3: an upset.
    expect(judge(weeks, series(3, "b", "a", 2, 0))).toMatchObject({
      winnerId: "b",
      gap: 3,
    });
    // c (3) beating a (4) is a gap of 1; e (3) over d (1) is the favourite.
    expect(judge(weeks, series(3, "c", "a", 2, 0))).toBeNull();
    expect(judge(weeks, series(3, "d", "e", 0, 2))).toBeNull();
    // Gap of 2: c (3) loses to b (1) — level in all but one draw.
    expect(judge(weeks, series(3, "c", "b", 0, 2))).toBeNull();
  });

  it("never calls level points an upset, even when team id split the places", () => {
    // b and c both have 3 points after two weeks; the table puts b first on
    // the id fallback alone, and c beating b says nothing about form.
    const weeks = [
      series(1, "b", "e", 2, 0),
      series(1, "c", "f", 2, 0),
      series(2, "b", "a", 0, 2),
      series(2, "c", "d", 0, 2),
    ];
    expect(judge(weeks, series(3, "b", "c", 0, 2))).toBeNull();
  });

  it("never tags a draw, a forfeit or a series still being played", () => {
    expect(judge(twoWeeks(), series(3, "a", "f", 1, 1))).toBeNull();
    expect(
      judge(twoWeeks(), series(3, "a", "f", 0, 2, { forfeit: true })),
    ).toBeNull();
    expect(
      judge(
        twoWeeks(),
        series(3, "a", "f", 0, 1, { status: "LIVE", winnerTeamId: null }),
      ),
    ).toBeNull();
    // A stray winner id that is neither side is not a result.
    expect(
      judge(twoWeeks(), series(3, "a", "f", 0, 2, { winnerTeamId: "zz" })),
    ).toBeNull();
  });

  it("judges a postponed fixture against the table going into its own week", () => {
    // The week-3 meeting of a and f is played after week 4. Week 4 gave a
    // another win and f its first, but only weeks 1-2 count for week 3.
    const late = series(3, "f", "a", 2, 0);
    const matches = [
      ...twoWeeks(),
      series(4, "a", "e", 2, 0),
      series(4, "f", "b", 2, 0),
    ];
    expect(judge(matches, late)).toMatchObject({ winner: 0, loser: 6, gap: 6 });
  });

  it("treats a team missing from the table as unknown, never as zero", () => {
    expect(
      seriesUpset(
        series(3, "a", "ghost", 0, 2),
        upsetContext(TEAMS, twoWeeks()),
      ),
    ).toBeNull();
  });

  it("ignores playoff and tiebreaker results when building the table", () => {
    const withPostseason = [
      ...twoWeeks(),
      series(2, "f", "a", 2, 0, { phase: "TIEBREAKER" }),
      series(2, "f", "a", 2, 0, { phase: "PLAYOFF", bracketSlot: "R0M0" }),
    ];
    expect(judge(withPostseason, series(3, "a", "f", 0, 2))).toMatchObject({
      winner: 0,
      loser: 6,
    });
  });
});

describe("seriesUpset in the playoffs", () => {
  // Four-team bracket: R0M0 is seed 1 vs 4, R0M1 seed 2 vs 3.
  const bracket = (r0m0Winner: string, r0m1Winner: string) => [
    series(6, "a", "d", ...(r0m0Winner === "a" ? [2, 0] : [0, 2]) as [number, number], {
      phase: "PLAYOFF",
      bracketSlot: "R0M0",
    }),
    series(6, "b", "c", ...(r0m1Winner === "b" ? [2, 1] : [1, 2]) as [number, number], {
      phase: "PLAYOFF",
      bracketSlot: "R0M1",
    }),
  ];

  it("tags the higher seed number beating the lower one", () => {
    const matches = bracket("d", "b");
    const context = upsetContext(TEAMS, matches);
    expect(seriesUpset(matches[0], context)).toMatchObject({
      kind: "seed",
      winnerId: "d",
      loserId: "a",
      winner: 4,
      loser: 1,
      gap: 3,
    });
    expect(seriesUpset(matches[1], context)).toBeNull();
  });

  it("judges the final by the same frozen seeds", () => {
    const matches = [
      ...bracket("a", "c"),
      series(7, "a", "c", 1, 2, { phase: "FINAL", bracketSlot: "R1M0" }),
    ];
    expect(
      seriesUpset(matches[2], upsetContext(TEAMS, matches)),
    ).toMatchObject({ winnerId: "c", winner: 3, loser: 1, gap: 2 });
  });

  it("reads seeds from the bracket alone, never a tiebreaker's slot", () => {
    // A tiebreaker for the last place carries slot "TB1", which the slot
    // parser reads as round 0, the same round as the bracket's first.
    const matches = [
      series(5, "e", "f", 2, 0, { phase: "TIEBREAKER", bracketSlot: "TB1" }),
      ...bracket("d", "b"),
    ];
    expect(seriesUpset(matches[1], upsetContext(TEAMS, matches))).toMatchObject({
      winner: 4,
      loser: 1,
      gap: 3,
    });
  });

  it("gives no tag when a side has no seed", () => {
    // e never played the first round (a bye, or an admin-built fixture).
    const matches = [
      ...bracket("a", "b"),
      series(7, "a", "e", 0, 2, { phase: "PLAYOFF", bracketSlot: "R1M0" }),
    ];
    expect(seriesUpset(matches[2], upsetContext(TEAMS, matches))).toBeNull();
  });

  it("never tags a tiebreaker, even one the seeds or table would call an upset", () => {
    // A tiebreaker is a playoff for a place, not a bracket series: c (seed
    // 3) beating b (seed 2) in one is no upset.
    const seeded = [
      ...bracket("a", "b"),
      series(5, "b", "c", 1, 2, { phase: "TIEBREAKER", bracketSlot: "TB1" }),
    ];
    expect(seriesUpset(seeded[2], upsetContext(TEAMS, seeded))).toBeNull();
    // Nor is f (0 points) beating a (6 points) in one.
    const tabled = [
      ...twoWeeks(),
      series(3, "a", "f", 0, 2, { phase: "TIEBREAKER", bracketSlot: "TB1" }),
    ];
    expect(seriesUpset(tabled[6], upsetContext(TEAMS, tabled))).toBeNull();
  });
});

describe("biggestUpset", () => {
  it("picks the largest gap in the latest week with a completed series", () => {
    const matches = [
      ...twoWeeks(),
      series(3, "a", "f", 0, 2), // f over a: 6 points
      series(3, "b", "e", 0, 2), // level: none
      series(3, "c", "d", 2, 0), // level: none
    ];
    expect(biggestUpset(matches, upsetContext(TEAMS, matches))).toMatchObject({
      match: { id: matches[6].id },
      upset: { winnerId: "f", gap: 6 },
    });
  });

  it("breaks an equal gap on the lowest match id", () => {
    const weeks = [
      series(1, "a", "e", 2, 0),
      series(1, "b", "f", 2, 0),
      series(2, "a", "c", 2, 0),
      series(2, "b", "d", 2, 0),
    ];
    // e and f (0 points) both beat a 6-point team in week 3.
    const later = { ...series(3, "a", "e", 0, 2), id: "m-z" };
    const earlier = { ...series(3, "b", "f", 0, 2), id: "m-a" };
    for (const order of [
      [later, earlier],
      [earlier, later],
    ]) {
      const matches = [...weeks, ...order];
      expect(
        biggestUpset(matches, upsetContext(TEAMS, matches))?.match.id,
      ).toBe("m-a");
    }
  });

  it("is null when the latest week had no upset, never an older week's", () => {
    const matches = [
      ...twoWeeks(),
      series(3, "a", "f", 0, 2), // an upset in week 3
      series(4, "a", "e", 2, 0), // week 4 goes to form
    ];
    expect(biggestUpset(matches, upsetContext(TEAMS, matches))).toBeNull();
  });

  it("waits for a completed series in the week, ignoring live ones", () => {
    const matches = [
      ...twoWeeks(),
      series(3, "a", "f", 0, 2),
      series(4, "a", "e", 0, 1, { status: "LIVE", winnerTeamId: null }),
    ];
    expect(
      biggestUpset(matches, upsetContext(TEAMS, matches))?.upset.winnerId,
    ).toBe("f");
    expect(biggestUpset([], upsetContext(TEAMS, []))).toBeNull();
  });

  it("names the playoff round's biggest seed upset", () => {
    const matches = [
      ...twoWeeks(),
      series(6, "a", "d", 0, 2, { phase: "PLAYOFF", bracketSlot: "R0M0" }),
      series(6, "b", "c", 1, 2, { phase: "PLAYOFF", bracketSlot: "R0M1" }),
    ];
    expect(biggestUpset(matches, upsetContext(TEAMS, matches))).toMatchObject({
      upset: { kind: "seed", winnerId: "d", gap: 3 },
    });
  });
});
