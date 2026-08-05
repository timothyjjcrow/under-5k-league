import { describe, expect, it } from "vitest";
import { projectPlayoffField } from "./playoff-field";
import type { MatchLike } from "./standings";

function result(
  homeTeamId: string,
  awayTeamId: string,
  homeScore: number,
  awayScore: number,
  forfeit = false,
): MatchLike {
  return {
    homeTeamId,
    awayTeamId,
    homeScore,
    awayScore,
    winnerTeamId:
      homeScore > awayScore
        ? homeTeamId
        : awayScore > homeScore
          ? awayTeamId
          : null,
    phase: "REGULAR",
    status: "COMPLETED",
    forfeit,
  };
}

describe("projectPlayoffField", () => {
  it("banks played and forfeit results against a withdrawn team for survivors", () => {
    const projection = projectPlayoffField(
      [
        { id: "played-winner" },
        { id: "forfeit-winner" },
        { id: "withdrawn", withdrawn: true },
      ],
      [
        result("played-winner", "withdrawn", 2, 0),
        result("withdrawn", "forfeit-winner", 0, 2, true),
      ],
    );

    const playedWinner = projection.standings.find(
      (row) => row.teamId === "played-winner",
    );
    const forfeitWinner = projection.standings.find(
      (row) => row.teamId === "forfeit-winner",
    );
    expect(playedWinner).toMatchObject({
      played: 1,
      wins: 1,
      points: 3,
      gameDiff: 2,
    });
    expect(forfeitWinner).toMatchObject({
      played: 1,
      wins: 1,
      points: 3,
      gameDiff: 0,
    });
    expect(projection.standings.map((row) => row.teamId)).toContain(
      "withdrawn",
    );
    expect(projection.eligibleTeamIds).toEqual([
      "played-winner",
      "forfeit-winner",
    ]);
    expect(projection.seededTeamIds).not.toContain("withdrawn");
    expect(projection.seedByTeam.has("withdrawn")).toBe(false);
    expect(projection.pairings).toEqual([
      { home: "played-winner", away: "forfeit-winner" },
    ]);
  });

  it("truncates a non-power-of-two eligible field at the playoff cut", () => {
    const teams = ["t1", "t2", "t3", "t4", "t5"].map((id) => ({ id }));
    const matches: MatchLike[] = [];
    for (let stronger = 1; stronger <= 4; stronger++) {
      for (let weaker = stronger + 1; weaker <= 5; weaker++) {
        matches.push(result(`t${stronger}`, `t${weaker}`, 2, 0));
      }
    }

    const projection = projectPlayoffField(teams, matches);

    expect(projection.eligibleTeamIds).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(projection.bracketSize).toBe(4);
    expect(projection.seededTeamIds).toEqual(["t1", "t2", "t3", "t4"]);
    expect(projection.seedByTeam).toEqual(
      new Map([
        ["t1", 1],
        ["t2", 2],
        ["t3", 3],
        ["t4", 4],
      ]),
    );
    expect(projection.pairings).toEqual([
      { home: "t1", away: "t4" },
      { home: "t2", away: "t3" },
    ]);
  });

  it("returns no bracket when fewer than two teams are eligible", () => {
    const projection = projectPlayoffField(
      [{ id: "alive" }, { id: "withdrawn", withdrawn: true }],
      [],
    );

    expect(projection.standings).toHaveLength(2);
    expect(projection.eligibleStandings.map((row) => row.teamId)).toEqual([
      "alive",
    ]);
    expect(projection.eligibleTeamIds).toEqual(["alive"]);
    expect(projection.bracketSize).toBe(0);
    expect(projection.seededTeamIds).toEqual([]);
    expect(projection.seedByTeam).toEqual(new Map());
    expect(projection.pairings).toEqual([]);
  });

  it("names the whole unresolved tie when it straddles the cut", () => {
    const teams = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
    const matches = [
      ...["b", "c", "d", "e", "f"].map((away) => result("a", away, 2, 0)),
      ...["c", "d", "e", "f"].map((away) => result("b", away, 2, 0)),
      ...["d", "e", "f"].map((away) => result("c", away, 2, 0)),
      result("d", "e", 1, 1),
      result("d", "f", 1, 1),
      result("e", "f", 1, 1),
    ];

    const projection = projectPlayoffField(teams, matches);

    expect(projection.bracketSize).toBe(4);
    expect(projection.seedingDeadHeatTeamIds).toEqual(["d", "e", "f"]);
  });

  it("does not warn about a dead heat wholly below the cut", () => {
    const teams = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
    const matches = [
      ...["b", "c", "d", "e", "f"].map((away) => result("a", away, 2, 0)),
      ...["c", "d", "e", "f"].map((away) => result("b", away, 2, 0)),
      ...["d", "e", "f"].map((away) => result("c", away, 2, 0)),
      result("d", "e", 2, 0),
      result("d", "f", 2, 0),
      result("e", "f", 1, 1),
    ];

    const projection = projectPlayoffField(teams, matches);

    expect(projection.seededTeamIds).toEqual(["a", "b", "c", "d"]);
    expect(projection.seedingDeadHeatTeamIds).toEqual([]);
  });

  it("does not warn when a seed is tied only with a withdrawn team", () => {
    const teams = [
      { id: "a" },
      { id: "b" },
      { id: "c" },
      { id: "d" },
      { id: "e", withdrawn: true },
    ];
    const matches = [
      ...["b", "c", "d", "e"].map((away) => result("a", away, 2, 0)),
      ...["c", "d", "e"].map((away) => result("b", away, 2, 0)),
      result("c", "d", 2, 0),
      result("c", "e", 2, 0),
      result("d", "e", 1, 1),
    ];

    const projection = projectPlayoffField(teams, matches);

    expect(projection.seededTeamIds).toEqual(["a", "b", "c", "d"]);
    expect(projection.seedingDeadHeatTeamIds).toEqual([]);
  });

  it("returns no bracket for an empty league", () => {
    const projection = projectPlayoffField([], []);

    expect(projection.standings).toEqual([]);
    expect(projection.eligibleTeamIds).toEqual([]);
    expect(projection.bracketSize).toBe(0);
    expect(projection.seededTeamIds).toEqual([]);
    expect(projection.pairings).toEqual([]);
  });
});
