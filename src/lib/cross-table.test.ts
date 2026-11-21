import { describe, expect, it } from "vitest";
import { crossTable, type CrossMatch } from "./cross-table";

let seq = 0;
function m(over: Partial<CrossMatch>): CrossMatch {
  return {
    id: `m${++seq}`,
    week: 1,
    phase: "REGULAR",
    status: "COMPLETED",
    homeTeamId: "A",
    awayTeamId: "B",
    homeScore: 2,
    awayScore: 0,
    winnerTeamId: "A",
    ...over,
  };
}

describe("crossTable", () => {
  it("mirrors one meeting into both perspectives", () => {
    const t = crossTable(["A", "B"], [m({})]);
    expect(t.cells.get("A")!.get("B")).toEqual([
      { matchId: "m1", week: 1, played: true, live: false, unfinished: false, result: "W", score: "2–0", forfeit: false },
    ]);
    expect(t.cells.get("B")!.get("A")).toEqual([
      { matchId: "m1", week: 1, played: true, live: false, unfinished: false, result: "L", score: "0–2", forfeit: false },
    ]);
  });

  it("flags a mid-series LIVE match as live but not played, with its running score", () => {
    const t = crossTable(
      ["A", "B"],
      [m({ status: "LIVE", homeScore: 1, awayScore: 0, winnerTeamId: null })],
    );
    const cell = t.cells.get("A")!.get("B")![0];
    expect(cell.played).toBe(false);
    expect(cell.live).toBe(true);
    expect(cell.result).toBeNull();
    expect(cell.score).toBe("1–0");
    expect(t.cells.get("B")!.get("A")![0].score).toBe("0–1");
  });

  // US Season 2, 2026-11-20: two week-2 Bo2s sat at 1-0 for a week and the
  // grid still called them live (seriesStalled, schedule.ts).
  it("calls a series stopped partway unfinished, not live, given the time", () => {
    const now = Date.parse("2026-11-21T08:00:00Z");
    const stalled = m({
      status: "LIVE",
      homeScore: 1,
      awayScore: 0,
      winnerTeamId: null,
      scheduledAt: new Date("2026-11-14T22:00:00Z"),
    });
    const cell = crossTable(["A", "B"], [stalled], now).cells.get("A")!.get("B")![0];
    expect(cell).toMatchObject({ live: false, unfinished: true, played: false, score: "1–0" });
    expect(crossTable(["A", "B"], [stalled], now).cells.get("B")!.get("A")![0].score).toBe("0–1");
    // Within the window it is live; without a clock every LIVE series is.
    const fresh = { ...stalled, scheduledAt: new Date(now - 3600_000) };
    expect(crossTable(["A", "B"], [fresh], now).cells.get("A")!.get("B")![0]).toMatchObject({
      live: true,
      unfinished: false,
    });
    expect(crossTable(["A", "B"], [stalled]).cells.get("A")!.get("B")![0]).toMatchObject({
      live: true,
      unfinished: false,
    });
  });

  it("marks a ruled result as a forfeit for both sides", () => {
    const t = crossTable(
      ["A", "B"],
      [m({ forfeit: true, homeScore: 0, awayScore: 2, winnerTeamId: "B" })],
    );
    expect(t.cells.get("A")!.get("B")![0]).toMatchObject({ result: "L", forfeit: true });
    expect(t.cells.get("B")!.get("A")![0]).toMatchObject({ result: "W", forfeit: true });
  });

  it("marks drawn series D for both sides", () => {
    const t = crossTable(
      ["A", "B"],
      [m({ homeScore: 1, awayScore: 1, winnerTeamId: null })],
    );
    expect(t.cells.get("A")!.get("B")![0].result).toBe("D");
    expect(t.cells.get("B")!.get("A")![0].result).toBe("D");
  });

  it("leaves unplayed meetings result-null but keeps the week", () => {
    const t = crossTable(
      ["A", "B"],
      [m({ id: "m4", status: "SCHEDULED", week: 4, homeScore: 0, awayScore: 0, winnerTeamId: null })],
    );
    expect(t.cells.get("A")!.get("B")).toEqual([
      { matchId: "m4", week: 4, played: false, live: false, unfinished: false, result: null, score: null, forfeit: false },
    ]);
  });

  it("orders double meetings by week", () => {
    const t = crossTable(
      ["A", "B"],
      [
        m({ id: "later", week: 5, winnerTeamId: "B", homeScore: 0, awayScore: 2 }),
        m({ id: "earlier", week: 2 }),
      ],
    );
    expect(t.cells.get("A")!.get("B")!.map((c) => c.matchId)).toEqual([
      "earlier",
      "later",
    ]);
    expect(t.cells.get("A")!.get("B")!.map((c) => c.result)).toEqual(["W", "L"]);
  });

  it("ignores playoff matches and teams outside the field", () => {
    const t = crossTable(
      ["A", "B"],
      [
        m({ phase: "PLAYOFF" }),
        m({ homeTeamId: "A", awayTeamId: "ghost" }),
        m({ homeTeamId: "ghost", awayTeamId: "B" }),
      ],
    );
    expect(t.cells.get("A")!.get("B")).toEqual([]);
    expect(t.cells.get("B")!.get("A")).toEqual([]);
  });

  it("gives every ordered pair a cell and no self-cells", () => {
    const t = crossTable(["A", "B", "C"], []);
    expect([...t.cells.get("A")!.keys()].sort()).toEqual(["B", "C"]);
    expect(t.cells.get("B")!.has("B")).toBe(false);
    expect(t.teamIds).toEqual(["A", "B", "C"]);
  });
});
