import { describe, it, expect } from "vitest";
import { computeSeasonAwards, type AwardGame } from "./awards";
import { fantasyPoints } from "./fantasy";
import { PER_GAME_MIN_GAMES, summarizePlayerGames, topBy } from "./player-stats";

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

  it("awards MVP on points per game, not on the champion regular's win count", () => {
    // champ's side wins all four games; star's side loses all four but star
    // plays far better every night. The old most-wins MVP went to champ.
    const games: AwardGame[] = [1, 2, 3, 4].map((i) =>
      game(`m${i}`, true, 20, 10, [
        line("champ", 1, true, 2, 2, 5, 500), // 2*2 + 5*2 - 1.5 + 8 win + 4 economy = 24.5
        line("star", 2, false, 12, 2, 10, 600), // 24 + 20 - 1.5 + 6 economy = 48.5
      ]),
    );
    const mvp = computeSeasonAwards(games).find((a) => a.key === "mvp");
    expect(mvp?.userId).toBe("star");
    expect(mvp?.value).toBe("48.5 pts/game");
    expect(mvp?.detail).toBe("over 4 games");
    expect(mvp?.blurb).toContain("per game");
    expect(mvp?.blurb).toContain("Player of the Week");
    expect(mvp?.blurb).toContain("impact points");
    expect(mvp?.blurb).not.toMatch(/most wins/i);
  });

  it("scores the MVP with the exact Player of the Week line, extended stats included", () => {
    // Without heroHealing, healer's playmaking bonus is 4.5 (23.5 pts) and
    // carry's 24.5 would win; healing caps the bonus at 8 (27 pts). The award
    // must read the same optional fields fantasyPoints does.
    const healerLine = { ...line("healer", 1, false, 1, 4, 10, 250), heroHealing: 6000 };
    const carryLine = line("carry", 2, false, 5, 2, 6, 500);
    const games: AwardGame[] = [
      game("m1", true, 10, 20, [healerLine, carryLine]),
      game("m2", true, 10, 20, [healerLine, carryLine]),
    ];
    const mvp = computeSeasonAwards(games).find((a) => a.key === "mvp");
    expect(mvp?.userId).toBe("healer");
    expect(mvp?.value).toBe(`${fantasyPoints(healerLine, false).toFixed(1)} pts/game`);
    expect(mvp?.value).toBe("27.0 pts/game");
  });

  it("requires at least half the most games anyone played to be MVP", () => {
    // steady plays all 5 games → floor is ceil(5/2) = 3. threeGame (exactly
    // the floor) qualifies; twoGame's two monster games do not.
    const games: AwardGame[] = [1, 2, 3, 4, 5].map((i) =>
      game(`m${i}`, true, 20, 10, [
        line("steady", 1, true, 3, 4, 3, 400), // 6 + 6 - 3 + 8 + 2 = 19
        i <= 3
          ? line("threeGame", 2, false, 8, 2, 8, 500) // 16 + 16 - 1.5 + 4 = 34.5
          : line("twoGame", 3, false, 20, 0, 20, 800), // 80 + 8 capped bonus = 88
      ]),
    );
    const mvp = computeSeasonAwards(games).find((a) => a.key === "mvp");
    expect(mvp?.userId).toBe("threeGame");
    expect(mvp?.value).toBe("34.5 pts/game");
    expect(mvp?.detail).toBe("over 3 games");
    expect(mvp?.blurb).toContain("min 3 games");
  });

  it("uses a one-game floor when nobody has played more than one game", () => {
    const games: AwardGame[] = [
      game("m1", true, 20, 10, [
        line("solo", 1, true, 3, 4, 3, 400), // 19
        line("other", 2, false, 1, 5, 1, 300), // 2 + 2 - 3.75 + 0.45 = 0.7
      ]),
    ];
    const mvp = computeSeasonAwards(games).find((a) => a.key === "mvp");
    expect(mvp?.userId).toBe("solo");
    expect(mvp?.detail).toBe("over 1 game");
    expect(mvp?.blurb).toContain("min 1 game)");
  });

  it("breaks an exact points-per-game tie by more games, then by player id", () => {
    // Every line is worth 11.7 (2 + 2 - 0.75 + 8 + 0.45). In floats
    // (11.7 * 3) / 3 !== (11.7 * 2) / 2, so a float running sum would split
    // this tie by rounding noise; the award must see it as a real tie.
    const lineOf = (id: string) => line(id, 1, true, 1, 1, 1, null);
    const games: AwardGame[] = [
      game("m1", true, 20, 10, [lineOf("zed"), lineOf("bob"), lineOf("amy")]),
      game("m2", true, 20, 10, [lineOf("zed"), lineOf("bob"), lineOf("amy")]),
      game("m3", true, 20, 10, [lineOf("zed"), lineOf("bob")]),
    ];
    const mvp = computeSeasonAwards(games).find((a) => a.key === "mvp");
    // amy (2 games) has the lowest id but fewer games; bob beats zed on id.
    expect(mvp?.userId).toBe("bob");
    expect(mvp?.value).toBe("11.7 pts/game");
  });

  it("no longer hands out a games-played Workhorse award", () => {
    const games: AwardGame[] = [
      game("m1", true, 20, 10, [line("alice", 1, true, 5, 2, 8), line("bob", 2, false, 3, 6, 4)]),
      game("m2", true, 25, 12, [line("alice", 1, true, 6, 1, 9)]),
    ];
    const keys = computeSeasonAwards(games).map((a) => a.key);
    expect(keys).not.toContain("workhorse");
    expect(keys).toContain("mvp");
  });

  // /leaders ranks kills and assists PER GAME with a flat 3-game minimum; the
  // recap's awards must name the same players. On totals, "volume" (more
  // series played) won both.
  it("awards Kill Leader and Playmaker per game, not on season totals", () => {
    const games: AwardGame[] = [1, 2, 3, 4, 5].map((i) =>
      game(`m${i}`, true, 20, 10, [
        line("volume", 1, true, 8, 2, 8), // 5 games: 40 kills, 40 assists
        ...(i <= 3 ? [line("sharp", 2, false, 10, 2, 11)] : []), // 3 games: 30, 33
      ]),
    );
    const awards = computeSeasonAwards(games);
    const kl = awards.find((a) => a.key === "killLeader");
    expect(kl?.userId).toBe("sharp");
    expect(kl?.value).toBe("10.0 kills/game");
    expect(kl?.detail).toBe("30 kills in 3 games");
    expect(kl?.blurb).toBe("Most kills per game (min 3 games)");
    const pm = awards.find((a) => a.key === "playmaker");
    expect(pm?.userId).toBe("sharp");
    expect(pm?.value).toBe("11.0 assists/game");
    expect(pm?.detail).toBe("33 assists in 3 games");
  });

  it("needs 3 games for Kill Leader and Playmaker, however early in the season", () => {
    const twoGames: AwardGame[] = [1, 2].map((i) =>
      game(`m${i}`, true, 20, 10, [line("early", 1, true, 20, 1, 20)]),
    );
    const keys = computeSeasonAwards(twoGames).map((a) => a.key);
    expect(keys).not.toContain("killLeader");
    expect(keys).not.toContain("playmaker");
    // A 2-game monster can't outrank a qualified player either.
    const games: AwardGame[] = [1, 2, 3].map((i) =>
      game(`m${i}`, true, 20, 10, [
        line("steady", 1, true, 4, 2, 4),
        ...(i <= 2 ? [line("cameo", 2, false, 25, 0, 25)] : []),
      ]),
    );
    const awards = computeSeasonAwards(games);
    expect(awards.find((a) => a.key === "killLeader")?.userId).toBe("steady");
    expect(awards.find((a) => a.key === "playmaker")?.userId).toBe("steady");
  });

  it("names the same kills and assists leaders as the /leaders boards", () => {
    // A tie on the one-decimal average the boards show (10/3 and 13/4 both
    // read 3.3) goes to more games, as on the boards; a float comparison
    // would hand it to "ann".
    const kills: Record<string, number[]> = {
      ann: [3, 3, 4],
      ben: [3, 3, 3, 4],
      cat: [9, 1],
    };
    const games: AwardGame[] = [0, 1, 2, 3].map((i) =>
      game(
        `m${i}`,
        true,
        20,
        10,
        Object.entries(kills)
          .filter(([, perGame]) => i < perGame.length)
          .map(([id, perGame], slot) =>
            line(id, slot + 1, true, perGame[i], 2, perGame[i]),
          ),
      ),
    );
    const entries = Object.keys(kills).map((id) => ({
      id,
      summary: summarizePlayerGames(
        games.flatMap((g) =>
          g.lines
            .filter((l) => l.userId === id)
            .map((l) => ({ ...l, radiantWin: g.radiantWin })),
        ),
      ),
    }));
    const awards = computeSeasonAwards(games);
    for (const [key, board] of [
      ["killLeader", "killsPerGame"],
      ["playmaker", "assistsPerGame"],
    ] as const) {
      const [top] = topBy(entries, board, { minGames: PER_GAME_MIN_GAMES });
      expect(top.id).toBe("ben");
      expect(awards.find((a) => a.key === key)?.userId).toBe(top.id);
    }
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
