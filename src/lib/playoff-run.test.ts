import { describe, expect, it } from "vitest";
import {
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
    // A final won before the title is confirmed is not a crown.
    expect(teamPlayoffRun("a", all, null)).toEqual({
      kind: "through",
      round: "Grand final",
    });
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
    expect(playoffRunTile({ kind: "missed" })).toEqual({
      value: "Missed",
      hint: "Didn't make the playoffs",
    });
  });
});
