import { describe, expect, it } from "vitest";
import { championFinalLine } from "./champion-moment";

const final = {
  homeTeamId: "a",
  awayTeamId: "b",
  homeScore: 1,
  awayScore: 2,
  winnerTeamId: "b",
  forfeit: false,
};

describe("championFinalLine", () => {
  it("reads the score from the champion's side, home or away", () => {
    expect(championFinalLine(final, "b")).toEqual({
      score: "2–1",
      opponentTeamId: "a",
      forfeit: false,
    });
    expect(
      championFinalLine(
        { ...final, homeScore: 3, awayScore: 0, winnerTeamId: "a" },
        "a",
      ),
    ).toEqual({ score: "3–0", opponentTeamId: "b", forfeit: false });
  });

  it("says when the final was a forfeit ruling", () => {
    expect(
      championFinalLine(
        { ...final, homeScore: 0, awayScore: 2, forfeit: true },
        "b",
      ),
    ).toEqual({ score: "2–0", opponentTeamId: "a", forfeit: true });
  });

  it("prints nothing without a final (a legacy archive)", () => {
    expect(championFinalLine(null, "b")).toBeNull();
    expect(championFinalLine(undefined, "b")).toBeNull();
  });

  it("prints nothing for a final this team didn't win or didn't play", () => {
    expect(championFinalLine(final, "a")).toBeNull();
    expect(championFinalLine({ ...final, winnerTeamId: null }, "b")).toBeNull();
    expect(
      championFinalLine({ ...final, winnerTeamId: "c" }, "c"),
    ).toBeNull();
  });
});
