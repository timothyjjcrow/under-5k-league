import { describe, expect, it } from "vitest";
import {
  projectPlayoffField,
  publicDeadHeatTeamIds,
  tablePlaceOf,
  tiebreakersInPlay,
} from "./playoff-field";
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
      gameDiff: 2,
    });
    expect(projection.standings.map((row) => row.teamId)).toContain(
      "withdrawn",
    );
    expect(projection.eligibleTeamIds).toEqual([
      "forfeit-winner",
      "played-winner",
    ]);
    expect(projection.seededTeamIds).not.toContain("withdrawn");
    expect(projection.seedByTeam.has("withdrawn")).toBe(false);
    expect(projection.pairings).toEqual([
      { home: "forfeit-winner", away: "played-winner" },
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

describe("public tiebreaker badges", () => {
  const teams = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
  // d, e and f are level on every standings tiebreak across the cut.
  const played = [
    ...["b", "c", "d", "e", "f"].map((away) => result("a", away, 2, 0)),
    ...["c", "d", "e", "f"].map((away) => result("b", away, 2, 0)),
    ...["d", "e", "f"].map((away) => result("c", away, 2, 0)),
    result("d", "e", 1, 1),
    result("d", "f", 1, 1),
    result("e", "f", 1, 1),
  ];
  const unplayed = (
    homeTeamId: string,
    awayTeamId: string,
    status: string,
    phase = "REGULAR",
  ): MatchLike => ({
    homeTeamId,
    awayTeamId,
    homeScore: 0,
    awayScore: 0,
    winnerTeamId: null,
    phase,
    status,
  });

  it("keeps a mid-season dead heat off the public badges", () => {
    for (const status of ["SCHEDULED", "LIVE"]) {
      const matches = [...played, unplayed("a", "b", status)];
      const projection = projectPlayoffField(teams, matches);
      // The projection itself still sees the tie (admin tools read it)...
      expect(projection.seedingDeadHeatTeamIds).toEqual(["d", "e", "f"]);
      // ...but the public table and playoff picture do not badge it yet.
      expect(tiebreakersInPlay(matches)).toBe(false);
      expect(publicDeadHeatTeamIds(projection, matches)).toEqual([]);
    }
  });

  it("badges the tie once every regular-season fixture is final", () => {
    const projection = projectPlayoffField(teams, played);
    expect(tiebreakersInPlay(played)).toBe(true);
    expect(publicDeadHeatTeamIds(projection, played)).toEqual(["d", "e", "f"]);
  });

  it("badges the tie once tiebreaker fixtures exist", () => {
    const matches = [
      ...played,
      unplayed("a", "b", "SCHEDULED"),
      unplayed("d", "e", "SCHEDULED", "TIEBREAKER"),
    ];
    const projection = projectPlayoffField(teams, matches);
    expect(tiebreakersInPlay(matches)).toBe(true);
    expect(publicDeadHeatTeamIds(projection, matches)).toEqual(
      projection.seedingDeadHeatTeamIds,
    );
  });

  it("never badges a league with no regular-season results yet", () => {
    const fresh = projectPlayoffField(teams, []);
    expect(fresh.seedingDeadHeatTeamIds.length).toBeGreaterThan(0);
    expect(tiebreakersInPlay([])).toBe(false);
    expect(publicDeadHeatTeamIds(fresh, [])).toEqual([]);
    const scheduled = [unplayed("a", "b", "SCHEDULED")];
    expect(publicDeadHeatTeamIds(fresh, scheduled)).toEqual([]);
  });
});

describe("group-stage seasons", () => {
  const groupA = ["a1", "a2", "a3", "a4", "a5"];
  const groupB = ["b1", "b2", "b3", "b4", "b5"];
  const teams = [
    ...groupA.map((id) => ({ id, groupKey: "A" })),
    ...groupB.map((id) => ({ id, groupKey: "B" })),
  ];

  /** Every pair in the group meets once; the earlier-listed team wins 2–0. */
  function ladder(ids: string[], overrides: Record<string, [number, number]> = {}) {
    const rows: MatchLike[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [home, away] = overrides[`${ids[i]}-${ids[j]}`] ?? [2, 0];
        rows.push(result(ids[i], ids[j], home, away));
      }
    }
    return rows;
  }

  it("ranks each group on its own results and interleaves the seeds", () => {
    const projection = projectPlayoffField(teams, [...ladder(groupA), ...ladder(groupB)]);
    expect(projection.kind).toBe("GROUPS");
    expect(projection.groups?.map((g) => [g.key, g.standings.map((r) => r.teamId), g.qualifiers])).toEqual([
      ["A", groupA, 4],
      ["B", groupB, 4],
    ]);
    expect(projection.bracketSize).toBe(8);
    expect(projection.seededTeamIds).toEqual(["a1", "b1", "a2", "b2", "a3", "b3", "a4", "b4"]);
    expect(projection.pairings).toEqual([
      { home: "a1", away: "b4" },
      { home: "b2", away: "a3" },
      { home: "b1", away: "a4" },
      { home: "a2", away: "b3" },
    ]);
    expect(projection.seedLabelByTeam.get("b4")).toBe("B4");
    expect(projection.seedByTeam.get("b1")).toBe(2);
    expect(tablePlaceOf(projection, "b3")).toEqual({ place: 3, groupKey: "B" });
    expect(projection.seedingDeadHeatTeamIds).toEqual([]);
    expect(projection.tiebreakers.resolved).toBe(true);
  });

  it("never counts a result between the groups in either table", () => {
    const projection = projectPlayoffField(teams, [
      ...ladder(groupA),
      ...ladder(groupB),
      result("a5", "b1", 2, 0),
    ]);
    const a5 = projection.standings.find((row) => row.teamId === "a5")!;
    expect(a5.played).toBe(4);
    expect(a5.points).toBe(0);
  });

  it("plays off a dead heat on one group's cut against that group's own draw", () => {
    // a4 and a5 draw each other and lose to everyone else: identical records.
    const projection = projectPlayoffField(teams, [
      ...ladder(groupA, { "a4-a5": [1, 1] }),
      ...ladder(groupB),
    ]);
    expect(projection.seedingDeadHeatTeamIds).toEqual(["a4", "a5"]);
    expect(projection.tiebreakers.needsMatches).toBe(true);
    expect(projection.tiebreakers.resolved).toBe(false);
    const groupBDraw = projectPlayoffField(teams, [
      ...ladder(groupA),
      ...ladder(groupB, { "b4-b5": [1, 1] }),
    ]).tiebreakers.groups[0];
    // Each group's draw is bound to its own results, so their keys differ.
    expect(projection.tiebreakers.groups[0].teamIds).toEqual(["a4", "a5"]);
    expect(groupBDraw.teamIds).toEqual(["b4", "b5"]);
    expect(projection.tiebreakers.groups[0].key).not.toBe(groupBDraw.key);
  });

  it("refuses a tiebreaker fixture between the two groups", () => {
    const projection = projectPlayoffField(teams, [
      ...ladder(groupA),
      ...ladder(groupB),
      { ...result("a4", "b4", 1, 0), phase: "TIEBREAKER", bracketSlot: "TBS:x:1:y:0" },
    ]);
    expect(projection.tiebreakers.error).not.toBeNull();
    expect(projection.tiebreakers.resolved).toBe(false);
  });

  it("hands a short group's spot to the other group's next team", () => {
    const projection = projectPlayoffField(
      teams.map((team) =>
        team.id === "a2" || team.id === "a3" ? { ...team, withdrawn: true } : team,
      ),
      [...ladder(groupA), ...ladder(groupB)],
    );
    expect(projection.groups?.map((g) => g.qualifiers)).toEqual([3, 5]);
    expect(projection.seededTeamIds).toEqual(["a1", "b1", "a4", "b2", "a5", "b3", "b5", "b4"]);
    expect(projection.seedLabelByTeam.get("b5")).toBe("B5");
    // The withdrawn rows keep their places in the public table.
    expect(projection.groups?.[0].standings.map((r) => r.teamId)).toEqual(groupA);
  });

  it("plays one table when any team has no group", () => {
    const projection = projectPlayoffField(
      teams.map((team) => (team.id === "b5" ? { id: team.id } : team)),
      [...ladder(groupA), ...ladder(groupB)],
    );
    expect(projection.kind).toBe("TABLE");
    expect(projection.groups).toBeNull();
  });
});

describe("one-table bracket size", () => {
  it("sends the top 4 of an eight-team table", () => {
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
    const matches: MatchLike[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) matches.push(result(ids[i], ids[j], 2, 0));
    }
    const projection = projectPlayoffField(ids.map((id) => ({ id })), matches);
    expect(projection.bracketSize).toBe(4);
    expect(projection.seededTeamIds).toEqual(["t1", "t2", "t3", "t4"]);
    expect(projection.seedLabelByTeam.get("t2")).toBe("2");
    expect(tablePlaceOf(projection, "t6")).toEqual({ place: 6, groupKey: null });
  });
});
