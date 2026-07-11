import { describe, expect, it } from "vitest";
import {
  formatGameDuration,
  leagueRecords,
  type RecordGame,
  type RecordLine,
} from "./records";

function line(overrides: Partial<RecordLine>): RecordLine {
  return {
    userId: "u1",
    heroId: 1,
    kills: 5,
    deaths: 3,
    assists: 10,
    netWorth: 15000,
    gpm: 400,
    lastHits: 150,
    isRadiant: true,
    ...overrides,
  };
}

function game(overrides: Partial<RecordGame>): RecordGame {
  return {
    matchId: "m1",
    seasonId: "s1",
    radiantWin: true,
    durationSecs: 2400,
    radiantScore: 30,
    direScore: 20,
    lines: [],
    ...overrides,
  };
}

describe("leagueRecords", () => {
  it("returns empty books for no games", () => {
    const book = leagueRecords([]);
    expect(book.players).toEqual([]);
    expect(book.games).toEqual([]);
  });

  it("crowns the best line per player record with hero, match, and result", () => {
    const games: RecordGame[] = [
      game({
        matchId: "m1",
        lines: [
          line({ userId: "a", heroId: 8, kills: 12, isRadiant: true }),
          line({ userId: "b", heroId: 9, kills: 20, isRadiant: false }),
        ],
      }),
    ];
    const kills = leagueRecords(games).players.find((r) => r.key === "kills")!;
    expect(kills.value).toBe(20);
    expect(kills.userId).toBe("b");
    expect(kills.heroId).toBe(9);
    expect(kills.matchId).toBe("m1");
    expect(kills.won).toBe(false); // dire line in a radiant win
  });

  it("keeps the first achiever on ties (records are broken, not shared)", () => {
    const games: RecordGame[] = [
      game({ matchId: "m1", lines: [line({ userId: "a", kills: 15 })] }),
      game({ matchId: "m2", lines: [line({ userId: "b", kills: 15 })] }),
    ];
    const kills = leagueRecords(games).players.find((r) => r.key === "kills")!;
    expect(kills.userId).toBe("a");
    expect(kills.matchId).toBe("m1");
  });

  it("skips unmapped lines and null metrics", () => {
    const games: RecordGame[] = [
      game({
        lines: [
          line({ userId: null, kills: 99, netWorth: 99999 }),
          line({ userId: "a", kills: 3, netWorth: null, gpm: null, lastHits: null }),
        ],
      }),
    ];
    const book = leagueRecords(games);
    expect(book.players.find((r) => r.key === "kills")!.value).toBe(3);
    // Nobody qualified for the null metrics.
    expect(book.players.find((r) => r.key === "netWorth")).toBeUndefined();
    expect(book.players.find((r) => r.key === "gpm")).toBeUndefined();
  });

  it("tracks longest and fastest games, ignoring zero durations", () => {
    const games: RecordGame[] = [
      game({ matchId: "m1", durationSecs: 0 }), // unreported — never a record
      game({ matchId: "m2", durationSecs: 3600 }),
      game({ matchId: "m3", durationSecs: 900 }),
    ];
    const book = leagueRecords(games);
    expect(book.games.find((r) => r.key === "longest")!.matchId).toBe("m2");
    expect(book.games.find((r) => r.key === "shortest")!.matchId).toBe("m3");
  });

  it("computes bloodiest game and biggest stomp from kill scores", () => {
    const games: RecordGame[] = [
      game({ matchId: "m1", radiantScore: 40, direScore: 38 }), // 78 kills, diff 2
      game({ matchId: "m2", radiantScore: 5, direScore: 45 }), // 50 kills, diff 40
    ];
    const book = leagueRecords(games);
    const bloodiest = book.games.find((r) => r.key === "bloodiest")!;
    expect(bloodiest.matchId).toBe("m1");
    expect(bloodiest.value).toBe(78);
    const stomp = book.games.find((r) => r.key === "stomp")!;
    expect(stomp.matchId).toBe("m2");
    expect(stomp.value).toBe(40);
    expect(stomp.score).toBe("5–45");
  });

  it("never crowns kill-score records from unreported 0–0 games", () => {
    const games: RecordGame[] = [
      game({ matchId: "m1", radiantScore: 0, direScore: 0 }),
    ];
    const book = leagueRecords(games);
    expect(book.games.find((r) => r.key === "bloodiest")).toBeUndefined();
    expect(book.games.find((r) => r.key === "stomp")).toBeUndefined();
  });
});

describe("formatGameDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatGameDuration(2597)).toBe("43m 17s");
    expect(formatGameDuration(60)).toBe("1m 0s");
  });
});
