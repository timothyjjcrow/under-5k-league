import { describe, expect, it } from "vitest";
import {
  playoffRoad,
  playoffRoadTitle,
  playoffRunTile,
  teamPlayoffRun,
  type PlayoffRunMatch,
} from "./playoff-run";

let seq = 0;
function m(
  slot: string,
  home: string,
  away: string,
  opts: Partial<PlayoffRunMatch> = {},
): PlayoffRunMatch {
  return {
    id: `m${seq++}`,
    phase: "PLAYOFF",
    week: 8,
    bracketSlot: slot,
    status: "SCHEDULED",
    winnerTeamId: null,
    homeTeamId: home,
    awayTeamId: away,
    ...opts,
  };
}
const won = (winner: string) => ({
  status: "COMPLETED",
  winnerTeamId: winner,
});

// An 8-team bracket: quarterfinals R0, semifinals R1, grand final R2.
const quarters = [
  m("R0M0", "a", "h", won("a")),
  m("R0M1", "d", "e", won("e")),
  m("R0M2", "c", "f", won("c")),
  m("R0M3", "b", "g", won("b")),
];
const regular = m("", "a", "b", { phase: "REGULAR", bracketSlot: null, ...won("a") });

describe("teamPlayoffRun", () => {
  it("is null while the season has no bracket", () => {
    expect(teamPlayoffRun("a", [regular], null)).toBeNull();
    expect(teamPlayoffRun("a", [], null)).toBeNull();
  });

  it("says a team outside the bracket missed the playoffs", () => {
    expect(teamPlayoffRun("z", [regular, ...quarters], null)).toEqual({
      kind: "missed",
    });
  });

  it("names the round a team went out in", () => {
    expect(teamPlayoffRun("h", quarters, null)).toEqual({
      kind: "out",
      round: "Quarterfinal",
    });
  });

  it("names the next series of a team still alive, and whether it is live", () => {
    const semis = [
      m("R1M0", "a", "e"),
      m("R1M1", "c", "b", { status: "LIVE" }),
    ];
    expect(teamPlayoffRun("a", [...quarters, ...semis], null)).toEqual({
      kind: "alive",
      round: "Semifinal",
      live: false,
    });
    expect(teamPlayoffRun("b", [...quarters, ...semis], null)).toEqual({
      kind: "alive",
      round: "Semifinal",
      live: true,
    });
  });

  it("says through when a team has won its series and the next is not drawn", () => {
    expect(teamPlayoffRun("a", quarters, null)).toEqual({
      kind: "through",
      round: "Quarterfinal",
    });
  });

  it("crowns only the resolved champion, and calls the final's loser runner-up", () => {
    const rest = [
      m("R1M0", "a", "e", won("a")),
      m("R1M1", "c", "b", won("b")),
      m("R2M0", "a", "b", { phase: "FINAL", ...won("a") }),
    ];
    const all = [...quarters, ...rest];
    expect(teamPlayoffRun("a", all, "a")).toEqual({ kind: "champion" });
    expect(teamPlayoffRun("b", all, "a")).toEqual({ kind: "runnerUp" });
    expect(teamPlayoffRun("e", all, "a")).toEqual({
      kind: "out",
      round: "Semifinal",
    });
    // A final won before the title is confirmed is not a crown, and its
    // loser isn't the runner-up yet either (the team pages say nothing).
    expect(teamPlayoffRun("a", all, null)).toEqual({ kind: "finalPending" });
    expect(teamPlayoffRun("b", all, null)).toEqual({ kind: "finalPending" });
    expect(teamPlayoffRun("e", all, null)).toEqual({
      kind: "out",
      round: "Semifinal",
    });
  });

  it("follows the confirmed champion when it disagrees with the final's row", () => {
    // A disputed or reopened final: the season names b, the row says a won.
    const all = [
      ...quarters,
      m("R1M0", "a", "e", won("a")),
      m("R1M1", "c", "b", won("b")),
      m("R2M0", "a", "b", { phase: "FINAL", ...won("a") }),
    ];
    expect(teamPlayoffRun("b", all, "b")).toEqual({ kind: "champion" });
    expect(teamPlayoffRun("a", all, "b")).toEqual({ kind: "finalPending" });
  });
});

describe("playoffRunTile", () => {
  it("reads as plain status lines", () => {
    expect(playoffRunTile({ kind: "champion" })).toEqual({
      value: "Champion",
      hint: "Won the grand final",
    });
    expect(playoffRunTile({ kind: "runnerUp" })).toEqual({
      value: "Runner-up",
      hint: "Lost the grand final",
    });
    expect(playoffRunTile({ kind: "out", round: "Quarterfinal" })).toEqual({
      value: "Eliminated",
      hint: "Lost in the quarterfinal",
    });
    expect(playoffRunTile({ kind: "out", round: "Round 1" })).toEqual({
      value: "Eliminated",
      hint: "Lost in round 1",
    });
    expect(
      playoffRunTile({ kind: "alive", round: "Semifinal", live: false }),
    ).toEqual({ value: "Semifinal", hint: "Up next" });
    expect(
      playoffRunTile({ kind: "alive", round: "Grand final", live: true }),
    ).toEqual({ value: "Grand final", hint: "Playing now" });
    expect(playoffRunTile({ kind: "through", round: "Quarterfinal" })).toEqual(
      { value: "Through", hint: "Won the quarterfinal" },
    );
    expect(playoffRunTile({ kind: "finalPending" })).toEqual({
      value: "Grand final",
      hint: "Result pending",
    });
    expect(playoffRunTile({ kind: "missed" })).toEqual({
      value: "Missed",
      hint: "Didn't make the playoffs",
    });
  });
});

describe("playoffRoad", () => {
  const scored = (
    slot: string,
    home: string,
    away: string,
    homeScore: number,
    awayScore: number,
    opts: Partial<PlayoffRunMatch> = {},
  ) => ({
    ...m(slot, home, away, {
      status: "COMPLETED",
      winnerTeamId:
        homeScore > awayScore ? home : awayScore > homeScore ? away : null,
      ...opts,
    }),
    homeScore,
    awayScore,
  });
  // An 8-team bracket down to its final: a beat h and c, b beat e.
  const qf = [
    scored("R0M0", "a", "h", 2, 0),
    scored("R0M1", "d", "e", 1, 2),
    scored("R0M2", "c", "f", 2, 1),
    scored("R0M3", "b", "g", 2, 0),
  ];
  const sf = [scored("R1M0", "a", "e", 2, 1), scored("R1M1", "c", "b", 0, 2)];
  const final = {
    ...m("R2M0", "a", "b", { phase: "FINAL" }),
    homeScore: 0,
    awayScore: 0,
  };
  const season = [
    { ...regular, homeScore: 1, awayScore: 0 },
    ...qf,
    ...sf,
    final,
  ];

  it("walks each finalist's completed series in round order", () => {
    expect(playoffRoad("a", final, season)).toEqual([
      {
        matchId: qf[0].id,
        round: "Quarterfinal",
        opponentId: "h",
        won: 2,
        lost: 0,
        wonSeries: true,
      },
      {
        matchId: sf[0].id,
        round: "Semifinal",
        opponentId: "e",
        won: 2,
        lost: 1,
        wonSeries: true,
      },
    ]);
    // The away side's scores are its own, not the home side's.
    expect(
      playoffRoad("b", final, season).map((s) => [s.opponentId, s.won, s.lost]),
    ).toEqual([
      ["g", 2, 0],
      ["c", 2, 0],
    ]);
  });

  it("stops at the match's own round", () => {
    // A semifinal's road is the quarterfinal alone; the semifinal itself and
    // the final after it are not part of the way there, even once played.
    const decided = season.map((row) =>
      row.id === final.id
        ? { ...row, status: "COMPLETED", winnerTeamId: "a", homeScore: 2 }
        : row,
    );
    expect(playoffRoad("a", sf[0], decided).map((s) => s.round)).toEqual([
      "Quarterfinal",
    ]);
  });

  it("is empty in the first round, for regular fixtures and slotless rows", () => {
    expect(playoffRoad("a", qf[0], season)).toEqual([]);
    expect(playoffRoad("a", regular, season)).toEqual([]);
    expect(
      playoffRoad("a", { ...final, bracketSlot: null }, season),
    ).toEqual([]);
  });

  it("skips earlier series that have no result yet", () => {
    const unfinished = season.map((row) =>
      row.id === sf[0].id
        ? { ...row, status: "LIVE", winnerTeamId: null }
        : row,
    );
    expect(playoffRoad("a", final, unfinished).map((s) => s.round)).toEqual([
      "Quarterfinal",
    ]);
  });
});

describe("playoffRoadTitle", () => {
  it("names the round the road leads to", () => {
    expect(playoffRoadTitle("Grand final")).toBe("Road to the grand final");
    expect(playoffRoadTitle("Semifinal")).toBe("Road to the semifinal");
    expect(playoffRoadTitle("Quarterfinal")).toBe("Road to the quarterfinal");
    expect(playoffRoadTitle("Round 2")).toBe("Road to round 2");
    expect(playoffRoadTitle("Playoffs")).toBe("Road here");
  });
});
