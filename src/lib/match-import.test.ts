import { describe, it, expect } from "vitest";
import {
  buildPlayers,
  claimsGame,
  classifyGame,
  pickSeriesGames,
  sanitizeBenchmarks,
} from "./match-import";
import type { OpenDotaMatch, OpenDotaPlayer } from "./dota";

function player(account_id: number, isRadiant: boolean): OpenDotaPlayer {
  return {
    account_id,
    player_slot: isRadiant ? 0 : 128,
    hero_id: 1,
    isRadiant,
    kills: 0,
    deaths: 0,
    assists: 0,
  };
}

function makeMatch(
  radiant: number[],
  dire: number[],
  radiant_win: boolean,
): OpenDotaMatch {
  return {
    match_id: 123,
    radiant_win,
    duration: 2000,
    start_time: 1,
    players: [
      ...radiant.map((a) => player(a, true)),
      ...dire.map((a) => player(a, false)),
    ],
  };
}

const teamA = { teamId: "A", accountIds: new Set([1, 2, 3, 4, 5]) };
const teamB = { teamId: "B", accountIds: new Set([6, 7, 8, 9, 10]) };

describe("classifyGame", () => {
  it("identifies sides and winner (A radiant, radiant wins)", () => {
    const c = classifyGame(makeMatch([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], true), teamA, teamB);
    expect(c.ok).toBe(true);
    expect(c.radiantTeamId).toBe("A");
    expect(c.direTeamId).toBe("B");
    expect(c.winnerTeamId).toBe("A");
  });

  it("assigns the win to dire when radiant_win is false", () => {
    const c = classifyGame(makeMatch([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], false), teamA, teamB);
    expect(c.winnerTeamId).toBe("B");
  });

  it("tolerates a couple of unknown accounts per side (standins/smurfs)", () => {
    const c = classifyGame(
      makeMatch([1, 2, 3, 999, 998], [6, 7, 8, 997, 996], true),
      teamA,
      teamB,
    );
    expect(c.ok).toBe(true);
    expect(c.winnerTeamId).toBe("A");
  });

  it("rejects a game missing one of the teams", () => {
    const c = classifyGame(
      makeMatch([1, 2, 3, 4, 5], [900, 901, 902, 903, 904], true),
      teamA,
      teamB,
    );
    expect(c.ok).toBe(false);
  });

  it("rejects when both teams are on the same side", () => {
    const c = classifyGame(
      makeMatch([1, 2, 3, 6, 7], [900, 901, 902, 903, 904], true),
      teamA,
      teamB,
    );
    expect(c.ok).toBe(false);
  });

  it("rejects when too few rostered players are present", () => {
    const c = classifyGame(
      makeMatch([1, 2, 900, 901, 902], [6, 7, 903, 904, 905], true),
      teamA,
      teamB,
    );
    expect(c.ok).toBe(false);
  });
});

describe("sanitizeBenchmarks", () => {
  it("keeps entries with a finite pct, clamped into 0..1", () => {
    const out = sanitizeBenchmarks({
      gold_per_min: { raw: 512, pct: 0.72 },
      xp_per_min: { raw: 600, pct: 1.4 },
      kills_per_min: { raw: 0.1, pct: -0.2 },
    });
    expect(out).toEqual({
      gold_per_min: { raw: 512, pct: 0.72 },
      xp_per_min: { raw: 600, pct: 1 },
      kills_per_min: { raw: 0.1, pct: 0 },
    });
  });

  it("drops entries with missing/null/NaN pct and nullifies bad raws", () => {
    const out = sanitizeBenchmarks({
      gold_per_min: { raw: 512 },
      xp_per_min: { raw: 600, pct: null },
      hero_damage_per_min: { raw: NaN, pct: 0.5 },
      tower_damage: { pct: NaN },
    });
    expect(out).toEqual({ hero_damage_per_min: { raw: null, pct: 0.5 } });
  });

  it("returns null for absent, non-object, or fully unusable benchmarks", () => {
    expect(sanitizeBenchmarks(undefined)).toBeNull();
    expect(sanitizeBenchmarks(null)).toBeNull();
    expect(sanitizeBenchmarks({ gold_per_min: { raw: 1 } })).toBeNull();
  });
});

describe("buildPlayers report-card fields", () => {
  it("passes the extended stats and benchmarks through onto stored lines", () => {
    const match = makeMatch([1], [6], true);
    match.players[0] = {
      ...match.players[0],
      xp_per_min: 610,
      denies: 12,
      level: 25,
      hero_damage: 24000,
      tower_damage: 5100,
      hero_healing: 0,
      benchmarks: { gold_per_min: { raw: 512, pct: 0.72 } },
    };
    const lines = buildPlayers(match, new Map());
    expect(lines[0]).toMatchObject({
      xpm: 610,
      denies: 12,
      level: 25,
      heroDamage: 24000,
      towerDamage: 5100,
      heroHealing: 0,
      benchmarks: { gold_per_min: { raw: 512, pct: 0.72 } },
    });
  });

  it("tolerates absent fields (legacy-shaped payloads) as nulls", () => {
    const lines = buildPlayers(makeMatch([1], [6], true), new Map());
    expect(lines[0]).toMatchObject({
      xpm: null,
      denies: null,
      level: null,
      heroDamage: null,
      towerDamage: null,
      heroHealing: null,
      benchmarks: null,
    });
  });
});

describe("pickSeriesGames", () => {
  const HOUR = 3600;
  // Games of one series, played back-to-back from a base time.
  const g = (id: number, hoursIn: number, winner: string | null) => ({
    id,
    startTime: 1_700_000_000 + Math.round(hoursIn * HOUR),
    winnerTeamId: winner,
  });

  it("takes the series in play order, not the most recent games", () => {
    // The bug this replaced: A won a Bo2 2-0, then the teams played one more
    // for fun that B won. Taking the newest 2 recorded games 2+3 as a 1-1 DRAW.
    const chosen = pickSeriesGames(
      [g(1, 0, "A"), g(2, 1, "A"), g(3, 2, "B")],
      2,
    );
    expect(chosen.map((c) => c.id)).toEqual([1, 2]);
  });

  it("stops at the clinch so a dead rubber never joins the record", () => {
    // Bo3 decided 2-0; the third game is exhibition and must not make it 2-1.
    const chosen = pickSeriesGames(
      [g(1, 0, "A"), g(2, 1, "A"), g(3, 2, "B")],
      3,
    );
    expect(chosen.map((c) => c.id)).toEqual([1, 2]);
  });

  it("keeps a full Bo3 that genuinely goes the distance", () => {
    const chosen = pickSeriesGames(
      [g(1, 0, "A"), g(2, 1, "B"), g(3, 2, "A")],
      3,
    );
    expect(chosen.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it("keeps both games of a drawn Bo2", () => {
    const chosen = pickSeriesGames([g(1, 0, "A"), g(2, 1, "B")], 2);
    expect(chosen.map((c) => c.id)).toEqual([1, 2]);
  });

  it("ignores an older session — a scrim days earlier isn't the series", () => {
    const chosen = pickSeriesGames(
      [g(9, -48, "B"), g(1, 0, "A"), g(2, 1, "A")],
      2,
    );
    expect(chosen.map((c) => c.id)).toEqual([1, 2]);
  });

  it("prefers the most recent session when both are the same size", () => {
    // Preserves the old behaviour's one good property: with nothing to
    // separate them on size, the night just played wins.
    const chosen = pickSeriesGames([g(9, -48, "B"), g(1, 0, "A")], 1);
    expect(chosen.map((c) => c.id)).toEqual([1]);
  });

  it("treats a >4h gap as a different session", () => {
    const chosen = pickSeriesGames(
      [g(1, 0, "A"), g(2, 1, "A"), g(3, 9, "B"), g(4, 10, "B")],
      2,
    );
    // Same size, so the later session wins — it is the night just played.
    expect(chosen.map((c) => c.id)).toEqual([3, 4]);
  });

  it("never returns more than bestOf, and handles an empty pool", () => {
    expect(pickSeriesGames([], 3)).toEqual([]);
    const many = [g(1, 0, null), g(2, 1, null), g(3, 2, null), g(4, 3, null)];
    expect(pickSeriesGames(many, 2)).toHaveLength(2);
  });

  it("does not clinch on games with no winner", () => {
    const chosen = pickSeriesGames([g(1, 0, null), g(2, 1, "A")], 2);
    expect(chosen.map((c) => c.id)).toEqual([1, 2]);
  });
});

describe("claimsGame", () => {
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const sunday = Date.UTC(2026, 8, 27, 18, 0); // a playoff kickoff

  it("claims a game played around its own kickoff", () => {
    expect(claimsGame(sunday + 2 * HOUR, sunday, [])).toBe(true);
  });

  it("refuses a game that belongs to another meeting between the same teams", () => {
    // The regression: A vs B played their rescheduled REGULAR match on
    // Saturday and nobody imported it. The playoff meeting is Sunday, and the
    // Saturday game sat inside its window — so the bracket advanced on a
    // regular-season result.
    const saturdayFixture = sunday - DAY;
    const gamePlayedSaturday = saturdayFixture + HOUR;
    expect(claimsGame(gamePlayedSaturday, sunday, [saturdayFixture])).toBe(
      false,
    );
    // …and that same game IS claimed by the fixture it actually belongs to.
    expect(claimsGame(gamePlayedSaturday, saturdayFixture, [sunday])).toBe(
      true,
    );
  });

  it("lets a team play early and still claim its own fixture", () => {
    // Two days early, but still nearer this kickoff than the other meeting.
    const other = sunday + 14 * DAY;
    expect(claimsGame(sunday - 2 * DAY, sunday, [other])).toBe(true);
  });

  it("refuses on an exact tie rather than guessing", () => {
    const a = sunday;
    const b = sunday + 4 * HOUR;
    const midpoint = sunday + 2 * HOUR;
    expect(claimsGame(midpoint, a, [b])).toBe(false);
  });

  it("checks against every other meeting, not just the nearest", () => {
    const earlier = sunday - 7 * DAY;
    const later = sunday + 30 * 60_000; // 30 min after this kickoff
    expect(claimsGame(sunday + 20 * 60_000, sunday, [earlier, later])).toBe(
      false,
    );
  });
});
