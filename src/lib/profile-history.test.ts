import { describe, expect, it } from "vitest";
import { groupBySeries, pickStandout, seriesOutcome } from "./profile-history";

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

describe("groupBySeries", () => {
  const g = (id: string, matchId: string, startTime: number) => ({
    id,
    matchId,
    startTime,
  });

  it("keeps the latest series first and plays each series in order", () => {
    // Newest first, the way the profile reads them.
    const groups = groupBySeries([
      g("m2-g2", "m2", 400),
      g("m2-g1", "m2", 300),
      g("m1-g2", "m1", 200),
      g("m1-g1", "m1", 100),
    ]);
    expect(groups.map((s) => s.matchId)).toEqual(["m2", "m1"]);
    expect(groups[0].games.map((x) => x.id)).toEqual(["m2-g1", "m2-g2"]);
  });

  it("puts a game with no start time last in its series", () => {
    const [series] = groupBySeries([
      g("known-2", "m1", 200),
      g("unknown", "m1", 0),
      g("known-1", "m1", 100),
    ]);
    expect(series.games.map((x) => x.id)).toEqual([
      "known-1",
      "known-2",
      "unknown",
    ]);
  });
});

describe("seriesOutcome", () => {
  const match = {
    status: "COMPLETED",
    winnerTeamId: "home" as string | null,
    homeTeamId: "home",
    awayTeamId: "away",
    homeScore: 2,
    awayScore: 1,
  };

  it("reads the series from the side the player played for", () => {
    expect(seriesOutcome(match, "home", [])).toEqual({
      result: "W",
      label: "Won 2–1",
    });
    expect(seriesOutcome(match, "away", [])).toEqual({
      result: "L",
      label: "Lost 1–2",
    });
    expect(
      seriesOutcome(
        { ...match, winnerTeamId: null, homeScore: 1, awayScore: 1 },
        "away",
        [],
      ),
    ).toEqual({ result: "D", label: "Drew 1–1" });
  });

  it("says a series is still being played, and names a forfeit ruling", () => {
    expect(
      seriesOutcome(
        { ...match, status: "LIVE", winnerTeamId: null, homeScore: 1, awayScore: 0 },
        "home",
        [],
      ),
    ).toEqual({ result: null, label: "In progress · 1–0" });
    expect(
      seriesOutcome({ ...match, forfeit: true, homeScore: 2, awayScore: 0 }, "home", []),
    ).toEqual({ result: "W", label: "Won 2–0 · forfeit" });
  });

  it("falls back to their own games when the line has no team", () => {
    expect(
      seriesOutcome(match, null, [{ won: true }, { won: true }, { won: false }]),
    ).toEqual({ result: "W", label: "2–1 in their games" });
  });
});
