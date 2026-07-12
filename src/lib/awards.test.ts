import { describe, it, expect } from "vitest";
import { computeSeasonAwards, type AwardGame } from "./awards";

// Helper to build a game line.
function line(
  userId: string,
  heroId: number,
  isRadiant: boolean,
  kills: number,
  deaths: number,
  assists: number,
  gpm: number | null = 500,
): AwardGame["lines"][number] {
  return { userId, heroId, isRadiant, kills, deaths, assists, netWorth: null, gpm };
}

function game(
  matchId: string,
  radiantWin: boolean,
  radiantScore: number,
  direScore: number,
  lines: AwardGame["lines"],
): AwardGame {
  return { matchId, radiantWin, radiantScore, direScore, lines };
}

describe("computeSeasonAwards", () => {
  it("returns nothing with no games", () => {
    expect(computeSeasonAwards([])).toEqual([]);
  });

  it("awards MVP to the player with the most wins", () => {
    const games: AwardGame[] = [
      // alice (radiant) wins twice, bob (dire) loses twice
      game("m1", true, 30, 10, [line("alice", 1, true, 5, 2, 8), line("bob", 2, false, 3, 6, 4)]),
      game("m2", true, 25, 12, [line("alice", 1, true, 6, 1, 9), line("bob", 2, false, 2, 5, 3)]),
    ];
    const mvp = computeSeasonAwards(games).find((a) => a.key === "mvp");
    expect(mvp?.userId).toBe("alice");
    expect(mvp?.value).toBe("2 wins");
  });

  it("awards Kill Leader by total kills", () => {
    const games: AwardGame[] = [
      game("m1", true, 20, 10, [line("alice", 1, true, 10, 2, 3), line("bob", 2, false, 4, 8, 1)]),
      game("m2", false, 10, 20, [line("alice", 1, true, 12, 3, 2), line("bob", 2, false, 5, 4, 6)]),
    ];
    const kl = computeSeasonAwards(games).find((a) => a.key === "killLeader");
    expect(kl?.userId).toBe("alice");
    expect(kl?.value).toBe("22 kills");
  });

  it("picks the most-picked hero as Signature Hero", () => {
    const games: AwardGame[] = [
      game("m1", true, 20, 10, [line("alice", 7, true, 5, 2, 3), line("bob", 7, false, 4, 5, 2)]),
      game("m2", true, 20, 10, [line("alice", 7, true, 6, 1, 4), line("bob", 9, false, 3, 6, 1)]),
    ];
    const sig = computeSeasonAwards(games).find((a) => a.key === "signatureHero");
    expect(sig?.heroId).toBe(7); // hero 7 played 3x, hero 9 once
    expect(sig?.value).toBe("3 picks");
  });

  it("picks the most lopsided game as Biggest Stomp", () => {
    const games: AwardGame[] = [
      game("close", true, 30, 28, [line("a", 1, true, 5, 5, 5)]),
      game("stomp", true, 45, 8, [line("a", 1, true, 9, 1, 3)]),
    ];
    const stomp = computeSeasonAwards(games).find((a) => a.key === "biggestStomp");
    expect(stomp?.matchId).toBe("stomp");
    expect(stomp?.value).toBe("45–8");
    expect(stomp?.detail).toBe("+37 kills");
  });

  it("respects the min-games floor for rate awards", () => {
    // alice: 1 game with huge GPM; bob: 3 games with steady GPM.
    // With maxGames=3, minGames=3, only bob qualifies for Farm King.
    const games: AwardGame[] = [
      game("m1", true, 20, 10, [line("alice", 1, true, 5, 2, 3, 900), line("bob", 2, false, 4, 5, 2, 400)]),
      game("m2", true, 20, 10, [line("bob", 2, true, 4, 5, 2, 420)]),
      game("m3", true, 20, 10, [line("bob", 2, true, 4, 5, 2, 410)]),
    ];
    const farm = computeSeasonAwards(games).find((a) => a.key === "farmKing");
    expect(farm?.userId).toBe("bob");
  });
});

describe("computeSeasonAwards — data-quality edges", () => {
  it("Farm King qualifies on gpm-known games, not total games", () => {
    // "spiky" has 3 games but gpm in only 1 (700); "steady" has 3 recorded
    // 550s. The min-3-games rate must go to the player with 3 real samples.
    const games: AwardGame[] = [1, 2, 3].map((i) =>
      game(`m${i}`, true, 10, 5, [
        line("spiky", i, true, 2, 2, 2, i === 1 ? 700 : null),
        line("steady", i + 10, false, 2, 2, 2, 550),
      ]),
    );
    const farm = computeSeasonAwards(games).find((a) => a.key === "farmKing");
    expect(farm?.userId).toBe("steady");
    expect(farm?.detail).toBe("3 games");
  });

  it("counts unmapped lines for the hero tally but never for player awards", () => {
    const games: AwardGame[] = [
      game("m1", true, 10, 5, [
        line("a", 1, true, 30, 0, 0),
        // A ringer double-picks hero 99 across games — most-picked hero.
        { ...line("x", 99, false, 99, 0, 99), userId: null },
      ]),
      game("m2", true, 10, 5, [
        line("a", 2, true, 1, 0, 1),
        { ...line("x", 99, false, 99, 0, 99), userId: null },
      ]),
    ];
    const awards = computeSeasonAwards(games);
    const sig = awards.find((a) => a.key === "signatureHero");
    expect(sig?.heroId).toBe(99); // the ringer's picks still count as picks
    // ...but the ringer's 99-kill lines must never win a player award.
    for (const a of awards) {
      if (a.userId != null) expect(a.userId).toBe("a");
    }
    expect(awards.find((a) => a.key === "mvp")?.userId).toBe("a");
  });
});
