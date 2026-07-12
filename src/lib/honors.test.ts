import { describe, it, expect } from "vitest";
import { weeklyHonors } from "./honors";

const teamOf = new Map([
  ["a1", "T1"],
  ["a2", "T1"],
  ["b1", "T2"],
  ["b2", "T2"],
]);

describe("weeklyHonors", () => {
  it("crowns the top scorer and the winningest team", () => {
    const honors = weeklyHonors(
      [
        {
          radiantWin: true,
          players: [
            // T1 radiant, wins: a1 pops off (30+10=40), a2 quiet (3+10=13)
            { userId: "a1", isRadiant: true, heroId: 8, kills: 10, deaths: 0, assists: 0 },
            { userId: "a2", isRadiant: true, heroId: 14, kills: 1, deaths: 0, assists: 0 },
            // T2 dire, loses: b1 decent but beaten (8*3-2=22)
            { userId: "b1", isRadiant: false, heroId: 11, kills: 8, deaths: 2, assists: 0 },
          ],
        },
      ],
      teamOf,
    );
    expect(honors.player).toEqual({ userId: "a1", points: 40, heroId: 8 });
    expect(honors.team).toMatchObject({ teamId: "T1", gameWins: 1 });
    expect(honors.team!.points).toBe(53);
  });

  it("breaks equal game wins by summed points", () => {
    const honors = weeklyHonors(
      [
        {
          radiantWin: true,
          players: [
            { userId: "a1", isRadiant: true, kills: 2, deaths: 0, assists: 0 },
          ],
        },
        {
          radiantWin: true,
          players: [
            { userId: "b1", isRadiant: true, kills: 9, deaths: 0, assists: 0 },
          ],
        },
      ],
      teamOf,
    );
    // Both teams won one game; T2's b1 scored more.
    expect(honors.team!.teamId).toBe("T2");
  });

  it("ignores anonymous stat lines and returns nulls with no games", () => {
    const empty = weeklyHonors([], teamOf);
    expect(empty).toEqual({ player: null, team: null });
    const anon = weeklyHonors(
      [
        {
          radiantWin: true,
          players: [
            { userId: null, isRadiant: true, kills: 20, deaths: 0, assists: 0 },
          ],
        },
      ],
      teamOf,
    );
    expect(anon.player).toBeNull();
  });
});

describe("weeklyHonors — roster churn", () => {
  it("credits the line's stored teamId over the live roster map", () => {
    // a1 played this week's game FOR T1 (stored teamId), but was since
    // released and signed to T2 (live map). The week's honors must not move.
    const honors = weeklyHonors(
      [
        {
          radiantWin: true,
          players: [
            {
              userId: "a1",
              isRadiant: true,
              heroId: 8,
              kills: 10,
              deaths: 0,
              assists: 0,
              teamId: "T1",
            },
            { userId: "b1", isRadiant: false, heroId: 11, kills: 2, deaths: 3, assists: 0, teamId: "T2" },
          ],
        },
      ],
      new Map([
        ["a1", "T2"], // live membership says T2 — must lose to the stored line
        ["b1", "T2"],
      ]),
    );
    expect(honors.team?.teamId).toBe("T1");
  });
});
