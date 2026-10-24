import { describe, expect, it } from "vitest";
import {
  buildSeasonFormat,
  describeSeasonFormat,
  drawGroups,
  firstPlayoffWeek,
  formatName,
  formatSteps,
  formatBracketSize,
  parseFormatConfig,
  plannedSeasonFormat,
  playoffEntrantsPhrase,
  playoffSteps,
  playoffBracketSize,
  recommendedKnobs,
  regularSeasonFixtures,
  resolveSeasonFormat,
  rosterAverageMmr,
  seasonBracketSize,
  seasonFormat,
  seasonGroupKeys,
  serializeFormatConfig,
  seasonLengthPhrase,
  seasonPlan,
  seedGroups,
  teamCountSeasonNote,
} from "./season-format";
import { playoffFirstRound } from "./schedule";

/** A season that stores no format: it plays the Recommended one. */
const RECOMMENDED = { formatConfig: null };

describe("seasonFormat", () => {
  // Tim's table (2026-10-19): one table up to nine teams, two groups from ten,
  // a reserved tiebreaker week, then the playoffs.
  const expected: Record<number, [string, number[], boolean, number, [number, number], number, number]> = {
    //    kind      groups   double weeks matches  spots total
    2: ["TABLE", [2], true, 2, [2, 2], 2, 4],
    3: ["TABLE", [3], true, 6, [4, 4], 2, 8],
    4: ["TABLE", [4], true, 6, [6, 6], 4, 9],
    5: ["TABLE", [5], false, 5, [4, 4], 4, 8],
    6: ["TABLE", [6], false, 5, [5, 5], 4, 8],
    7: ["TABLE", [7], false, 7, [6, 6], 4, 10],
    8: ["TABLE", [8], false, 7, [7, 7], 4, 10],
    9: ["TABLE", [9], false, 9, [8, 8], 4, 12],
    10: ["GROUPS", [5, 5], false, 5, [4, 4], 8, 9],
    11: ["GROUPS", [6, 5], false, 5, [4, 5], 8, 9],
    12: ["GROUPS", [6, 6], false, 5, [5, 5], 8, 9],
    13: ["GROUPS", [7, 6], false, 7, [5, 6], 8, 11],
    14: ["GROUPS", [7, 7], false, 7, [6, 6], 8, 11],
    15: ["GROUPS", [8, 7], false, 7, [6, 7], 8, 11],
    16: ["GROUPS", [8, 8], false, 7, [7, 7], 8, 11],
    17: ["GROUPS", [9, 8], false, 9, [7, 8], 8, 13],
  };

  for (const [count, [kind, groups, double, weeks, [min, max], spots, total]] of Object.entries(expected)) {
    it(`${count} teams: ${kind} ${groups.join("+")}, ${weeks} weeks, top ${spots}, ${total} weeks in all`, () => {
      const format = seasonFormat(Number(count))!;
      expect(format.kind).toBe(kind);
      expect(format.groupSizes).toEqual(groups);
      expect(format.doubleRound).toBe(double);
      expect(format.regularWeeks).toBe(weeks);
      expect(format.matchesPerTeam).toEqual({ min, max });
      expect(format.playoffSpots).toBe(spots);
      expect(format.qualifiersPerGroup * groups.length).toBe(spots);
      expect(format.tiebreakerWeek).toBe(weeks + 1);
      expect(format.firstPlayoffWeek).toBe(weeks + 2);
      expect(format.totalWeeks).toBe(total);
      expect(format.totalWeeks).toBe(weeks + 1 + format.playoffRounds);
    });
  }

  it("has no format below two teams", () => {
    expect(seasonFormat(0)).toBeNull();
    expect(seasonFormat(1)).toBeNull();
    expect(seasonFormat(2.5)).toBeNull();
  });

  it("someone always misses the playoffs from five teams up", () => {
    for (let count = 5; count <= 20; count++) {
      expect(seasonFormat(count)!.playoffSpots).toBeLessThan(count);
    }
  });
});

describe("the fixtures match the format", () => {
  for (let count = 2; count <= 17; count++) {
    it(`${count} teams`, () => {
      const format = seasonFormat(count)!;
      const teams = Array.from({ length: count }, (_, i) => ({
        id: `t${String(i).padStart(2, "0")}`,
        averageMmr: 3000 + i * 37,
      }));
      const groups = format.kind === "GROUPS" ? drawGroups(teams) : [teams.map((t) => t.id)];
      expect(groups.map((g) => g.length).sort((a, b) => b - a)).toEqual(format.groupSizes);
      const fixtures = regularSeasonFixtures(groups, format.doubleRound);

      expect(Math.max(...fixtures.map((f) => f.week))).toBe(format.regularWeeks);
      for (const group of groups) {
        const mine = fixtures.filter((f) => group.includes(f.home));
        // Every group starts in week 1 and finishes in the last week.
        expect(Math.min(...mine.map((f) => f.week))).toBe(1);
        expect(Math.max(...mine.map((f) => f.week))).toBe(format.regularWeeks);
        // Everyone in the group meets everyone else (twice for a double).
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const meetings = mine.filter(
              (f) =>
                (f.home === group[i] && f.away === group[j]) ||
                (f.home === group[j] && f.away === group[i]),
            );
            expect(meetings).toHaveLength(format.doubleRound ? 2 : 1);
          }
        }
      }
      // Nobody leaves their group, and nobody plays twice in one week.
      for (const f of fixtures) {
        expect(groups.some((g) => g.includes(f.home) && g.includes(f.away))).toBe(true);
      }
      for (let week = 1; week <= format.regularWeeks; week++) {
        const playing = fixtures.filter((f) => f.week === week).flatMap((f) => [f.home, f.away]);
        expect(new Set(playing).size).toBe(playing.length);
      }
      const played = teams.map((t) => fixtures.filter((f) => f.home === t.id || f.away === t.id).length);
      expect(Math.min(...played)).toBe(format.matchesPerTeam.min);
      expect(Math.max(...played)).toBe(format.matchesPerTeam.max);
    });
  }

  it("spreads a smaller group's rounds over the longer group's weeks", () => {
    const seven = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    const six = ["b1", "b2", "b3", "b4", "b5", "b6"];
    const fixtures = regularSeasonFixtures([seven, six], false);
    const sixWeeks = [...new Set(fixtures.filter((f) => six.includes(f.home)).map((f) => f.week))];
    expect(sixWeeks).toEqual([1, 3, 4, 6, 7]);
  });
});

describe("drawGroups", () => {
  it("snakes the strongest rosters across the groups", () => {
    const teams = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, averageMmr: 5000 - i * 100 }));
    expect(drawGroups(teams)).toEqual([
      ["t0", "t3", "t4", "t7", "t8", "t11"],
      ["t1", "t2", "t5", "t6", "t9", "t10"],
    ]);
  });

  it("is the same draw whatever order the teams arrive in, ties by id", () => {
    const teams = [
      { id: "c", averageMmr: 4000 },
      { id: "a", averageMmr: 4000 },
      { id: "b", averageMmr: 4500 },
      { id: "d", averageMmr: null },
      { id: "e", averageMmr: 3000 },
    ];
    const first = drawGroups(teams);
    expect(drawGroups([...teams].reverse())).toEqual(first);
    // b (4500), a (4000, id first), c (4000), e (3000), d (unknown, last)
    expect(first).toEqual([["b", "e", "d"], ["a", "c"]]);
  });

  it("averages only the MMR on file", () => {
    expect(rosterAverageMmr([4000, 0, 3000])).toBe(3500);
    expect(rosterAverageMmr([0, 0])).toBeNull();
    expect(rosterAverageMmr([])).toBeNull();
  });
});

describe("seedGroups", () => {
  const A = ["a1", "a2", "a3", "a4", "a5"];
  const B = ["b1", "b2", "b3", "b4", "b5", "b6"];

  it("interleaves places so the bracket pairs A1–B4, B2–A3, B1–A4, A2–B3", () => {
    const seeding = seedGroups([{ key: "A", eligibleTeamIds: A }, { key: "B", eligibleTeamIds: B }], 8);
    expect(seeding.seededTeamIds).toEqual(["a1", "b1", "a2", "b2", "a3", "b3", "a4", "b4"]);
    expect(playoffFirstRound(seeding.seededTeamIds, 8)).toEqual([
      { home: "a1", away: "b4" },
      { home: "b2", away: "a3" },
      { home: "b1", away: "a4" },
      { home: "a2", away: "b3" },
    ]);
    expect(seeding.labels.get("b2")).toBe("B2");
    expect(seeding.qualifiers).toEqual(new Map([["A", 4], ["B", 4]]));
  });

  it("gives a short group's spare spot to the other group's next team", () => {
    const seeding = seedGroups(
      [{ key: "A", eligibleTeamIds: ["a1", "a2", "a3"] }, { key: "B", eligibleTeamIds: B }],
      8,
    );
    expect(seeding.seededTeamIds).toEqual(["a1", "b1", "a2", "b2", "a3", "b3", "b5", "b4"]);
    expect(seeding.labels.get("b5")).toBe("B5");
    expect(seeding.qualifiers).toEqual(new Map([["A", 3], ["B", 5]]));
  });

  it("seeds a four-team bracket from the top two of each group", () => {
    const seeding = seedGroups([{ key: "A", eligibleTeamIds: A }, { key: "B", eligibleTeamIds: B }], 4);
    expect(playoffFirstRound(seeding.seededTeamIds, 4)).toEqual([
      { home: "a1", away: "b2" },
      { home: "b1", away: "a2" },
    ]);
  });
});

describe("playoffBracketSize", () => {
  it("sends the top 4 of a table of four to nine, the top 2 below that", () => {
    expect(playoffBracketSize("TABLE", 3, 3)).toBe(2);
    expect(playoffBracketSize("TABLE", 4, 4)).toBe(4);
    expect(playoffBracketSize("TABLE", 8, 8)).toBe(4);
    expect(playoffBracketSize("TABLE", 9, 9)).toBe(4);
  });

  it("sends 8 from two groups, fewer when withdrawals leave too few", () => {
    expect(playoffBracketSize("GROUPS", 12, 12)).toBe(8);
    expect(playoffBracketSize("GROUPS", 10, 8)).toBe(8);
    expect(playoffBracketSize("GROUPS", 10, 7)).toBe(4);
    expect(playoffBracketSize("GROUPS", 10, 1)).toBe(0);
  });

  it("keeps the bracket a table generated before groups was built for", () => {
    expect(playoffBracketSize("TABLE", 12, 12)).toBe(8);
    expect(playoffBracketSize("TABLE", 24, 24)).toBe(16);
  });

  it("shrinks a table's bracket to what its eligible teams can fill", () => {
    expect(playoffBracketSize("TABLE", 5, 3)).toBe(2);
  });
});

describe("seasonPlan", () => {
  it("lists the group stage, the tiebreaker week and each playoff round", () => {
    const first = new Date("2026-11-07T22:00:00Z");
    const plan = seasonPlan(seasonFormat(12)!, first, undefined, null);
    expect(plan.map((s) => [s.kind, s.label, s.fromWeek, s.toWeek])).toEqual([
      ["REGULAR", "Group stage", 1, 5],
      ["TIEBREAKER", "Tiebreakers", 6, 6],
      ["PLAYOFF", "Quarterfinals", 7, 7],
      ["PLAYOFF", "Semifinals", 8, 8],
      ["PLAYOFF", "Grand final", 9, 9],
    ]);
    expect(plan[0].to?.toISOString()).toBe("2026-12-05T22:00:00.000Z");
    expect(plan[1].from?.toISOString()).toBe("2026-12-12T22:00:00.000Z");
    expect(plan[4].from?.toISOString()).toBe("2027-01-02T22:00:00.000Z");
  });

  it("follows the schedule's real last week and has no dates without week 1", () => {
    const plan = seasonPlan(seasonFormat(6)!, null, 6);
    expect(plan.map((s) => [s.label, s.fromWeek])).toEqual([
      ["Regular season", 1],
      ["Tiebreakers", 7],
      ["Semifinals", 8],
      ["Grand final", 9],
    ]);
    expect(plan.every((s) => s.from === null && s.to === null)).toBe(true);
  });
});

describe("describeSeasonFormat", () => {
  it("says the format in one plain line", () => {
    expect(describeSeasonFormat(seasonFormat(12)!)).toBe(
      "Two groups of 6. Each group plays a round robin over 5 weeks, then the top 4 of each group play the quarterfinals, the semifinals and the grand final.",
    );
    expect(describeSeasonFormat(seasonFormat(7)!)).toBe(
      "One table. Everyone plays everyone once over 7 weeks, then the top 4 play the semifinals and the grand final.",
    );
    expect(describeSeasonFormat(seasonFormat(4)!)).toBe(
      "One table, played twice. Everyone plays everyone twice over 6 weeks, then all 4 teams play the semifinals and the grand final.",
    );
    expect(describeSeasonFormat(seasonFormat(3)!)).toBe(
      "One table, played twice. Everyone plays everyone twice over 6 weeks, then the top 2 play the grand final.",
    );
    expect(formatName(seasonFormat(11)!)).toBe("Two groups of 6 and 5");
  });
});

describe("firstPlayoffWeek", () => {
  it("keeps the week after the regular season for tiebreakers, used or not", () => {
    expect(firstPlayoffWeek(5, 0)).toBe(7);
    expect(firstPlayoffWeek(5, 6)).toBe(7);
  });

  it("waits for tiebreakers that ran past their week", () => {
    expect(firstPlayoffWeek(5, 8)).toBe(9);
  });
});

describe("teamCountSeasonNote", () => {
  it("names the season this many teams make and the counts either side", () => {
    expect(teamCountSeasonNote(RECOMMENDED, 12)).toBe(
      "12 teams: two groups of 6, 9 weeks in all: 5 group weeks, the tiebreaker week and 3 playoff weeks. 11 teams: 9 weeks · 13 teams: 11 weeks.",
    );
    expect(teamCountSeasonNote(RECOMMENDED, 9)).toBe(
      "9 teams: one table, 12 weeks in all: 9 regular weeks, the tiebreaker week and 2 playoff weeks. 8 teams: 10 weeks · 10 teams: 9 weeks.",
    );
    expect(teamCountSeasonNote(RECOMMENDED, 2)).toBe(
      "2 teams: one table, played twice, 4 weeks in all: 2 regular weeks, the tiebreaker week and 1 playoff week. 3 teams: 8 weeks.",
    );
    expect(teamCountSeasonNote(RECOMMENDED, 1)).toBeNull();
  });

  it("says a single week in the singular", () => {
    expect(seasonLengthPhrase(seasonFormat(2)!)).toContain("1 playoff week");
  });
});

describe("formatSteps", () => {
  it("states every format by team count in one sentence", () => {
    expect(formatSteps()).toBe(
      "2 teams play one table twice, and both play the grand final; " +
        "3 teams play one table twice, and the top 2 play the grand final; " +
        "4 teams play one table twice, and all of them play the semifinals and the grand final; " +
        "5–9 teams play one table once, and the top 4 play the semifinals and the grand final; " +
        "10 or more teams play two groups, each a round robin on the same match nights, and the top 4 of each group play the quarterfinals, the semifinals and the grand final",
    );
  });
});

describe("playoffSteps", () => {
  it("says who makes the playoffs at every team count", () => {
    expect(playoffSteps()).toBe(
      "the top 2 of a table of 2–3 teams, the top 4 of a table of 4–9 teams and the top 4 of each group from 10 teams",
    );
  });
});

describe("buildSeasonFormat", () => {
  it("recommends the 2026-10-19 settings at every boundary", () => {
    expect(recommendedKnobs(2)).toEqual({ groups: 1, meet: 2, playoffs: 2 });
    expect(recommendedKnobs(3)).toEqual({ groups: 1, meet: 2, playoffs: 2 });
    expect(recommendedKnobs(4)).toEqual({ groups: 1, meet: 2, playoffs: 4 });
    expect(recommendedKnobs(5)).toEqual({ groups: 1, meet: 1, playoffs: 4 });
    expect(recommendedKnobs(9)).toEqual({ groups: 1, meet: 1, playoffs: 4 });
    expect(recommendedKnobs(10)).toEqual({ groups: 2, meet: 1, playoffs: 8 });
    expect(recommendedKnobs(17)).toEqual({ groups: 2, meet: 1, playoffs: 8 });
    expect(recommendedKnobs(1)).toBeNull();
    expect(recommendedKnobs(2.5)).toBeNull();
  });

  it("splits groups evenly, largest first, and plays them once or twice", () => {
    const twice = buildSeasonFormat({ groups: 2, meet: 2, playoffs: 4 }, 9)!;
    expect(twice).toMatchObject({
      kind: "GROUPS",
      groupSizes: [5, 4],
      doubleRound: true,
      regularWeeks: 10,
      matchesPerTeam: { min: 6, max: 8 },
      qualifiersPerGroup: 2,
      playoffRounds: 2,
      tiebreakerWeek: 11,
      firstPlayoffWeek: 12,
      totalWeeks: 13,
    });
    expect(formatName(twice)).toBe("Two groups of 5 and 4, each played twice");
    expect(describeSeasonFormat(twice)).toBe(
      "Two groups of 5 and 4, each played twice. Each group plays everyone in it twice over 10 weeks, then the top 2 of each group play the semifinals and the grand final.",
    );
  });

  it("names a final between the two group winners", () => {
    const winners = buildSeasonFormat({ groups: 2, meet: 1, playoffs: 2 }, 13)!;
    expect(winners.qualifiersPerGroup).toBe(1);
    expect(winners.totalWeeks).toBe(9);
    expect(describeSeasonFormat(winners)).toBe(
      "Two groups of 7 and 6. Each group plays a round robin over 7 weeks, then the group winners play the grand final.",
    );
    expect(playoffEntrantsPhrase(winners)).toBe("the group winners");
    expect(playoffEntrantsPhrase(seasonFormat(12)!)).toBe("the top 4 of each group");
    expect(playoffEntrantsPhrase(seasonFormat(4)!)).toBe("all 4 teams");
  });
});

describe("seasonGroupKeys", () => {
  const team = (groupKey: string | null) => ({ groupKey });

  it("needs every team in a group, and two groups or more", () => {
    expect(seasonGroupKeys([team("B"), team("A"), team("B")])).toEqual(["A", "B"]);
    expect(seasonGroupKeys([team("A"), team(null)])).toBeNull();
    expect(seasonGroupKeys([team("A"), team("A")])).toBeNull();
    expect(seasonGroupKeys([])).toBeNull();
  });
});

describe("resolveSeasonFormat", () => {
  const teams = (count: number, groupKey: (index: number) => string | null) =>
    Array.from({ length: count }, (_, index) => ({ groupKey: groupKey(index) }));

  it("is the planned format until the schedule exists", () => {
    expect(resolveSeasonFormat(RECOMMENDED, teams(12, () => null), false)).toEqual(seasonFormat(12));
    expect(resolveSeasonFormat(RECOMMENDED, teams(6, () => null), false)).toEqual(seasonFormat(6));
    expect(resolveSeasonFormat(RECOMMENDED, teams(1, () => null), false)).toBeNull();
  });

  it("keeps the groups a generated schedule drew", () => {
    const grouped = teams(12, (index) => (index % 2 === 0 ? "A" : "B"));
    expect(resolveSeasonFormat(RECOMMENDED, grouped, true)).toEqual(seasonFormat(12));
  });

  it("shows a table of ten or more generated before groups as the table it is", () => {
    const legacy = resolveSeasonFormat(RECOMMENDED, teams(12, () => null), true)!;
    expect(legacy).toMatchObject({
      kind: "TABLE",
      groupSizes: [12],
      doubleRound: false,
      regularWeeks: 11,
      playoffSpots: 8,
      totalWeeks: 15,
    });
    expect(formatName(legacy)).toBe("One table");
    // The bracket matches what the field seeds for it.
    expect(legacy.playoffSpots).toBe(playoffBracketSize("TABLE", 12, 12));
    // A half-grouped season renders as one table too, as its standings do.
    expect(
      resolveSeasonFormat(RECOMMENDED, teams(10, (index) => (index < 9 ? "A" : null)), true)!.kind,
    ).toBe("TABLE");
  });
});

describe("a stored season format", () => {
  const winners = serializeFormatConfig({ groups: 2, meet: 1, playoffs: 2 });
  const stored = (formatConfig: string | null) => ({ formatConfig });

  it("round-trips through one canonical string", () => {
    expect(winners).toBe('{"v":1,"groups":2,"meet":1,"playoffs":2}');
    expect(parseFormatConfig(winners)).toEqual({
      kind: "CUSTOM",
      knobs: { groups: 2, meet: 1, playoffs: 2 },
    });
    expect(serializeFormatConfig(null)).toBeNull();
    expect(parseFormatConfig(null)).toEqual({ kind: "RECOMMENDED" });
  });

  it("reads anything else as unreadable, never as Recommended", () => {
    for (const raw of [
      "",
      "not json",
      "[]",
      "null",
      '{"v":2,"groups":2,"meet":1,"playoffs":2}',
      '{"v":1,"groups":3,"meet":1,"playoffs":2}',
      '{"v":1,"groups":2,"meet":3,"playoffs":2}',
      '{"v":1,"groups":2,"meet":1,"playoffs":6}',
      '{"v":1,"groups":"2","meet":1,"playoffs":2}',
      '{"v":1,"groups":2,"meet":1}',
      '{"v":1,"groups":2,"meet":1,"playoffs":2,"breaks":[]}',
    ]) {
      expect(parseFormatConfig(raw), raw).toEqual({ kind: "UNREADABLE" });
    }
  });

  it("plans and plays the stored format, whatever the team count recommends", () => {
    // Thirteen teams in two groups whose winners play the final: 9 weeks.
    const planned = plannedSeasonFormat(stored(winners), 13)!;
    expect(planned).toMatchObject({
      kind: "GROUPS",
      groupSizes: [7, 6],
      playoffSpots: 2,
      totalWeeks: 9,
    });
    expect(planned).not.toEqual(seasonFormat(13));
    const teams = Array.from({ length: 13 }, (_, index) => ({
      groupKey: index < 7 ? "A" : "B",
    }));
    expect(resolveSeasonFormat(stored(winners), teams, true)).toEqual(planned);
    // Nine teams in one table sending eight: the Recommended rule sends 4.
    const eight = stored(serializeFormatConfig({ groups: 1, meet: 1, playoffs: 8 }));
    const table = Array.from({ length: 9 }, () => ({ groupKey: null }));
    expect(resolveSeasonFormat(eight, table, true)).toMatchObject({
      kind: "TABLE",
      playoffSpots: 8,
      totalWeeks: 13,
    });
    // Unreadable shows as Recommended; commands refuse it before building.
    expect(plannedSeasonFormat(stored("junk"), 13)).toEqual(seasonFormat(13));
  });

  it("follows the stored format in the captain-count note", () => {
    expect(teamCountSeasonNote(stored(winners), 13)).toBe(
      "13 teams: two groups of 7 and 6, 9 weeks in all: 7 group weeks, the tiebreaker week and 1 playoff week. 12 teams: 7 weeks · 14 teams: 9 weeks.",
    );
  });

  it("sizes the bracket from the stored places, shrunk to the eligible teams", () => {
    const eight = stored(serializeFormatConfig({ groups: 1, meet: 1, playoffs: 8 }));
    expect(seasonBracketSize(eight, "TABLE", 9, 9)).toBe(8);
    expect(seasonBracketSize(eight, "TABLE", 9, 7)).toBe(4);
    expect(seasonBracketSize(eight, "TABLE", 9, 1)).toBe(0);
    expect(seasonBracketSize(stored(winners), "GROUPS", 13, 13)).toBe(2);
    // No stored format: the Recommended spots.
    expect(seasonBracketSize(RECOMMENDED, "TABLE", 9, 9)).toBe(
      playoffBracketSize("TABLE", 9, 9),
    );
    expect(seasonBracketSize(stored("junk"), "GROUPS", 12, 12)).toBe(8);
    expect(formatBracketSize(plannedSeasonFormat(stored(winners), 13)!, 13)).toBe(2);
  });
});
