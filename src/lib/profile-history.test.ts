import { describe, expect, it } from "vitest";
import { pickStandout } from "./profile-history";

const line = (
  id: string,
  kills: number,
  deaths: number,
  assists: number,
  won: boolean,
  extra: { gpm?: number; netWorth?: number; lastHits?: number } = {},
) => ({ id, won, stat: { kills, deaths, assists, ...extra } });

describe("pickStandout", () => {
  it("picks the best performance by impact points, not the richest game", () => {
    const rich = line("witch-doctor", 8, 5, 5, true, {
      gpm: 554,
      netWorth: 26_100,
      lastHits: 210,
    });
    const support = line("shadow-shaman", 14, 2, 16, true, {
      gpm: 380,
      netWorth: 11_000,
      lastHits: 40,
    });
    expect(pickStandout([rich, support])?.id).toBe("shadow-shaman");
  });

  it("counts the win the way Match MVP does", () => {
    const lostBig = line("loss", 6, 3, 6, false);
    const wonSmall = line("win", 5, 3, 5, true);
    expect(pickStandout([lostBig, wonSmall])?.id).toBe("win");
  });

  it("breaks ties on kills, then deaths, then keeps the first (newest) row", () => {
    // 4 kills + 2 assists vs 2 kills + 4 assists, both at the bonus cap:
    // equal points.
    const capped = { gpm: 800 };
    expect(
      pickStandout([
        line("assists", 2, 1, 4, true, capped),
        line("kills", 4, 1, 2, true, capped),
      ])?.id,
    ).toBe("kills");
    expect(
      pickStandout([line("newer", 3, 1, 3, true), line("older", 3, 1, 3, true)])
        ?.id,
    ).toBe("newer");
  });

  it("returns null with no games", () => {
    expect(pickStandout([])).toBeNull();
  });
});
