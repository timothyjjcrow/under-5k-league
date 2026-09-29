import { describe, expect, it } from "vitest";
import {
  compareDefaults,
  meetings,
  sharedSeries,
  type MeetingGame,
} from "./compare";

function game(
  radiantWin: boolean,
  lines: [string | null, boolean][], // [userId, isRadiant]
): MeetingGame {
  return {
    radiantWin,
    lines: lines.map(([userId, isRadiant]) => ({ userId, isRadiant })),
  };
}

describe("meetings", () => {
  it("returns zeros when the players never share a game", () => {
    const m = meetings(
      [game(true, [["a", true]]), game(false, [["b", false]])],
      "a",
      "b",
    );
    expect(m.opposite).toEqual({ games: 0, aWins: 0, bWins: 0 });
    expect(m.together).toEqual({ games: 0, wins: 0, losses: 0 });
  });

  it("splits opposite-side games into A wins and B wins", () => {
    const m = meetings(
      [
        game(true, [["a", true], ["b", false]]), // a radiant, wins
        game(false, [["a", true], ["b", false]]), // b dire, wins
        game(true, [["a", false], ["b", true]]), // b radiant, wins
      ],
      "a",
      "b",
    );
    expect(m.opposite).toEqual({ games: 3, aWins: 1, bWins: 2 });
    expect(m.together.games).toBe(0);
  });

  it("counts same-side games as together with a shared result", () => {
    const m = meetings(
      [
        game(true, [["a", true], ["b", true]]), // won together
        game(false, [["a", true], ["b", true]]), // lost together
        game(false, [["a", false], ["b", false]]), // won together (dire)
      ],
      "a",
      "b",
    );
    expect(m.together).toEqual({ games: 3, wins: 2, losses: 1 });
    expect(m.opposite.games).toBe(0);
  });

  it("ignores unmapped lines and games missing one player", () => {
    const m = meetings(
      [
        game(true, [["a", true], [null, false]]),
        game(true, [[null, true], ["b", false]]),
      ],
      "a",
      "b",
    );
    expect(m.opposite.games + m.together.games).toBe(0);
  });
});

describe("sharedSeries", () => {
  const at = (matchId: string, startTime: number, g: MeetingGame) => ({
    ...g,
    matchId,
    startTime,
  });

  it("groups the games both played by series, newest first", () => {
    const series = sharedSeries(
      [
        at("m1", 100, game(true, [["a", true], ["b", false]])),
        at("m1", 200, game(false, [["a", true], ["b", false]])),
        at("m2", 500, game(true, [["a", true], ["b", true]])),
        at("m3", 900, game(true, [["a", true], ["c", false]])), // no b
      ],
      "a",
      "b",
    );
    expect(series.map((s) => s.matchId)).toEqual(["m2", "m1"]);
    expect(series[1]).toEqual({
      matchId: "m1",
      startTime: 100,
      meetings: {
        opposite: { games: 2, aWins: 1, bWins: 1 },
        together: { games: 0, wins: 0, losses: 0 },
      },
    });
    expect(series[0].meetings.together).toEqual({
      games: 1,
      wins: 1,
      losses: 0,
    });
  });

  it("puts series with no known start time last", () => {
    const series = sharedSeries(
      [
        at("old", 0, game(true, [["a", true], ["b", false]])),
        at("new", 50, game(true, [["a", true], ["b", false]])),
      ],
      "a",
      "b",
    );
    expect(series.map((s) => [s.matchId, s.startTime])).toEqual([
      ["new", 50],
      ["old", 0],
    ]);
  });
});

describe("compareDefaults", () => {
  const none = { aParam: undefined, bParam: undefined, aId: undefined, bId: undefined };

  it("starts with the viewer as player A on a bare visit", () => {
    expect(compareDefaults({ ...none, viewerId: "me" })).toEqual({ a: "me", b: "" });
  });

  it("puts the viewer opposite a player the link already named", () => {
    expect(
      compareDefaults({ ...none, aParam: "them", aId: "them", viewerId: "me" }),
    ).toEqual({ a: "them", b: "me" });
    expect(
      compareDefaults({ ...none, bParam: "them", bId: "them", viewerId: "me" }),
    ).toEqual({ a: "me", b: "them" });
  });

  it("never overrides a slot the URL named, even with an unknown player", () => {
    expect(
      compareDefaults({ ...none, aParam: "ghost", bParam: "them", bId: "them", viewerId: "me" }),
    ).toEqual({ a: "", b: "them" });
    expect(
      compareDefaults({ aParam: "x", bParam: "y", aId: "x", bId: "y", viewerId: "me" }),
    ).toEqual({ a: "x", b: "y" });
  });

  it("never pairs the viewer with themselves", () => {
    expect(
      compareDefaults({ ...none, aParam: "me", aId: "me", viewerId: "me" }),
    ).toEqual({ a: "me", b: "" });
  });

  it("leaves both empty for a viewer without league games", () => {
    expect(compareDefaults({ ...none, viewerId: null })).toEqual({ a: "", b: "" });
  });
});
