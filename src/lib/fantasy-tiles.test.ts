import { describe, expect, it } from "vitest";
import { fantasyWindowTiles } from "./fantasy-tiles";

const base = {
  locked: false,
  poolSize: 30,
  cap: 17500,
  mine: null,
  leader: null,
  topPlayer: null,
  playersScored: 0,
};

describe("fantasyWindowTiles", () => {
  it("describes the pick window while picks are open", () => {
    expect(fantasyWindowTiles(base)).toEqual([
      { label: "Draft pool", value: "30", hint: "Players to choose from" },
      { label: "Salary cap", value: (17500).toLocaleString(), hint: "MMR across five players" },
    ]);
    expect(fantasyWindowTiles({ ...base, cap: 0 })[1]).toEqual({
      label: "Salary cap",
      value: "Open",
      hint: "No ratings available",
    });
  });

  // Once rosters lock nobody can choose anyone, so "Players to choose from"
  // and the salary cap described a window that had closed.
  it("never describes the pick window after the lock", () => {
    for (const cap of [0, 17500]) {
      const tiles = fantasyWindowTiles({ ...base, locked: true, cap });
      const text = JSON.stringify(tiles);
      expect(text).not.toMatch(/Draft pool|choose from|Salary cap|ratings/);
    }
  });

  it("reports the top player and the viewer's rank after the lock", () => {
    expect(
      fantasyWindowTiles({
        ...base,
        locked: true,
        mine: { rank: 3, points: 120 },
        leader: { name: "Rin", points: 200 },
        topPlayer: { name: "Axe", points: 143 },
        playersScored: 20,
      }),
    ).toEqual([
      { label: "Top player", value: "143", hint: "Axe's points" },
      { label: "Your rank", value: "#3", hint: "120 points" },
    ]);
  });

  it("shows the leader to someone without a five", () => {
    const [, second] = fantasyWindowTiles({
      ...base,
      locked: true,
      leader: { name: "Rin", points: 200 },
      topPlayer: { name: "Axe", points: 143 },
      playersScored: 20,
    });
    expect(second).toEqual({ label: "Leader", value: "200", hint: "Rin's points" });
  });

  it("falls back to counts when nobody entered or nothing is scored", () => {
    expect(
      fantasyWindowTiles({ ...base, locked: true, playersScored: 12, topPlayer: { name: "Axe", points: 40 } }),
    ).toEqual([
      { label: "Top player", value: "40", hint: "Axe's points" },
      { label: "Players scored", value: "12", hint: "Played in a scored game" },
    ]);
    // Locked by the first game before its box score counts: no leader yet.
    expect(
      fantasyWindowTiles({ ...base, locked: true, leader: { name: "Rin", points: 0 } }),
    ).toEqual([
      { label: "Top player", value: "—", hint: "No games scored yet" },
      { label: "Players scored", value: "0", hint: "Played in a scored game" },
    ]);
  });
});
