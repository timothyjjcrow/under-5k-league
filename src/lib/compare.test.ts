import { describe, expect, it } from "vitest";
import { meetings, topAffinities, type MeetingGame } from "./compare";

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

describe("topAffinities", () => {
  it("returns null slots when nothing clears the meeting floor", () => {
    const a = topAffinities(
      [game(true, [["a", true], ["b", false]])],
      "a",
      3,
    );
    expect(a.nemesis).toBeNull();
    expect(a.duo).toBeNull();
  });

  it("classifies sides exactly like meetings() and counts self's record", () => {
    const games = [
      game(true, [["a", true], ["b", false], ["c", true]]), // a wins: vs b, with c
      game(false, [["a", true], ["b", false], ["c", true]]), // a loses: vs b, with c
      game(true, [["a", false], ["b", true], ["c", false]]), // a loses: vs b, with c
    ];
    const aff = topAffinities(games, "a", 3);
    const m = meetings(games, "a", "b");
    expect(aff.nemesis).toEqual({ userId: "b", games: 3, wins: 1, losses: 2 });
    expect(aff.nemesis?.games).toBe(m.opposite.games);
    expect(aff.nemesis?.wins).toBe(m.opposite.aWins);
    expect(aff.duo).toEqual({ userId: "c", games: 3, wins: 1, losses: 2 });
    expect(aff.duo?.games).toBe(meetings(games, "a", "c").together.games);
  });

  it("skips games where self has no mapped line, and unmapped lines", () => {
    const aff = topAffinities(
      [
        game(true, [["b", true], ["c", false]]), // self absent — no meeting
        game(true, [["a", true], [null, false]]), // unmapped rival — no meeting
      ],
      "a",
      1,
    );
    expect(aff.nemesis).toBeNull();
    expect(aff.duo).toBeNull();
  });

  it("never counts self as their own duo or nemesis", () => {
    const aff = topAffinities(
      [game(true, [["a", true], ["a", true], ["b", true]])],
      "a",
      1,
    );
    expect(aff.duo?.userId).toBe("b");
    expect(aff.nemesis).toBeNull();
  });

  it("counts a duplicated userId once per game", () => {
    const aff = topAffinities(
      [game(true, [["a", true], ["b", false], ["b", false]])],
      "a",
      1,
    );
    expect(aff.nemesis).toEqual({ userId: "b", games: 1, wins: 1, losses: 0 });
  });

  it("picks the most-met player first, whatever the record", () => {
    const aff = topAffinities(
      [
        game(true, [["a", true], ["b", false]]), // beat b
        game(true, [["a", true], ["b", false]]), // beat b again
        game(false, [["a", true], ["c", false]]), // lost to c once
      ],
      "a",
      1,
    );
    expect(aff.nemesis?.userId).toBe("b"); // met 2x beats lost-to-1x
  });

  it("breaks meeting-count ties toward the rival self loses to, the duo self wins with, then userId", () => {
    const tied = topAffinities(
      [
        game(true, [["a", true], ["b", false], ["z", true]]), // beat b, won with z
        game(false, [["a", true], ["c", false], ["y", true]]), // lost to c, lost with y
      ],
      "a",
      1,
    );
    expect(tied.nemesis?.userId).toBe("c"); // 1 game each; self 0-1 vs c beats 1-0 vs b
    expect(tied.duo?.userId).toBe("z"); // 1 game each; 1-0 with z beats 0-1 with y

    const dead = topAffinities(
      [game(true, [["a", true], ["m", false], ["k", false]])],
      "a",
      1,
    );
    expect(dead.nemesis?.userId).toBe("k"); // identical rows — userId decides
  });
});
