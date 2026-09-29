import { describe, it, expect } from "vitest";
import { honorBestGame, weeklyHonors, type HonorsGame } from "./honors";

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
            // T1 radiant wins: a1 scores 20+8=28, a2 scores 2+8=10.
            {
              userId: "a1",
              isRadiant: true,
              heroId: 8,
              kills: 10,
              deaths: 0,
              assists: 0,
            },
            {
              userId: "a2",
              isRadiant: true,
              heroId: 14,
              kills: 1,
              deaths: 0,
              assists: 0,
            },
            // T2 dire loses: b1 scores 16-1.5=14.5.
            {
              userId: "b1",
              isRadiant: false,
              heroId: 11,
              kills: 8,
              deaths: 2,
              assists: 0,
            },
          ],
        },
      ],
      teamOf,
    );
    expect(honors.player).toEqual({ userId: "a1", points: 28, heroId: 8 });
    expect(honors.team).toMatchObject({ teamId: "T1", gameWins: 1 });
    expect(honors.team!.points).toBe(38);
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

  it("uses the winner's best single-game hero, not whichever row arrived last", () => {
    const games = [
      {
        radiantWin: true,
        players: [
          {
            userId: "a1",
            isRadiant: true,
            heroId: 9,
            kills: 10,
            deaths: 0,
            assists: 0,
          },
        ],
      },
      {
        radiantWin: true,
        players: [
          {
            userId: "a1",
            isRadiant: true,
            heroId: 2,
            kills: 1,
            deaths: 8,
            assists: 0,
          },
        ],
      },
    ];

    expect(weeklyHonors(games, teamOf).player?.heroId).toBe(9);
    expect(weeklyHonors([...games].reverse(), teamOf).player?.heroId).toBe(9);
  });

  it("resolves exact player and team ties by stable ids", () => {
    const games = [
      {
        radiantWin: true,
        players: [
          {
            userId: "b2",
            teamId: "T2",
            isRadiant: true,
            heroId: 9,
            kills: 3,
            deaths: 0,
            assists: 0,
          },
          {
            userId: "a2",
            teamId: "T1",
            isRadiant: true,
            heroId: 8,
            kills: 3,
            deaths: 0,
            assists: 0,
          },
        ],
      },
    ];

    const forward = weeklyHonors(games, teamOf);
    const reversed = weeklyHonors(
      [{ ...games[0], players: [...games[0].players].reverse() }],
      teamOf,
    );
    expect(forward.player?.userId).toBe("a2");
    expect(forward.team?.teamId).toBe("T1");
    expect(reversed).toEqual(forward);
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
            {
              userId: "b1",
              isRadiant: false,
              heroId: 11,
              kills: 2,
              deaths: 3,
              assists: 0,
              teamId: "T2",
            },
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

describe("honorBestGame", () => {
  const games: HonorsGame[] = [
    {
      radiantWin: true,
      players: [
        { userId: "a1", isRadiant: true, heroId: 9, kills: 12, deaths: 2, assists: 18 },
        { userId: "b1", isRadiant: false, heroId: 3, kills: 1, deaths: 9, assists: 2 },
      ],
    },
    {
      radiantWin: false,
      players: [
        { userId: "a1", isRadiant: true, heroId: 2, kills: 3, deaths: 7, assists: 4 },
        { userId: "b1", isRadiant: false, heroId: 5, kills: 4, deaths: 1, assists: 9 },
      ],
    },
  ];

  it("returns the hero and K/D/A of the player's best game", () => {
    expect(honorBestGame(games, "a1")).toEqual({
      heroId: 9,
      kills: 12,
      deaths: 2,
      assists: 18,
    });
    expect(honorBestGame([...games].reverse(), "a1")).toEqual(
      honorBestGame(games, "a1"),
    );
  });

  it("names the same hero as the Player of the Week", () => {
    const honors = weeklyHonors(games, teamOf);
    expect(honors.player?.userId).toBe("a1");
    expect(honorBestGame(games, "a1")?.heroId).toBe(honors.player?.heroId);
    // Equal points break to the lower hero id in both.
    const tied: HonorsGame[] = [
      { radiantWin: true, players: [{ userId: "a1", isRadiant: true, heroId: 7, kills: 5, deaths: 0, assists: 0 }] },
      { radiantWin: true, players: [{ userId: "a1", isRadiant: true, heroId: 4, kills: 5, deaths: 0, assists: 0 }] },
    ];
    expect(honorBestGame(tied, "a1")?.heroId).toBe(4);
    expect(weeklyHonors(tied, teamOf).player?.heroId).toBe(4);
  });

  it("is null for a player with no game line that names a hero", () => {
    expect(honorBestGame(games, "nobody")).toBeNull();
    expect(
      honorBestGame(
        [{ radiantWin: true, players: [{ userId: "a1", isRadiant: true, kills: 5, deaths: 0, assists: 0 }] }],
        "a1",
      ),
    ).toBeNull();
  });
});
