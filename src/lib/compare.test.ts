import { describe, expect, it } from "vitest";
import { meetings, type MeetingGame } from "./compare";

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
