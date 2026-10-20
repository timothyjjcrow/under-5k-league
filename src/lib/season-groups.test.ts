import { describe, expect, it } from "vitest";
import { projectPlayoffField } from "./playoff-field";
import {
  bracketSeedLabels,
  placeLabel,
  playoffPlacesPhrase,
  standingsSections,
  tableMovement,
} from "./season-groups";
import type { MatchLike } from "./standings";
import { seedsFromFirstRound } from "./bracket-view";
import { playoffFirstRound } from "./schedule";

function result(home: string, away: string, homeScore: number, awayScore: number, week = 1) {
  return {
    homeTeamId: home,
    awayTeamId: away,
    homeScore,
    awayScore,
    winnerTeamId: homeScore > awayScore ? home : awayScore > homeScore ? away : null,
    phase: "REGULAR",
    status: "COMPLETED",
    week,
  } satisfies MatchLike & { week: number };
}

/** Every pair meets once; the earlier-listed team wins 2–0, in week i+j. */
function ladder(ids: string[]) {
  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) rows.push(result(ids[i], ids[j], 2, 0, i + j));
  }
  return rows;
}

const A = ["a1", "a2", "a3", "a4", "a5"];
const B = ["b1", "b2", "b3", "b4", "b5"];
const groupTeams = [
  ...A.map((id) => ({ id, groupKey: "A" })),
  ...B.map((id) => ({ id, groupKey: "B" })),
];

describe("standingsSections", () => {
  it("gives one table per group with its own cut and bracket names", () => {
    const field = projectPlayoffField(groupTeams, [...ladder(A), ...ladder(B)]);
    const sections = standingsSections(field);
    expect(sections.map((s) => [s.title, s.standings.map((r) => r.teamId), s.playoffCut])).toEqual([
      ["Group A", A, 4],
      ["Group B", B, 4],
    ]);
    expect(sections[1].playoffSeedByTeam).toEqual(new Map([["b1", 1], ["b2", 2], ["b3", 3], ["b4", 4]]));
    expect(sections[1].seedLabelByTeam?.get("b3")).toBe("B3");
    expect(sections[0].label).toBe("Group A standings");
    expect(sections[0].eligibleTeams).toBe(5);
  });

  it("gives a one-table season its table, seeds and cut unchanged", () => {
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
    const field = projectPlayoffField(ids.map((id) => ({ id })), ladder(ids));
    const [only] = standingsSections(field);
    expect(only.title).toBeNull();
    expect(only.playoffCut).toBe(4);
    expect(only.playoffSeedByTeam).toBe(field.seedByTeam);
    expect(only.seedLabelByTeam).toBeUndefined();
    expect(only.label).toBe("League standings");
  });
});

describe("tableMovement", () => {
  it("measures movement inside each group", () => {
    // Week 1 to 9 ladders; in the latest week b5 beats b1 and a5 beats a1.
    const matches = [
      ...ladder(A),
      ...ladder(B),
      result("a5", "a1", 2, 0, 20),
      result("b5", "b1", 2, 0, 20),
    ];
    const field = projectPlayoffField(groupTeams, matches);
    const movement = tableMovement(standingsSections(field), matches);
    // Each group is its own table: nobody moves by more than its group's size.
    for (const value of movement.values()) expect(Math.abs(value)).toBeLessThan(5);
    expect(movement.size).toBe(10);
  });
});

describe("placeLabel", () => {
  it("names the group when there is one", () => {
    expect(placeLabel({ place: 2, groupKey: "A" })).toBe("2nd in Group A");
    expect(placeLabel({ place: 3, groupKey: null })).toBe("3rd");
  });
});

describe("bracketSeedLabels", () => {
  it("names a frozen group bracket's seeds A1, B1, A2…", () => {
    const seeds = ["a1", "b1", "a2", "b2", "a3", "b3", "a4", "b4"];
    const frozen = seedsFromFirstRound(
      playoffFirstRound(seeds, 8).map((pairing, index) => ({
        bracketSlot: `R0M${index}`,
        homeTeamId: pairing.home,
        awayTeamId: pairing.away,
      })),
    );
    const labels = bracketSeedLabels(frozen, groupTeams);
    expect(seeds.map((id) => labels.get(id))).toEqual(["A1", "B1", "A2", "B2", "A3", "B3", "A4", "B4"]);
  });

  it("names a team sent in a short group's place by its own group", () => {
    // Group A had three eligible teams, so B5 took the A4 slot (seed 7).
    const seedByTeam = new Map([
      ["a1", 1], ["b1", 2], ["a4", 3], ["b2", 4], ["a5", 5], ["b3", 6], ["b5", 7], ["b4", 8],
    ]);
    const labels = bracketSeedLabels(seedByTeam, groupTeams);
    expect(labels.get("b5")).toBe("B5");
    expect(labels.get("b4")).toBe("B4");
    expect(labels.get("a4")).toBe("A2");
  });

  it("matches the field's own names", () => {
    const field = projectPlayoffField(groupTeams, [...ladder(A), ...ladder(B)]);
    const frozen = seedsFromFirstRound(
      field.pairings.map((pairing, index) => ({
        bracketSlot: `R0M${index}`,
        homeTeamId: pairing.home,
        awayTeamId: pairing.away,
      })),
    );
    expect(bracketSeedLabels(frozen, groupTeams)).toEqual(field.seedLabelByTeam);
  });

  it("uses the seed numbers for a one-table season", () => {
    expect(bracketSeedLabels(new Map([["t1", 1], ["t2", 2]]), [{ id: "t1" }, { id: "t2" }]))
      .toEqual(new Map([["t1", "1"], ["t2", "2"]]));
  });
});

describe("playoffPlacesPhrase", () => {
  it("says how the places are shared", () => {
    const field = projectPlayoffField(groupTeams, [...ladder(A), ...ladder(B)]);
    expect(playoffPlacesPhrase(field)).toBe("8 playoff places: the top 4 of each group");
    expect(playoffPlacesPhrase({ groups: null, bracketSize: 4 })).toBe("4 playoff places");
  });
});
