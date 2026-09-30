import { describe, expect, it } from "vitest";
import {
  gameClock,
  ordinalPlace,
  taleOfTheTape,
  teamGameTotals,
  type TaleOfTheTapeInput,
  type TapeGame,
} from "./tale-of-the-tape";

let heroSeq = 1;
/**
 * A complete box score: five lines a side. `radiant` and `dire` give each
 * side's per-player kills/deaths/assists/gpm, repeated for all five.
 */
function game(opts: {
  radiantTeamId: string | null;
  direTeamId: string | null;
  radiantWin?: boolean;
  durationSecs?: number;
  radiant?: { k: number; d: number; a: number; gpm: number | null };
  dire?: { k: number; d: number; a: number; gpm: number | null };
}): TapeGame {
  const line = (
    isRadiant: boolean,
    s: { k: number; d: number; a: number; gpm: number | null },
    i: number,
  ) => ({
    heroId: heroSeq++,
    isRadiant,
    kills: s.k,
    deaths: s.d,
    assists: s.a,
    gpm: s.gpm,
    userId: `${isRadiant ? "r" : "d"}${i}-${heroSeq}`,
  });
  const r = opts.radiant ?? { k: 2, d: 1, a: 3, gpm: 400 };
  const d = opts.dire ?? { k: 1, d: 2, a: 2, gpm: 350 };
  return {
    radiantTeamId: opts.radiantTeamId,
    direTeamId: opts.direTeamId,
    radiantWin: opts.radiantWin ?? true,
    durationSecs: opts.durationSecs ?? 2100,
    players: JSON.stringify([
      ...[0, 1, 2, 3, 4].map((i) => line(true, r, i)),
      ...[0, 1, 2, 3, 4].map((i) => line(false, d, i)),
    ]),
  };
}

type Row = TaleOfTheTapeInput["matches"][number];
let matchSeq = 0;
function series(
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
  opts: Partial<Row> = {},
): Row {
  return {
    id: `m${matchSeq++}`,
    homeTeamId: home,
    awayTeamId: away,
    status: "COMPLETED",
    phase: "REGULAR",
    homeScore,
    awayScore,
    winnerTeamId:
      homeScore > awayScore ? home : awayScore > homeScore ? away : null,
    ...opts,
  };
}

const base: TaleOfTheTapeInput = {
  homeTeamId: "a",
  awayTeamId: "b",
  matches: [],
  games: [],
  mmrs: { home: [], away: [] },
  standing: { home: null, away: null },
  postseason: false,
};

describe("teamGameTotals", () => {
  it("adds up the team's own side of the map, whichever side it played", () => {
    const games = [
      game({ radiantTeamId: "a", direTeamId: "c", durationSecs: 1800 }),
      game({
        radiantTeamId: "c",
        direTeamId: "a",
        durationSecs: 2400,
        dire: { k: 4, d: 0, a: 1, gpm: 500 },
      }),
    ];
    expect(teamGameTotals("a", games)).toEqual({
      games: 2,
      // Radiant 5 × 2 kills, then Dire 5 × 4.
      kills: 10 + 20,
      deaths: 5 + 0,
      assists: 15 + 5,
      gpmSum: 400 + 500,
      gpmGames: 2,
      durationSecs: 4200,
      durationGames: 2,
    });
  });

  it("skips games whose sides aren't recorded or don't include the team", () => {
    const games = [
      game({ radiantTeamId: null, direTeamId: "a" }),
      game({ radiantTeamId: "a", direTeamId: "a" }),
      game({ radiantTeamId: "c", direTeamId: "d" }),
    ];
    expect(teamGameTotals("a", games).games).toBe(0);
  });

  it("skips a partial box score rather than count half a team", () => {
    const partial = game({ radiantTeamId: "a", direTeamId: "b" });
    const lines = JSON.parse(partial.players) as unknown[];
    expect(
      teamGameTotals("a", [
        { ...partial, players: JSON.stringify(lines.slice(0, 9)) },
      ]).games,
    ).toBe(0);
  });

  it("leaves GPM and length out of a game that doesn't have them", () => {
    const totals = teamGameTotals("a", [
      game({
        radiantTeamId: "a",
        direTeamId: "b",
        durationSecs: 0,
        radiant: { k: 1, d: 1, a: 1, gpm: null },
      }),
    ]);
    expect(totals).toMatchObject({
      games: 1,
      gpmGames: 0,
      durationGames: 0,
    });
  });
});

describe("taleOfTheTape", () => {
  it("has no rows before anything is known", () => {
    expect(taleOfTheTape(base)).toEqual([]);
  });

  it("compares the regular-season records by points, with the table place", () => {
    const rows = taleOfTheTape({
      ...base,
      matches: [
        series("a", "c", 2, 0),
        series("a", "d", 1, 1),
        series("b", "c", 0, 2),
        series("b", "d", 2, 1),
        series("a", "b", 0, 0, { status: "SCHEDULED", winnerTeamId: null }),
      ],
      standing: { home: "1st", away: "3rd" },
    });
    const record = rows.find((r) => r.key === "record");
    expect(record).toMatchObject({
      label: "Record",
      home: { text: "1W 1D 0L", sub: "1st", spoken: "1 won, 1 drawn, 0 lost" },
      away: { text: "1W 0D 1L", sub: "3rd", spoken: "1 won, 0 drawn, 1 lost" },
      edge: "home",
      bars: { home: 1, away: 3 / 4 },
    });
  });

  it("calls the record the regular season's in the playoffs, and counts only it", () => {
    const rows = taleOfTheTape({
      ...base,
      postseason: true,
      matches: [
        series("a", "c", 2, 0),
        series("b", "c", 2, 0),
        series("a", "d", 2, 0, { phase: "PLAYOFF", bracketSlot: "R0M0" }),
      ],
    });
    const record = rows.find((r) => r.key === "record");
    expect(record?.label).toBe("Regular season");
    expect(record?.home.text).toBe("1W 0D 0L");
    expect(record?.edge).toBeNull();
  });

  it("counts games won across every completed series, playoffs included", () => {
    const rows = taleOfTheTape({
      ...base,
      matches: [
        series("a", "c", 2, 1),
        series("c", "a", 0, 2, { phase: "PLAYOFF", bracketSlot: "R0M0" }),
        series("b", "c", 1, 2),
        series("b", "d", 0, 0, { status: "LIVE", winnerTeamId: null }),
      ],
    });
    expect(rows.find((r) => r.key === "games")).toMatchObject({
      home: { text: "4–1", sub: "80%", spoken: "4 won, 1 lost" },
      away: { text: "1–2", sub: "33%", spoken: "1 won, 2 lost" },
      edge: "home",
    });
  });

  it("drops the games row until both teams have played a game", () => {
    const rows = taleOfTheTape({
      ...base,
      matches: [
        series("a", "c", 2, 0),
        // This fixture: b hasn't played yet.
        series("a", "b", 0, 0, { status: "SCHEDULED", winnerTeamId: null }),
      ],
    });
    expect(rows.map((r) => r.key)).toEqual(["record"]);
  });

  it("averages known MMRs only, formatted with a fixed locale", () => {
    const rows = taleOfTheTape({
      ...base,
      mmrs: { home: [4200, 0, 3800], away: [3900, 4100] },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        key: "mmr",
        home: { text: "4,000", sub: null },
        away: { text: "4,000", sub: null },
        edge: null,
      }),
    ]);
  });

  it("reads kills, KDA and GPM from each team's games, and length neutrally", () => {
    const rows = taleOfTheTape({
      ...base,
      games: [
        game({
          radiantTeamId: "a",
          direTeamId: "b",
          durationSecs: 1800,
          radiant: { k: 3, d: 1, a: 4, gpm: 450 },
          dire: { k: 1, d: 3, a: 1, gpm: 330 },
        }),
        game({
          radiantTeamId: "b",
          direTeamId: "c",
          durationSecs: 2405,
          radiant: { k: 2, d: 2, a: 2, gpm: 390 },
        }),
      ],
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect([...byKey.keys()]).toEqual(["kills", "kda", "gpm", "length"]);
    // a: 15 kills in one game. b: 5 and 10 over two.
    expect(byKey.get("kills")).toMatchObject({
      home: { text: "15.0" },
      away: { text: "7.5" },
      edge: "home",
      bars: { home: 1, away: 0.5 },
    });
    // a: (15 + 20) / 5 = 7. b: (15 + 15) / (15 + 10) = 1.2.
    expect(byKey.get("kda")).toMatchObject({
      home: { text: "7.0" },
      away: { text: "1.2" },
      edge: "home",
    });
    expect(byKey.get("gpm")).toMatchObject({
      home: { text: "450" },
      away: { text: "360" },
      edge: "home",
    });
    expect(byKey.get("length")).toMatchObject({
      home: { text: "30:00" },
      // (1800 + 2405) / 2 = 2102.5 → 35:03.
      away: { text: "35:03" },
      edge: null,
      bars: null,
    });
  });

  it("shows no edge where the printed numbers are level", () => {
    const rows = taleOfTheTape({
      ...base,
      games: [
        game({
          radiantTeamId: "a",
          direTeamId: "b",
          radiant: { k: 2, d: 1, a: 1, gpm: 400.2 },
          dire: { k: 2, d: 1, a: 1, gpm: 399.9 },
        }),
      ],
    });
    for (const row of rows) expect(row.edge).toBeNull();
  });
});

describe("gameClock", () => {
  it("writes minutes and zero-padded seconds", () => {
    expect(gameClock(2047)).toBe("34:07");
    expect(gameClock(59.6)).toBe("1:00");
    expect(gameClock(3725)).toBe("62:05");
  });
});

describe("ordinalPlace", () => {
  it("uses st, nd, rd and the teens' th", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinalPlace)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "101st",
    ]);
  });
});
