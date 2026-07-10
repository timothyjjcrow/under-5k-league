import { describe, it, expect } from "vitest";
import { achievementsFor, gameMvp } from "./achievements";

describe("gameMvp", () => {
  it("crowns the best fantasy line, favoring winners via the win bonus", () => {
    const mvp = gameMvp(
      [
        // Winner: 8*3 + 2*1.5 - 1 + 10 = 36
        { userId: "w", isRadiant: true, kills: 8, deaths: 1, assists: 2 },
        // Loser with a bigger raw line: 10*3 + 0 - 2 = 28
        { userId: "l", isRadiant: false, kills: 10, deaths: 2, assists: 0 },
      ],
      true,
    );
    expect(mvp).toBe("w");
  });

  it("ignores anonymous lines and returns null when nobody is mapped", () => {
    expect(
      gameMvp([{ userId: null, isRadiant: true, kills: 20, deaths: 0, assists: 0 }], true),
    ).toBeNull();
  });

  it("breaks point ties by kills then deaths", () => {
    // Same points: 5 kills/0 deaths (15) vs 4 kills/+2 assists... construct equal:
    // a: 4k 2a 0d = 12+3 = 15 ; b: 5k 0a 0d = 15 → b wins on kills.
    const mvp = gameMvp(
      [
        { userId: "a", isRadiant: false, kills: 4, deaths: 0, assists: 2 },
        { userId: "b", isRadiant: false, kills: 5, deaths: 0, assists: 0 },
      ],
      true,
    );
    expect(mvp).toBe("b");
  });
});

describe("achievementsFor", () => {
  const line = (over: Partial<Parameters<typeof achievementsFor>[0][number]>) => ({
    kills: 0,
    deaths: 1,
    assists: 0,
    won: false,
    mvp: false,
    ...over,
  });

  it("counts per-game badges", () => {
    const badges = achievementsFor([
      line({ mvp: true, kills: 15, deaths: 0, gpm: 650 }), // wait deaths 0 + kills 15 → deathless too
      line({ mvp: true, kills: 3 }),
      line({ assists: 21 }),
    ]);
    const byKey = new Map(badges.map((b) => [b.key, b.count]));
    expect(byKey.get("mvp")).toBe(2);
    expect(byKey.get("spree")).toBe(1);
    expect(byKey.get("deathless")).toBe(1);
    expect(byKey.get("tycoon")).toBe(1);
    expect(byKey.get("playmaker")).toBe(1);
  });

  it("awards career milestones once", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      line({ kills: 9, deaths: 2, won: i % 2 === 0 }),
    );
    const byKey = new Map(achievementsFor(many).map((b) => [b.key, b.count]));
    expect(byKey.get("veteran")).toBe(1);
    expect(byKey.get("centurion")).toBe(1); // 12 × 9 = 108 kills
  });

  it("returns nothing for an empty or quiet career", () => {
    expect(achievementsFor([])).toEqual([]);
    expect(achievementsFor([line({ kills: 2 })])).toEqual([]);
  });
});
