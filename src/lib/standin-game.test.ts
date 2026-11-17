import { describe, expect, it } from "vitest";
import { parseStandinGame, standinGameValue } from "./standin-game";

describe("standin game cookie value", () => {
  const game = { matchId: "cmatch0000000001", teamId: "cteam00000000001" };

  it("round-trips a game", () => {
    const value = standinGameValue(game);
    expect(value).toBe("cmatch0000000001.cteam00000000001");
    expect(parseStandinGame(value)).toEqual(game);
  });

  it("refuses anything that isn't two ids", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "cmatch0000000001",
      "a.b",
      "cmatch0000000001.cteam00000000001.extra",
      "cmatch0000000001.cteam0000; path=/",
      "../../etc/passwd.cteam00000000001",
    ]) {
      expect(parseStandinGame(raw), String(raw)).toBeNull();
    }
    expect(standinGameValue({ matchId: "m 1", teamId: "cteam00000000001" })).toBeNull();
  });
});
